// backend logic for the sync engine
// defines & manages push & pull operation pipelines

import { EventEmitter } from "events";
import { showMessage, Dialog } from "siyuan";
import { t, setLocale } from "./i18n";
import {
	SYNC_ROOT,
	MAX_FILE_BYTES,
	SyncResult,
	SyncError,
	ManifestFile,
	MergePlan,
	GitPluginConfig,
	GitHubTreeItem,
	CHUNK_SIZE,
	PLUGIN_MANIFEST_PATH,
	WIDGET_MANIFEST_PATH,
	THEME_MANIFEST_PATH,
	NOTEBOOK_MANIFEST_FILE,
	FileToSync,
} from "./types";
import { SyncStateLedger } from "./SyncStateLedger";
import { GitHubAPI } from "./github-api";
import { CryptoModule, isEncryptedBuffer } from "./crypto";
import {
	isManifestPath,
	calculateGitSha,
	arrayBufferToBase64,
	extractTextFromSyFile,
	generateCommitMessage,
	createGitTreeChunked,
} from "./utils";
import { siYuanGetFile, collectDir, siYuanPutFile } from "./siyuan-api";
import {
	generatePluginManifest,
	generateWidgetManifest,
	generateThemeManifest,
	generateNotebookManifests,
} from "./manifests";

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

			// 2. Diff local vs remote to find missing/changed files
			this.emit(
				"progress",
				15,
				t("progress.analysis"),
				"Calculating pull plan...",
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
				"Restoring environment",
				"Processing manifests...",
			);
			await this.installManifests();
			await this.restoreNotebooks();

			// 5. Cleanup local files that no longer exist on the remote
			this.emit("progress", 85, "Cleaning up", "Deleting stale local files...");
			deletedCount = await this.deleteStaleLocalFiles(remotePlainSet);
			if (deletedCount > 0) stateUpdated = true;

			// 6. Save ledger and signal SiYuan to refresh
			this.emit("progress", 95, t("progress.finalizing"), "Updating state...");
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
		// get repo info
		const repoInfo = await (await this.api.getRepoInfo()).json();
		this.currentBranch = repoInfo.default_branch || "main";

		let refRes = await this.api.getRef(this.currentBranch);

		// initiate repo if empty
		if (!refRes.ok) {
			console.warn(
				"[GitHub Sync] Repository has no commits, seeding an initial commit...",
			);
			const initRes = await this.api.initEmptyRepo(this.currentBranch);
			if (!initRes.ok) throw new Error("Failed to seed empty repository");
			refRes = await this.api.getRef(this.currentBranch);
		}

		// get last commit & tree
		const refData = await refRes.json();
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
			if (testBlob && isEncryptedBuffer(testBlob)) {
				try {
					await this.crypto.decrypt(testBlob);
				} catch (e) {
					throw new Error(t("error.bad_password"), { cause: e });
				}
			}
		}
	}

	private async generateAllManifests(): Promise<ManifestFile[]> {
		const pluginManifest = await generatePluginManifest();
		const widgetManifest = await generateWidgetManifest();
		const themeManifest = await generateThemeManifest();
		const notebookManifests = await generateNotebookManifests();

		return [
			pluginManifest,
			widgetManifest,
			themeManifest,
			...notebookManifests,
		];
	}

	private async calculateMergePlan(): Promise<MergePlan> {
		const localFiles = (await collectDir(`/${SYNC_ROOT}`, SYNC_ROOT)).filter(
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
					await siYuanPutFile(pull.siYuanPath, decrypted);
				}
				plan.toReuse.push({ githubPath: pull.githubPath, sha: pullSha });
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
					const content = await siYuanGetFile(f.siYuanPath);
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
		return { status: "success", message: t("msg.no_changes_none") };
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
			const remotePath = isManifestPath(r.githubPath)
				? r.githubPath
				: this.crypto.obfuscateRemotePath(r.githubPath);
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

			const content = await siYuanGetFile(u.siYuanPath);
			if (!content) continue;

			const encrypted = await this.crypto.encrypt(content);
			const blobRes = await this.api.createBlob(arrayBufferToBase64(encrypted));

			if (blobRes.ok) {
				const blobData = await blobRes.json();
				const remotePath = isManifestPath(u.githubPath)
					? u.githubPath
					: this.crypto.obfuscateRemotePath(u.githubPath);

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
			const remotePath = isManifestPath(d.githubPath)
				? d.githubPath
				: this.crypto.obfuscateRemotePath(d.githubPath);
			if (actualRemotePathSet.has(remotePath)) {
				this.treeItemsToCommit.push({
					path: remotePath,
					mode: "100644",
					type: "blob",
					sha: null as any,
				});
				this.ledger.removeFile(d.githubPath);
			}
		}

		for (const m of manifests) {
			const content = m.githubPath.endsWith(NOTEBOOK_MANIFEST_FILE)
				? await this.crypto.encrypt(m.content)
				: m.content;
			const res = await this.api.createBlob(arrayBufferToBase64(content));
			if (res.ok) {
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

	private async finalizeCommit(plan: MergePlan): Promise<SyncResult> {
		const baseTreeRes = await this.api.getCommit(this.lastCommitSha!);
		const baseTreeData = await baseTreeRes.json();

		const treeMap = new Map<string, GitHubTreeItem>();
		for (const t of this.treeItemsToCommit) treeMap.set(t.path, t);
		const dedupedTreeItems = Array.from(treeMap.values());

		const newTreeSha = await createGitTreeChunked(
			this.api,
			dedupedTreeItems,
			baseTreeData.tree.sha,
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

	// TODO review these functions
	private async fetchRemoteTree(): Promise<boolean> {
		const repoInfo = await (await this.api.getRepoInfo()).json();
		this.currentBranch = repoInfo.default_branch || "main";

		const refRes = await this.api.getRef(this.currentBranch);
		if (!refRes.ok) return false; // Repository is empty

		const refData = await refRes.json();
		this.lastCommitSha = refData.object.sha;

		const lastCommit = await (
			await this.api.getCommit(this.lastCommitSha!)
		).json();

		// Filter out top-level excluded directories immediately to reduce iteration load
		this.remoteTreeCache = (
			await this.api.getRemoteTree(lastCommit.tree.sha)
		).filter((i) => {
			if (i.type !== "blob") return false;
			const p = i.path;
			if (p.startsWith("data/")) {
				const firstSegment = p.slice(5).split("/")[0];
				if (SKIP_ROOT_DIRS.includes(firstSegment)) return false;
			}
			return p.startsWith(SYNC_ROOT);
		});

		return true;
	}

	private async calculatePullPlan(): Promise<{
		toPull: { item: GitHubTreeItem; siPath: string; originalPath: string }[];
		remotePlainSet: Set<string>;
	}> {
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
						isManifestPath(originalPath)
					) {
						processed++;
						return;
					}

					const remoteSynced = this.ledger.getRemoteSha(originalPath);

					// Compare actual local content to prevent ghost conflicts if a local file was deleted
					const localContent = await siYuanGetFile(siPath);
					const localSha =
						localContent && localContent.byteLength > 0
							? await calculateGitSha(localContent)
							: "";

					if (remoteSynced !== item.sha || localSha !== item.sha) {
						toPull.push({ item, siPath, originalPath });
					}
					processed++;
				}),
			);

			this.emit(
				"progress",
				15 + Math.round((processed / this.remoteTreeCache.length) * 10),
				t("progress.analysis"),
				`Checking ${processed}/${this.remoteTreeCache.length} remote files`,
			);
		}

		return { toPull, remotePlainSet };
	}

	private async downloadAndWriteFiles(
		toPull: { item: GitHubTreeItem; siPath: string; originalPath: string }[],
	): Promise<boolean> {
		const CHUNK_SIZE_PULL = 5; // GitHub API rate limits prefer small concurrent batches for blob downloads
		let stateUpdated = false;

		for (let i = 0; i < toPull.length; i += CHUNK_SIZE_PULL) {
			const chunk = toPull.slice(i, i + CHUNK_SIZE_PULL);

			this.emit(
				"progress",
				25 + Math.round((i / toPull.length) * 50),
				`Pull : ${i + chunk.length}/${toPull.length} files`,
				chunk
					.map((c) => c.originalPath)
					.join(", ")
					.slice(0, 50) + "...",
			);

			await Promise.all(
				chunk.map(async ({ item, siPath, originalPath }) => {
					const content = await this.api.downloadBlob(item.sha);
					if (content && content.byteLength > 0) {
						try {
							const decrypted = await this.crypto.decrypt(content);
							await siYuanPutFile(siPath, decrypted);

							const ptSha = await calculateGitSha(decrypted);
							this.ledger.updateFile(originalPath, ptSha, item.sha);
							stateUpdated = true;
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
						await installer(JSON.parse(text), onProgress);
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
		const knownFiles = Object.keys((this.ledger as any).state || {});

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

			this.emit("progress", 85, `Pull : delete`, localPath);
			if (await siYuanRemoveFile(`/${localPath}`)) {
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
		if (stateUpdated) {
			await this.ledger.save(this.lastCommitSha!);
		}

		if (deletedCount > 0 || stateUpdated) {
			await siYuanRefreshFiletree();
			setTimeout(() => window.location.reload(), 1500); // Reload SiYuan to rebuild indexes
		}

		return {
			status: "success",
			message: t("msg.pull_done")
				.replace("{updated}", String(pulledCount))
				.replace("{deleted}", String(deletedCount))
				.replace("{skipped}", "0"),
		};
	}

	// Error Formatting
	private formatApiError(error: Error): SyncError {
		return new SyncError(500, error.message || "Unknown synchronization error");
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
		const fi = document.createElement("input");
		fi.type = "file";
		fi.accept = ".json";
		fi.onchange = async () => {
			const file = fi.files?.[0];
			if (!file) return;
			try {
				const text = await file.text();
				const data = JSON.parse(text);
				if (!data.username || !data.repo || !data.token) {
					showMessage("Invalid file", 6000, "error");
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
				return cfg;
			} catch {
				showMessage(t("error.invalid_file"), 6000, "error");
				return;
			}
		};
		fi.click();
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
				showMessage(t("msg.encryption_removed"), 8000);
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
			const refRes = await this.api.getRef(branch);

			// If the repository is completely empty, just clear the local setting
			if (!refRes.ok) {
				// fire message about repo being already empty
				showMessage(t("msg.repo_empty"), 8000);
				return;
			}

			const refData = await refRes.json();
			const lastCommitSha = refData.object.sha;
			const lastCommitRes = await this.api.getCommit(lastCommitSha);
			const lastCommit = await lastCommitRes.json();
			const remoteTree = await this.api.getRemoteTree(lastCommit.tree.sha);

			const treeItems: GitHubTreeItem[] = [];

			// remove all files from repo
			for (const item of remoteTree) {
				if (item.type === "blob") {
					treeItems.push({
						path: item.path,
						mode: "100644",
						type: "blob",
						// GitHub's API requires sha to be explicitly null to mark a file for deletion
						sha: null as unknown as string,
					});
				}
			}
			const total = treeItems.length;

			if (total > 0) {
				let currentTreeSha = lastCommit.tree.sha;

				// Chunk the tree creation to respect GitHub's API limits on large repositories
				for (let i = 0; i < total; i += CHUNK_SIZE) {
					const chunk = treeItems.slice(i, i + CHUNK_SIZE);

					// Update the progress indicator with the amount of files processed vs total
					const percent = 50 + Math.round((i / total) * 30);
					this.emit(
						"progress",
						percent,
						t("progress.cleaning_enc"),
						`${i}/${total}`,
					);

					const treeRes = await this.api.createTree(currentTreeSha, chunk);

					if (!treeRes.ok) {
						throw new Error(`Tree creation failed: ${await treeRes.text()}`);
					}

					const treeData = await treeRes.json();
					currentTreeSha = treeData.sha;
				}

				// Final progress update showing completion of the deletion batch
				this.emit(
					"progress",
					80,
					t("progress.finalizing"),
					`${total}/${total}`,
				);

				const commitRes = await this.api.createCommit(
					"chore: reset repository (delete all files)",
					currentTreeSha,
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
			}
		} catch (e) {
			throw this.formatApiError(e);
		} finally {
			this.activeTask = null;
		}
	}
}
