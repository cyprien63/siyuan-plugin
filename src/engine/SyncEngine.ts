// TLDR backend logic for the sync process
// defines & manages push & pull operation pipelines
// defines action callbacks to settings buttons from SettingsUI
/**
 * Core synchronization orchestrator.
 * Manages the complete push and pull pipelines, handling 3-way merges,
 * API orchestration, event emission for UI progress, and centralized error mapping.
 */
import { EventEmitter } from "events";
import { showMessage, Dialog } from "siyuan";
import { t, setLocale } from "../shared-utils/i18n";
import {
	SYNC_ROOT,
	MAX_FILE_BYTES,
	SKIP_ROOT_DIRS,
	SyncResult,
	SyncError,
	ManifestFile,
	MergePlan,
	GitPluginConfig,
	GitHubTreeItem,
	GitHubRef,
	CHUNK_SIZE,
	PLUGIN_MANIFEST_PATH,
	WIDGET_MANIFEST_PATH,
	THEME_MANIFEST_PATH,
	NOTEBOOK_MANIFEST_FILE,
	FileToSync,
	LOCKED_EXTENSIONS,
	SKIP_PATH_FRAGMENTS,
} from "../shared-utils/types";
import { SyncStateLedger } from "./SyncStateLedger";
import { GitHubAPI, GitHubError } from "../api/Github-api";
import { CryptoModule } from "./CryptoModule";
import {
	isManifestPath,
	calculateGitSha,
	arrayBufferToBase64,
	extractTextFromSyFile,
	generateCommitMessage,
	friendlyError,
	shouldSkipPath,
} from "../shared-utils/utils";
import {
	generatePluginManifest,
	generateWidgetManifest,
	generateThemeManifest,
	generateNotebookManifests,
	installMissingPlugins,
	installMissingWidgets,
	installMissingThemes,
	processNotebookManifests,
} from "./manifests";
import { SiYuanAPI } from "src/api/Siyuan-api";

export class SyncEngine extends EventEmitter {
	// Currently running operation ("push"/"pull"), or null when idle.
	// prevents conflicts between operations
	private activeTask: "push" | "pull" | null = null;

	// Pipeline state context
	private currentBranch: string = "main";
	private lastCommitSha: string | null = null;
	private remoteTreeCache: GitHubTreeItem[] = [];
	private treeItemsToCommit: GitHubTreeItem[] = [];
	private uploadedSummaries: { path: string; content: string }[] = [];

	constructor(
		private api: GitHubAPI,
		private crypto: CryptoModule,
		private ledger: SyncStateLedger,
		private config: GitPluginConfig,
		private siyuan: SiYuanAPI,
	) {
		super();
	}

	// --------------------------------------------
	// Main push/pull pipelines actions
	// --------------------------------------------

	// push action pipeline
	public async pushToGitHub(): Promise<SyncResult> {
		if (this.activeTask) throw new SyncError(409, t("action.push"));
		this.activeTask = "push";

		try {
			this.emit(
				"progress",
				5,
				t("progress.analysis"),
				"Checking repository state...",
			);
			// check if the remote repo is empty and initialize if so
			await this.seedEmptyRepoIfNeeded();

			this.emit(
				"progress",
				15,
				t("progress.analysis"),
				"Generating manifests...",
			);
			// Manifest generation
			const manifests = await this.generateAllManifests();

			this.emit("progress", 25, t("progress.analysis"), t("merge.compare"));
			// Merge planner
			const plan = await this.calculateMergePlan();

			// Short-circuit if no changes
			if (this.isPlanEmpty(plan)) {
				return this.finalizeEmptyPush(plan);
			}

			this.emit(
				"progress",
				40,
				t("merge.status"),
				"Uploading encrypted blobs...",
			);
			// Upload blobs, encrypt if necessary
			await this.uploadEncryptedBlobs(plan, manifests);

			this.emit(
				"progress",
				90,
				t("progress.finalizing"),
				t("progress.creating_tree"),
			);
			// finalize & check validity
			const result = await this.finalizeCommit(plan);

			return result;
		} catch (error) {
			throw this.formatApiError(error);
		} finally {
			this.activeTask = null;
			// clear context after push
			this.resetPipelineContext();
		}
	}

	// pull action pipeline
	public async pullFromGitHub(): Promise<SyncResult> {
		if (this.activeTask) throw new SyncError(409, t("action.pull"));
		this.activeTask = "pull";
		let stateUpdated = false;
		let deletedCount: number;

		try {
			this.emit(
				"progress",
				5,
				t("progress.analysis"),
				t("progress.reading_remote"),
			);

			// 1. Fetch remote state
			const isRepoValid = await this.fetchRemoteTree();
			if (!isRepoValid)
				return { status: "success", message: t("msg.repo_empty") };

			await this.verifyEncryptionPassword();

			// 2. Diff local vs remote to find missing/changed files
			this.emit(
				"progress",
				15,
				t("progress.analysis"),
				t("progress.pull_calculation"),
			);
			const { toPull, remotePlainSet } = await this.calculatePullPlan();

			// 3. Download and decrypt changed files concurrently
			if (toPull.length > 0) {
				stateUpdated =
					(await this.downloadAndWriteFiles(toPull)) || stateUpdated;
			}

			// 4. Restore marketplace packages and notebook metadata
			this.emit(
				"progress",
				75,
				t("progress.restore_environment"),
				t("progress.process_manifests"),
			);
			await this.installManifests();
			await this.restoreNotebooks();

			// 5. Cleanup local files that no longer exist on the remote
			this.emit(
				"progress",
				85,
				t("progress.cleanup"),
				t("progress.cleaning_local"),
			);
			deletedCount = await this.deleteStaleLocalFiles(remotePlainSet);
			if (deletedCount > 0) stateUpdated = true;

			// 6. Save ledger and signal SiYuan to refresh
			this.emit(
				"progress",
				95,
				t("progress.finalizing"),
				t("progress.update_state"),
			);
			return await this.finalizePull(stateUpdated, deletedCount, toPull.length);
		} catch (error) {
			throw this.formatApiError(error);
		} finally {
			this.activeTask = null;
			this.resetPipelineContext();
		}
	}

	// --------------------------------------------
	// Pipeline Helpers
	// --------------------------------------------

	// Push helpers

	private async seedEmptyRepoIfNeeded(): Promise<void> {
		const repoInfo = await (await this.api.getRepoInfo()).json();
		this.currentBranch = repoInfo.default_branch || "main";

		let refData;
		try {
			const refRes = await this.api.getRef(this.currentBranch);
			refData = await refRes.json();
		} catch (err) {
			if (
				err instanceof GitHubError &&
				(err.status === 409 || err.status === 404)
			) {
				console.warn(
					"[GitHub Sync] Repository has no commits, seeding an initial commit...",
				);
				await this.api.initEmptyRepo(this.currentBranch);
				const newRefRes = await this.api.getRef(this.currentBranch);
				refData = await newRefRes.json();
			} else {
				throw err;
			}
		}

		this.lastCommitSha = refData.object.sha;
		const lastCommit = await (
			await this.api.getCommit(this.lastCommitSha!)
		).json();
		this.remoteTreeCache = await this.api.getRemoteTree(lastCommit.tree.sha);

		await this.verifyEncryptionPassword();
	}

	private async verifyEncryptionPassword(): Promise<void> {
		// check if repo is encrypted
		const verifyNode = this.remoteTreeCache.find(
			(i: GitHubTreeItem) =>
				i.type === "blob" &&
				(i.path.endsWith(`/${NOTEBOOK_MANIFEST_FILE}`) ||
					i.path.includes("/enc/")),
		);

		// if encrypted, decrypt with password
		if (verifyNode) {
			const testBlob = await this.api.downloadBlob(verifyNode.sha);
			if (testBlob && this.crypto.isEncryptedBuffer(testBlob)) {
				try {
					await this.crypto.decrypt(testBlob);
				} catch (e) {
					throw new Error(t("error.bad_password"), { cause: e });
				}
			}
		}
	}

	private async generateAllManifests(): Promise<ManifestFile[]> {
		const pluginManifest = await generatePluginManifest(this.siyuan);
		const widgetManifest = await generateWidgetManifest(this.siyuan);
		const themeManifest = await generateThemeManifest(this.siyuan);
		const notebookManifests = await generateNotebookManifests(this.siyuan);

		return [
			pluginManifest,
			widgetManifest,
			themeManifest,
			...notebookManifests,
		];
	}

	private async calculateMergePlan(): Promise<MergePlan> {
		const localFiles = (
			await this.siyuan.collectDir(`/${SYNC_ROOT}`, SYNC_ROOT)
		).filter(
			(f) =>
				!isManifestPath(f.githubPath) &&
				!f.githubPath.endsWith(`/${NOTEBOOK_MANIFEST_FILE}`),
		);

		const remoteMap = new Map<string, string>();
		this.remoteTreeCache.forEach((item) => {
			if (item.type === "blob") {
				const orig = this.crypto.deobfuscateRemotePath(item.path);
				remoteMap.set(orig, item.sha);
			}
		});

		const plan = await this.mergeBeforePush(localFiles, remoteMap);

		// Process Pulls required before Push
		for (const pull of plan.toPull) {
			const pullSha = remoteMap.get(pull.githubPath);
			if (pullSha) {
				const remoteContent = await this.api.downloadBlob(pullSha);
				if (remoteContent) {
					const decrypted = await this.crypto.decrypt(remoteContent);
					const writeSuccess = await this.siyuan.putFile(
						pull.siYuanPath,
						decrypted,
					);

					if (writeSuccess) {
						plan.toReuse.push({ githubPath: pull.githubPath, sha: pullSha });
					} else {
						console.error(
							`[GitHub Sync] Pre-push pull rejected for: ${pull.siYuanPath}`,
						);
					}
				} else {
					console.error(
						`[GitHub Sync] Failed to download pre-push pull for: ${pull.githubPath}`,
					);
				}
			}
		}

		return plan;
	}

	// since we have encryption, we need to merge before a push operation
	// we're treating github as almost purely cloud storage, it's expected
	private async mergeBeforePush(
		localFiles: FileToSync[],
		remoteMap: Map<string, string>,
	): Promise<MergePlan> {
		await this.ledger.load();

		const plan: MergePlan = {
			toUpload: [],
			toReuse: [],
			toDelete: [],
			toPull: [],
			conflicted: [],
			skippedLarge: 0,
		};
		const localPathSet = new Set(localFiles.map((f) => f.githubPath));

		let processed = 0;
		const CHUNK_SIZE_MERGE = 50;

		for (let i = 0; i < localFiles.length; i += CHUNK_SIZE_MERGE) {
			const chunk = localFiles.slice(i, i + CHUNK_SIZE_MERGE);

			// concurrently check files
			await Promise.all(
				chunk.map(async (f) => {
					const content = await this.siyuan.getFile(f.siYuanPath);
					if (!content) {
						processed++;
						return;
					}

					// Fast-path: skip hashing if the file exceeds the maximum allowed size
					if (content.byteLength > MAX_FILE_BYTES) {
						plan.skippedLarge++;
						processed++;
						return;
					}

					const localSha = await calculateGitSha(content);
					const remoteSha = remoteMap.get(f.githubPath) || null;
					const localSynced = this.ledger.getLocalSha(f.githubPath);
					const remoteSynced = this.ledger.getRemoteSha(f.githubPath);

					if (localSha === remoteSha) {
						plan.toReuse.push({ githubPath: f.githubPath, sha: remoteSha! });
					} else if (!remoteSha || !localSynced) {
						plan.toUpload.push(f);
					} else if (localSha !== localSynced) {
						if (remoteSha !== remoteSynced) plan.conflicted.push(f);
						else plan.toUpload.push(f);
					} else if (remoteSha !== remoteSynced) {
						plan.toPull.push(f);
					} else {
						plan.toReuse.push({ githubPath: f.githubPath, sha: remoteSha });
					}

					processed++;
				}),
			);

			// Emit progress after each batch completes
			this.emit(
				"progress",
				25 + Math.round((processed / localFiles.length) * 15),
				t("progress.analysis"),
				chunk[chunk.length - 1].siYuanPath,
			);
		}

		for (const [path] of remoteMap) {
			if (
				path.startsWith(SYNC_ROOT) &&
				!localPathSet.has(path) &&
				!isManifestPath(path) &&
				!path.endsWith(`/${NOTEBOOK_MANIFEST_FILE}`)
			) {
				if (this.ledger.getLocalSha(path)) {
					plan.toDelete.push({ githubPath: path });
				} else {
					plan.toPull.push({ githubPath: path, siYuanPath: `/${path}` });
				}
			}
		}

		return plan;
	}

	private isPlanEmpty(plan: MergePlan): boolean {
		// Evaluate if core files or manifests changed to determine if commit is needed
		return (
			plan.toUpload.length === 0 &&
			plan.toDelete.length === 0 &&
			plan.conflicted.length === 0
		);
	}

	private async finalizeEmptyPush(plan: MergePlan): Promise<SyncResult> {
		for (const r of plan.toReuse) {
			// update all SHA locally
			this.ledger.updateFile(r.githubPath, r.sha, r.sha);
		}
		await this.ledger.save(this.lastCommitSha || "");

		// Signal the UI to close
		this.emit("progress", 100, t("ui.done"), t("msg.no_changes_none"));

		return { status: "success", message: t("msg.no_changes_none") };
	}

	private getTargetRemotePath(localPath: string): string {
		return isManifestPath(localPath)
			? localPath
			: this.crypto.obfuscateRemotePath(localPath);
	}

	private async uploadEncryptedBlobs(
		plan: MergePlan,
		manifests: ManifestFile[],
	): Promise<void> {
		const actualRemotePathSet = new Set(
			this.remoteTreeCache.map((i) => i.path),
		);

		// prepare treeItemsToCommit
		for (const r of plan.toReuse) {
			const remotePath = this.getTargetRemotePath(r.githubPath);
			this.treeItemsToCommit.push({
				path: remotePath,
				mode: "100644",
				type: "blob",
				sha: r.sha,
			});
		}

		for (let i = 0; i < plan.toUpload.length; i++) {
			const u = plan.toUpload[i];
			this.emit(
				"progress",
				40 + Math.round((i / plan.toUpload.length) * 40),
				`Upload : ${i + 1}/${plan.toUpload.length}`,
				u.githubPath,
			);

			const content = await this.siyuan.getFile(u.siYuanPath);
			if (!content) continue;

			const encrypted = await this.crypto.encrypt(content);
			const blobRes = await this.api.createBlob(arrayBufferToBase64(encrypted));

			if (blobRes.ok) {
				const blobData = await blobRes.json();
				const remotePath = this.getTargetRemotePath(u.githubPath);

				this.treeItemsToCommit.push({
					path: remotePath,
					mode: "100644",
					type: "blob",
					sha: blobData.sha,
				});
				this.uploadedSummaries.push({
					path: u.githubPath,
					content: extractTextFromSyFile(content),
				});

				this.ledger.updateFile(
					u.githubPath,
					await calculateGitSha(content),
					blobData.sha,
				);
			}
		}

		for (const d of plan.toDelete) {
			const remotePath = this.getTargetRemotePath(d.githubPath);
			if (actualRemotePathSet.has(remotePath)) {
				this.treeItemsToCommit.push({
					path: remotePath,
					mode: "100644",
					type: "blob",
					sha: null,
				});
				this.ledger.removeFile(d.githubPath);
			}
		}

		for (const m of manifests) {
			const content = m.githubPath.endsWith(NOTEBOOK_MANIFEST_FILE)
				? await this.crypto.encrypt(m.content)
				: m.content;
			const res = await this.api.createBlob(arrayBufferToBase64(content));
			if (res.status < 200 || res.status >= 300) {
				const data = await res.json();
				this.treeItemsToCommit.push({
					path: m.githubPath,
					mode: "100644",
					type: "blob",
					sha: data.sha,
				});
			}
		}
	}

	private async createTreeChunked(
		items: GitHubTreeItem[],
		baseTreeSha: string,
		progressLabel: string,
	): Promise<string> {
		let currentTreeSha = baseTreeSha;
		const total = items.length;

		if (total === 0) return currentTreeSha;

		for (let i = 0; i < total; i += CHUNK_SIZE) {
			const chunk = items.slice(i, i + CHUNK_SIZE);

			// Progress formatting for UI
			const percent = 80 + Math.round((i / total) * 30);
			this.emit("progress", percent, progressLabel, `${i}/${total}`);

			const treeRes = await this.api.createTree(currentTreeSha, chunk);
			if (!treeRes.ok) {
				throw new Error(`Tree creation failed: ${await treeRes.text()}`);
			}

			const treeData = await treeRes.json();
			currentTreeSha = treeData.sha;
		}

		this.emit("progress", 95, t("progress.finalizing"), `${total}/${total}`);
		return currentTreeSha;
	}

	private async finalizeCommit(plan: MergePlan): Promise<SyncResult> {
		const baseTreeRes = await this.api.getCommit(this.lastCommitSha!);
		const baseTreeData = await baseTreeRes.json();

		const treeMap = new Map<string, GitHubTreeItem>();
		for (const t of this.treeItemsToCommit) treeMap.set(t.path, t);
		const dedupedTreeItems = Array.from(treeMap.values());

		const newTreeSha = await this.createTreeChunked(
			dedupedTreeItems,
			baseTreeData.tree.sha,
			t("progress.creating_tree"),
		);

		const aiMsg = await generateCommitMessage(
			this.config.groqKey,
			this.uploadedSummaries,
		);
		const commitMsg =
			aiMsg ||
			`Sync : +${plan.toUpload.length}, ~${plan.toReuse.length}, -${plan.toDelete.length}, ↓${plan.toPull.length} pull(s)`;

		const commitRes = await this.api.createCommit(commitMsg, newTreeSha, [
			this.lastCommitSha!,
		]);
		if (!commitRes.ok) throw new Error("Commit failed");

		const commitData = await commitRes.json();
		await this.api.updateRef(this.currentBranch, commitData.sha);

		await this.ledger.save(commitData.sha);

		this.emit("progress", 100, t("ui.done"), t("msg.push_done_prefix"));

		return { status: "success", message: t("msg.push_done_prefix") };
	}

	private resetPipelineContext() {
		this.currentBranch = "main";
		this.lastCommitSha = null;
		this.remoteTreeCache = [];
		this.treeItemsToCommit = [];
		this.uploadedSummaries = [];
	}

	// Pull helpers

	// Load latest remote commit info, return true when successful
	private async fetchRemoteTree(): Promise<boolean> {
		// get latest commit
		const repoInfo = await (await this.api.getRepoInfo()).json();
		this.currentBranch = repoInfo.default_branch || "main";

		let refData: GitHubRef;
		try {
			const refRes = await this.api.getRef(this.currentBranch);
			refData = await refRes.json();
		} catch (err) {
			if (
				err instanceof GitHubError &&
				(err.status === 409 || err.status === 404)
			)
				return false;
			throw err;
		}

		this.lastCommitSha = refData.object.sha;
		const lastCommit = await (
			await this.api.getCommit(this.lastCommitSha!)
		).json();

		// Filter out top-level excluded directories immediately to reduce iteration load
		this.remoteTreeCache = (
			await this.api.getRemoteTree(lastCommit.tree.sha)
		).filter((i) => {
			if (i.type !== "blob") return false;

			if (i.path.startsWith(`${SYNC_ROOT}/`)) {
				const relPath = i.path.slice(SYNC_ROOT.length + 1);
				if (shouldSkipPath(relPath, SKIP_ROOT_DIRS)) return false;
			}

			return i.path.startsWith(SYNC_ROOT);
		});

		return true;
	}

	// get file states to figure out what to pull
	private async calculatePullPlan(): Promise<{
		toPull: { item: GitHubTreeItem; siPath: string; originalPath: string }[];
		remotePlainSet: Set<string>;
	}> {
		// get file states to figure out what to pull
		await this.ledger.load();
		const toPull: {
			item: GitHubTreeItem;
			siPath: string;
			originalPath: string;
		}[] = [];
		const remotePlainSet = new Set<string>();

		let processed = 0;
		const CHUNK_SIZE_PULL_CHECK = 50;

		// Process remote items in concurrent batches to avoid UI locking
		for (
			let i = 0;
			i < this.remoteTreeCache.length;
			i += CHUNK_SIZE_PULL_CHECK
		) {
			const chunk = this.remoteTreeCache.slice(i, i + CHUNK_SIZE_PULL_CHECK);

			await Promise.all(
				chunk.map(async (item) => {
					const originalPath = isManifestPath(item.path)
						? item.path
						: this.crypto.deobfuscateRemotePath(item.path);
					remotePlainSet.add(originalPath);

					const siPath = `/${originalPath}`;
					const lowerSiPath = siPath.toLowerCase();

					// Skip locked, volatile, or manifest files from regular file writes
					if (
						LOCKED_EXTENSIONS.some((ext) => lowerSiPath.endsWith(ext)) ||
						siPath.includes("/temp/") ||
						SKIP_PATH_FRAGMENTS.some((f) => siPath.includes(f)) ||
						siPath.endsWith(".siyuan.sy") ||
						isManifestPath(originalPath) ||
						originalPath.endsWith(`/${NOTEBOOK_MANIFEST_FILE}`)
					) {
						processed++;
						return;
					}

					const remoteSynced = this.ledger.getRemoteSha(originalPath);
					const localSynced = this.ledger.getLocalSha(originalPath);

					// Compare actual local content to prevent ghost conflicts if a local file was deleted
					const localContent = await this.siyuan.getFile(siPath);
					const localSha =
						localContent && localContent.byteLength > 0
							? await calculateGitSha(localContent)
							: "";

					if (remoteSynced !== item.sha || localSha !== localSynced) {
						toPull.push({ item, siPath, originalPath });
					}
					processed++;
				}),
			);

			this.emit(
				"progress",
				15 + Math.round((processed / this.remoteTreeCache.length) * 10),
				t("progress.analysis"),
				t("progress.checking_remote_files") +
					` ${processed}/${this.remoteTreeCache.length}`,
			);
		}

		return { toPull, remotePlainSet };
	}

	// download + write operations
	private async downloadAndWriteFiles(
		toPull: { item: GitHubTreeItem; siPath: string; originalPath: string }[],
	): Promise<boolean> {
		const CHUNK_SIZE_PULL = 5; // GitHub API rate limits prefer small concurrent batches for blob downloads
		let stateUpdated = false;

		for (let i = 0; i < toPull.length; i += CHUNK_SIZE_PULL) {
			const chunk = toPull.slice(i, i + CHUNK_SIZE_PULL);

			// Update progress per file
			this.emit(
				"progress",
				25 + Math.round((i / toPull.length) * 50),
				`Pull : ${i + chunk.length}/${toPull.length} files`,
				chunk
					.map((c) => c.originalPath)
					.join(", ")
					.slice(0, 50) + "...",
			);

			// concurrent file pulling through github API
			await Promise.all(
				chunk.map(async ({ item, siPath, originalPath }) => {
					const content = await this.api.downloadBlob(item.sha);
					if (content && content.byteLength > 0) {
						try {
							const decrypted = await this.crypto.decrypt(content);
							const writeSuccess = await this.siyuan.putFile(siPath, decrypted);

							if (writeSuccess) {
								console.debug(
									`[GitHub Sync] Wrote pulled file to workspace: ${siPath}`,
								);
								const ptSha = await calculateGitSha(decrypted);
								this.ledger.updateFile(originalPath, ptSha, item.sha);
								stateUpdated = true;
							} else {
								console.error(
									`[GitHub Sync] Backend rejected file write for: ${siPath}`,
								);
							}
						} catch (decryptErr) {
							console.error(`[DIAGNOSTIC] Failed to decrypt ${siPath}`);
							throw new Error(t("error.pull_verification_failed"), {
								cause: decryptErr,
							});
						}
					}
				}),
			);

			await new Promise((r) => setTimeout(r, 30)); // Small throttle to prevent network saturation
		}

		return stateUpdated;
	}

	// manifest syncing
	private async installManifests(): Promise<void> {
		const onProgress = (pct: number, status: string, details: string) =>
			this.emit("progress", pct, status, details);

		const manifestMap = [
			{ path: PLUGIN_MANIFEST_PATH, installer: installMissingPlugins },
			{ path: WIDGET_MANIFEST_PATH, installer: installMissingWidgets },
			{ path: THEME_MANIFEST_PATH, installer: installMissingThemes },
		];

		for (const { path, installer } of manifestMap) {
			const item = this.remoteTreeCache.find((i) => i.path === path);
			if (item) {
				const content = await this.api.downloadBlob(item.sha);
				if (content) {
					try {
						// Note: Core manifests are pushed as plaintext, so we bypass this.crypto.decrypt
						const text = new TextDecoder().decode(content);
						await installer(this.siyuan, JSON.parse(text), onProgress);
					} catch (err) {
						console.error(
							`[GitHub Sync] Failed to install manifest ${path}:`,
							err,
						);
					}
				}
			}
		}
	}

	private async restoreNotebooks(): Promise<void> {
		try {
			await processNotebookManifests(
				this.siyuan,
				this.remoteTreeCache,
				this.api,
				(buf) => this.crypto.decrypt(buf), // Notebook manifests are encrypted during push
				(pct, status, details) => this.emit("progress", pct, status, details),
			);
		} catch (err) {
			console.error("[GitHub Sync] Failed to process notebook manifests:", err);
		}
	}

	private async deleteStaleLocalFiles(
		remotePlainSet: Set<string>,
	): Promise<number> {
		let deletedCount = 0;
		// Iterate over keys directly from the internal ledger state
		const knownFiles = Object.keys(this.ledger.getState() || {});

		for (const localPath of knownFiles) {
			if (remotePlainSet.has(localPath)) continue;

			const lower = localPath.toLowerCase();
			if (
				LOCKED_EXTENSIONS.some((ext) => lower.endsWith(ext)) ||
				localPath.includes("/temp/") ||
				SKIP_PATH_FRAGMENTS.some((f) => localPath.includes(f)) ||
				localPath.endsWith(".siyuan.sy") ||
				localPath.endsWith(`/${NOTEBOOK_MANIFEST_FILE}`) ||
				localPath.startsWith(`${SYNC_ROOT}/plugins/`)
			) {
				continue;
			}

			this.emit("progress", 85, t("progress.cleanup"), localPath);
			if (await this.siyuan.removeFile(`/${localPath}`)) {
				this.ledger.removeFile(localPath);
				deletedCount++;
			}
		}

		return deletedCount;
	}

	private async finalizePull(
		stateUpdated: boolean,
		deletedCount: number,
		pulledCount: number,
	): Promise<SyncResult> {
		console.debug(
			`[GitHub Sync] finalizePull: stateUpdated=${stateUpdated}, deletedCount=${deletedCount}, pulledCount=${pulledCount}`,
		);

		if (stateUpdated) {
			console.debug(
				`[GitHub Sync] Saving ledger with commit: ${this.lastCommitSha}`,
			);
			await this.ledger.save(this.lastCommitSha!);
		}

		const message = t("msg.pull_done")
			.replace("{updated}", String(pulledCount))
			.replace("{deleted}", String(deletedCount))
			.replace("{skipped}", "0");

		// Signal the UI to close the progress dialog
		this.emit("progress", 100, t("ui.done"), message);

		if (deletedCount > 0 || stateUpdated) {
			console.debug(
				`[GitHub Sync] Refreshing filetree and scheduling reload...`,
			);

			await this.siyuan.refreshFiletree();
			await this.siyuan.rebuildDataIndex();

			setTimeout(() => window.location.reload(), 1500); // Reload SiYuan to rebuild indexes
		} else {
			console.debug(`[GitHub Sync] No changes required, skipping reload.`);
		}

		return {
			status: "success",
			message,
		};
	}

	// -------------------------------------------------------

	// Error Formatting
	private formatApiError(error: unknown): SyncError {
		// Pass through already-formatted SyncErrors
		if (error instanceof SyncError) return error;

		// Map GitHub API HTTP status codes to specific behaviors
		if (error instanceof GitHubError) {
			let localMessage = t("error.pull_verification_failed"); // Fallback

			switch (error.status) {
				case 401:
					localMessage = t("error.token_invalid");
					break;
				case 403:
				case 429:
					localMessage = t("error.rate_limit");
					break;
				case 404:
					localMessage = t("error.repo_not_found");
					break;
				case 409:
					localMessage = t("msg.repo_empty"); // Or a dedicated conflict key
					break;
				case 413:
					localMessage = t("error.file_too_large");
					break;
				case 422:
					// Git RPC 422 usually means tree validation failed (e.g., duplicated paths)
					localMessage = t("error.invalid_file") + " (Git Tree Validation)";
					break;
			}
			return new SyncError(error.status, localMessage, error);
		}

		// Fallback for network timeouts or JS runtime errors
		const fallbackMessage = friendlyError(error);
		return new SyncError(500, fallbackMessage, error);
	}

	// Action buttons operations
	public async testGitHubConnection(): Promise<void> {
		// Test the connection: create an API client from the current field values
		// and show an OK / Error toast accordingly.
		if (await this.api.testConnection()) showMessage(t("status.ok"));
		else showMessage(t("status.error"), 6000, "error");
	}

	public async exportConfig(cfg: GitPluginConfig): Promise<void> {
		const ok = confirm(t("msg.export_warning"));
		if (!ok) return;

		// serve saved json file

		// remove lastsync from cfg
		cfg.lastSync = undefined;

		const blob = new Blob([JSON.stringify(cfg, null, 2)], {
			type: "application/json",
		});
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = "github-sync-config.json";
		a.click();
		URL.revokeObjectURL(a.href);
		showMessage(t("msg.config_exported"));
	}

	public async importConfig(
		cfg: GitPluginConfig,
	): Promise<GitPluginConfig | void> {
		return new Promise<GitPluginConfig | void>((resolve) => {
			const fi = document.createElement("input");
			fi.type = "file";
			fi.accept = ".json";
			fi.onchange = async () => {
				const file = fi.files?.[0];
				if (!file) {
					resolve();
					return;
				}

				try {
					const text = await file.text();
					const data = JSON.parse(text);
					if (!data.username || !data.repo || !data.token) {
						showMessage("Invalid file", 6000, "error");
						resolve();
						return;
					}

					// import known fields in cfg
					for (const key of Object.keys(data)) {
						if (key in cfg) {
							(cfg as GitPluginConfig)[key] = data[key];
						}
					}

					if (data.language) {
						try {
							setLocale(data.language);
						} catch {
							console.error(
								"[GitHub Sync] Failed to set locale from imported config:",
								data.language,
							);
						}
					}
					showMessage(t("msg.config_loaded"));
					resolve(cfg);
				} catch {
					showMessage(t("error.invalid_file"), 6000, "error");
					resolve();
				}
			};
			fi.addEventListener("cancel", () => resolve(), { once: true });
			fi.click();
		});
	}

	/**
	 * Open the "reset repo" confirmation dialog.
	 *
	 * Refuses to run while another task is active.
	 */
	public async resetRepoDialog(dialog: Dialog): Promise<void> {
		if (this.activeTask) {
			showMessage(t("action.push"), 4000, "error");
			return;
		}

		const confirmBtn = dialog.element.querySelector(
			"#remove-encryption-confirm",
		) as HTMLButtonElement;
		const cancelBtn = dialog.element.querySelector(
			"#remove-encryption-cancel",
		) as HTMLButtonElement;

		const onConfirm = async () => {
			if (confirmBtn) confirmBtn.disabled = true;
			if (cancelBtn) cancelBtn.disabled = true;

			// fire the reset operation and handle errors
			try {
				await this.resetRepo();
				dialog.destroy();
			} catch (e) {
				const error = this.formatApiError(e);
				showMessage(error.message, 8000, "error");
				if (confirmBtn) confirmBtn.disabled = false;
				if (cancelBtn) cancelBtn.disabled = false;
			}
		};

		confirmBtn?.addEventListener("click", onConfirm);
		cancelBtn?.addEventListener("click", () => dialog.destroy());
	}

	/**
	 * Perform the repo reset operation.
	 *
	 * the whole repository is cleared anew,
	 * then warns user about changing the config as desired.
	 */
	private async resetRepo(): Promise<void> {
		this.activeTask = "push";
		this.emit(
			"progress",
			0,
			t("progress.removing_encryption"),
			t("progress.reading_remote"),
		);

		try {
			// get branch & repo info
			const repoInfo = await (await this.api.getRepoInfo()).json();
			const branch = repoInfo.default_branch || "main";

			// If the repository is completely empty, just clear the local setting
			let refData: GitHubRef;
			try {
				const refRes = await this.api.getRef(branch);
				refData = await refRes.json();
			} catch (err) {
				if (
					err instanceof GitHubError &&
					(err.status === 409 || err.status === 404)
				) {
					showMessage(t("msg.repo_empty"), 8000);
					return;
				}
				throw err;
			}

			const lastCommitSha = refData.object.sha;
			const lastCommitRes = await this.api.getCommit(lastCommitSha);
			const lastCommit = await lastCommitRes.json();
			const remoteTree = await this.api.getRemoteTree(lastCommit.tree.sha);

			const treeItems: GitHubTreeItem[] = [];

			// 1. Preserve the .github directory to prevent workflow scope blocks
			const githubDir = remoteTree.find((i) => i.path === ".github");
			if (githubDir) {
				treeItems.push({
					path: ".github",
					mode: githubDir.mode,
					type: githubDir.type,
					sha: githubDir.sha,
				});
			}

			// 2. Create a placeholder file so the new tree is never empty
			const blobRes = await this.api.createBlob(
				btoa("Repository reset by siyuan-github-sync."),
			);
			if (!blobRes.ok) throw new Error("Failed to create init blob");
			const blobData = await blobRes.json();

			treeItems.push({
				path: "_siyuan-github-sync-init",
				mode: "100644",
				type: "blob",
				sha: blobData.sha,
			});

			this.emit(
				"progress",
				50,
				t("progress.removing_encryption"),
				t("progress.creating_tree"),
			);

			// 3. Create a brand new root tree (Passing "" skips base_tree injection)
			const treeRes = await this.api.createTree("", treeItems);

			if (!treeRes.ok) {
				throw new Error(`Tree creation failed: ${await treeRes.text()}`);
			}
			const treeData = await treeRes.json();

			// 4. Commit the new clean tree
			const commitRes = await this.api.createCommit(
				"chore: reset repository (delete all files)",
				treeData.sha,
				[lastCommitSha],
			);

			if (!commitRes.ok) {
				throw new Error(`Commit failed: ${await commitRes.text()}`);
			}

			const commitData = await commitRes.json();
			const updateRes = await this.api.updateRef(branch, commitData.sha);

			if (!updateRes.ok) {
				throw new Error(`Ref update failed: ${await updateRes.text()}`);
			}

			// Clear the local state ledger and map it to the new empty commit
			await this.ledger.save(commitData.sha);

			// fire message about repo being cleared
			showMessage(t("msg.repo_cleared"), 8000);
		} catch (e) {
			throw this.formatApiError(e);
		} finally {
			this.activeTask = null;
		}
	}
}
