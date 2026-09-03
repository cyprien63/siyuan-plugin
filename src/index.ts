/**
 * GitHub Sync — main plugin class.
 *
 * This is the entry point of the plugin. It wires together the GitHub REST
 * client (`GitHubAPI`), the SiYuan file APIs (`siyuan-api`), the encryption
 * helpers (`crypto`) and the UI dialogs, and exposes three actions in the
 * top bar:
 *
 *   - Smart Push   : 3-way merge (local / remote / last-known state), then
 *                    upload changed blobs, build a git tree, commit and move
 *                    the branch pointer.
 *   - Smart Pull   : download changed remote blobs into the workspace,
 *                    install missing plugins/widgets/themes from the
 *                    marketplace and restore notebook names.
 *   - History      : list the last commits and restore any of them.
 *
 * Key concepts used throughout this file:
 *   - Path obfuscation: when encryption is on, real paths are base64-encoded
 *     under `data/enc/<b64>` so filenames stay private on the remote.
 *   - The state ledger (`SYNCED_STATE_KEY`): stores, per file, a
 *     `plaintextSha:remoteSha` pair used by the 3-way merge to distinguish
 *     local changes from remote changes.
 *   - Manifests (plugins/widgets/themes/notebooks) are generated locally and
 *     pushed next to the data instead of syncing raw folders.
 */
import { Plugin } from "siyuan";
import { SyncEngine } from "./SyncEngine";
import { SettingsUI } from "./SettingsUI";
import { SyncStateLedger } from "./SyncStateLedger";
import { CryptoModule } from "./crypto";
import { GitHubAPI } from "./github-api";
import { t } from "./i18n";
import { STORAGE_KEY, DEFAULT_CONFIG, GitPluginConfig } from "./types";

export default class GitHubSyncPlugin extends Plugin {
	private engine!: SyncEngine;
	private ui!: SettingsUI;
	private ledger!: SyncStateLedger;
	public config: GitPluginConfig = { ...DEFAULT_CONFIG };

	async onload() {
		this.addIcons(
			`<symbol id="iconGitHubUpload" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 13v-4H8l4-4 4 4h-3v4h-2z"/></symbol><symbol id="iconGitHubDownload" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 7v4h3l-4 4-4-4h3V9h2z"/></symbol><symbol id="iconGitHistory" viewBox="0 0 24 24"><path fill="currentColor" d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></symbol>`,
		);

		const saved = await this.loadData(STORAGE_KEY);
		if (saved) {
			this.config = { ...DEFAULT_CONFIG, ...saved };
		}

		const api = new GitHubAPI(
			this.config.token,
			this.config.username,
			this.config.repo,
		);

		// initialize crypto module
		const crypto = new CryptoModule(this.config);

		// initialize sync state ledger
		this.ledger = new SyncStateLedger(this);

		// initialize backend plugin operations
		this.engine = new SyncEngine(api, crypto, this.ledger, this.config);

		// initialize settings UI
		this.ui = new SettingsUI(this, this.engine);

		this.ui.registerSettings();

		this.addTopBar({
			icon: "iconGitHubUpload",
			title: t("top.push_title"),
			position: "right",
			callback: () => this.engine.pushToGitHub(),
		});

		this.addTopBar({
			icon: "iconGitHubDownload",
			title: t("top.pull_title"),
			position: "right",
			callback: () => this.engine.pullFromGitHub(),
		});
	}
}

import { Plugin, Setting, Dialog, showMessage } from "siyuan";
import "./index.scss";
import {
	GitPluginConfig,
	GitHubCommit,
	DEFAULT_CONFIG,
	STORAGE_KEY,
	SYNC_ROOT,
	SYNCED_STATE_KEY,
	MergePlan,
	FileToSync,
	ManifestFile,
	MAX_FILE_BYTES,
	SKIP_ROOT_DIRS,
	SKIP_PATH_FRAGMENTS,
	LOCKED_EXTENSIONS,
	PLUGIN_MANIFEST_PATH,
	WIDGET_MANIFEST_PATH,
	THEME_MANIFEST_PATH,
	NOTEBOOK_MANIFEST_FILE,
	GitHubTreeItem,
	PluginCfg,
} from "./types";
import {
	calculateGitSha,
	sleep,
	arrayBufferToBase64,
	friendlyError,
	extractTextFromSyFile,
	generateCommitMessage,
} from "./utils";
import { GitHubAPI } from "./github-api";
import {
	getDeterministicSalt,
	deriveKeys,
	encryptFile,
	//decryptFile,
	isEncryptedBuffer,
} from "./crypto";
import {
	siYuanGetFile,
	siYuanPutFile,
	siYuanRefreshFiletree,
	siYuanRemoveFile,
	collectDir,
} from "./siyuan-api";
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
import { SyncProgressUI, showDiffDialog } from "./ProgressUI";
import { HistoryDialog } from "./history";
import { t, setLocale, availableLocales, getLocale, langs } from "./i18n";

/** Number of tree entries sent to GitHub per `createTree` request (chunking). */
const CHUNK_SIZE = 200;

export default class GitHubSyncPlugin extends Plugin {
	/**
	 * Obfuscate a real workspace path for the remote repository.
	 *
	 * With encryption enabled, every path is base64-encoded and stored under
	 * `data/enc/<base64(path)>` so notebook names and folder structures stay
	 * private. Manifests (plugins/widgets/themes/notebooks) are exempt because
	 * they must stay addressable by other flows.
	 */
	private obfuscateRemotePath(originalPath: string): string {
		if (this.removeEncryption || !this.config.encryptionPassword)
			return originalPath;
		if (
			originalPath === PLUGIN_MANIFEST_PATH ||
			originalPath === WIDGET_MANIFEST_PATH ||
			originalPath === THEME_MANIFEST_PATH ||
			originalPath.endsWith("/" + NOTEBOOK_MANIFEST_FILE) ||
			originalPath.startsWith(SYNC_ROOT + "/manifests")
		)
			return originalPath;
		const encoded = btoa(encodeURIComponent(originalPath));
		return `${SYNC_ROOT}/enc/${encoded}`;
	}

	/**
	 * Reverse of {@link obfuscateRemotePath}: turn a `data/enc/...` remote path
	 * back into the real workspace path. Non-obfuscated paths pass through
	 * unchanged; malformed base64 falls back to the raw path.
	 */
	private deobfuscateRemotePath(remotePath: string): string {
		const prefix = `${SYNC_ROOT}/enc/`;
		if (remotePath.startsWith(prefix)) {
			const b64 = remotePath.slice(prefix.length);
			try {
				return decodeURIComponent(atob(b64));
			} catch {
				return remotePath;
			}
		}
		return remotePath;
	}

	private config: GitPluginConfig = { ...DEFAULT_CONFIG };
	/** Currently running operation ("push"/"pull"), or null when idle. */
	private activeTask: "push" | "pull" | null = null;
	/** Progress UI instance currently on screen, if any. */
	private currentUI: SyncProgressUI | null = null;
	/** Latest progress state, persisted so re-opening the dialog restores it. */
	private lastProgress = {
		percent: 0,
		status: t("status.initializing"),
		details: "",
		finished: false,
		error: false,
		message: "",
	};
	/** The status-bar element showing the last sync date, or null. */
	private statusBarEl: HTMLElement | null = null;

	// Add this variable directly above the method
	/**
	 * Cache of the key-derivation promise, keyed by the password it was
	 * derived from. Recomputing keys is expensive (Argon2/PBKDF2), so the
	 * result is reused until the password changes.
	 */
	private keysCache: {
		password?: string;
		promise: Promise<CryptoKey[] | null>;
	} | null = null;

	/**
	 * When true, the plugin re-pushes the whole repo WITHOUT encryption (used by
	 * the "remove encryption" flow). No new write will be encrypted while set.
	 */
	private removeEncryption = false;

	/**
	 * Derive (and cache) the encryption keys for the current repository.
	 *
	 * Returns `null` when encryption is disabled or during the
	 * remove-encryption re-push. Concurrent calls share a single promise so
	 * the expensive derivation runs only once per password.
	 */
	private async deriveRepoKeys(): Promise<CryptoKey[] | null> {
		if (!this.config.encryptionPassword || this.removeEncryption) return null;

		// Return the cached promise if the password hasn't changed
		if (this.keysCache?.password === this.config.encryptionPassword) {
			return this.keysCache.promise;
		}

		// Wrap the derivation in a single Promise to handle concurrent calls safely
		const promise = (async () => {
			try {
				const username = this.config.username.trim();
				const repo = this.config.repo.trim();
				if (!username || !repo) {
					console.error(
						"[GitHub Sync] Username and repo must be set for deterministic salt derivation.",
					);
					return null;
				}

				// Generate static salt based on repo identity
				const saltBase64 = await getDeterministicSalt(username, repo);
				return await deriveKeys(this.config.encryptionPassword, saltBase64);
			} catch (e) {
				console.error("[GitHub Sync] Key derivation failed:", e);
				return null;
			}
		})();

		// Cache the promise alongside the password used to generate it
		this.keysCache = { password: this.config.encryptionPassword, promise };
		return promise;
	}

	/** Encrypt content if encryption is enabled; otherwise return it as-is. */
	private async maybeEncrypt(content: ArrayBuffer): Promise<ArrayBuffer> {
		const keys = await this.deriveRepoKeys();
		if (!keys || keys.length === 0) return content;
		// Always encrypt with the first (strongest) successfully generated key
		return encryptFile(content, keys[0]);
	}

	/**
	 * Decrypt content if it looks encrypted (checks the `GSE1` magic header);
	 * otherwise return it untouched. The hex snippet of the first bytes is
	 * logged to make crypto debugging easier.
	 */
	private async maybeDecrypt(content: ArrayBuffer): Promise<ArrayBuffer> {
		const keys = await this.deriveRepoKeys();
		const snippet = Array.from(new Uint8Array(content).slice(0, 12))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join(" ");
		if (!keys || keys.length === 0) return content;
		try {
			if (!(await import("./crypto")).isEncryptedBuffer(content))
				return content;
			// Pass the entire array of keys to be tested sequentially
			return await (await import("./crypto")).decryptFile(content, keys);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(
				`[GitHub Sync] maybeDecrypt failed: ${msg}. firstBytes=${snippet}`,
			);
			throw new Error(`Decryption failed: Verify your password. (${msg})`, {
				cause: e,
			});
		}
	}

	/**
	 * SiYuan lifecycle hook: runs when the plugin is loaded.
	 *
	 * Registers the top-bar icons (push / pull / history), loads the saved
	 * configuration, registers the settings page and attaches the status bar.
	 */
	async onload() {
		this.addIcons(
			`<symbol id="iconGitHubUpload" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 13v-4H8l4-4 4 4h-3v4h-2z"/></symbol><symbol id="iconGitHubDownload" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 7v4h3l-4 4-4-4h3V9h2z"/></symbol><symbol id="iconGitHistory" viewBox="0 0 24 24"><path fill="currentColor" d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></symbol>`,
		);
		const saved = await this.loadData(STORAGE_KEY);
		if (saved) {
			this.config = { ...DEFAULT_CONFIG, ...saved };
			try {
				// handling setLocale should be done in try-catch as the function will otherwise instantly halt
				setLocale(this.config.language ?? "en");
				(window as Window).__github_sync_locale = getLocale();
			} catch (e) {
				console.error(
					`[GitHub Sync] Failed to load locale '${this.config.language}'`,
					e,
				);
			}
		}
		this.registerSettings();
		this.addTopBar({
			icon: "iconGitHubUpload",
			title: t("top.push_title"),
			position: "right",
			callback: () => this.handlePushClick(),
		});
		this.addTopBar({
			icon: "iconGitHubDownload",
			title: t("top.pull_title"),
			position: "right",
			callback: () => this.handlePullClick(),
		});
		this.addTopBar({
			icon: "iconGitHistory",
			title: t("top.history_title"),
			position: "right",
			callback: () => this.handleHistoryClick(),
		});
		setTimeout(() => this.attachToStatusBar(), 1000);
	}

	private attachToStatusBar() {
		// Remove any stale element from a previous load before re-attaching.
		const old = document.getElementById("siyuan-github-sync-status");
		if (old) old.remove();
		const tryAttach = (parent: Element) => {
			this.statusBarEl = document.createElement("span");
			this.statusBarEl.id = "siyuan-github-sync-status";
			this.statusBarEl.style.cssText =
				"font-size:11px;opacity:.65;margin:0 8px;color:var(--b3-theme-on-background);";
			this.updateStatusBar();
			parent.appendChild(this.statusBarEl);
			return true;
		};
		// Prefer the "#statusBar #status" container; fall back to any element.
		const target =
			document.querySelector("#statusBar #status") ||
			document.querySelector("#statusBar");
		if (target && tryAttach(target)) return;

		// Last-resort: a fixed overlay pinned to the bottom center of the screen.
		this.statusBarEl = document.createElement("div");
		this.statusBarEl.id = "siyuan-github-sync-status";
		this.statusBarEl.style.cssText =
			"position:fixed;bottom:0;left:50%;transform:translateX(-50%);z-index:9999;font-size:11px;opacity:.65;pointer-events:none;color:var(--b3-theme-on-background);line-height:24px;";
		this.updateStatusBar();
		document.body.appendChild(this.statusBarEl);
	}

	/** Render the "last sync" date/time into the status-bar element. */
	private updateStatusBar() {
		if (!this.statusBarEl) return;
		const loaded = this.config.lastSync;
		if (loaded) {
			const d = new Date(loaded);
			const hh = String(d.getHours()).padStart(2, "0");
			const mm = String(d.getMinutes()).padStart(2, "0");
			const dd = String(d.getDate()).padStart(2, "0");
			const mo = String(d.getMonth() + 1).padStart(2, "0");
			this.statusBarEl.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px;">☁️ Sync: ${dd}/${mo} ${hh}:${mm}</span>`;
		} else {
			this.statusBarEl.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px;">☁️ Sync: --/--</span>`;
		}
	}

	/** Persist the current timestamp as the last-sync date and refresh the bar. */
	private async saveSyncTimestamp() {
		this.config.lastSync = Date.now();
		this.updateStatusBar();
		await this.saveData(STORAGE_KEY, this.config);
	}

	/**
	 * Show (or refresh) the progress dialog for a push/pull operation.
	 *
	 * If a dialog is already visible, it is re-synced with the stored progress
	 * state instead of creating a second dialog. This lets the user re-open
	 * the progress window while a long operation is still running.
	 */
	private showProgressUI(type: "push" | "pull") {
		if (this.currentUI && !this.currentUI.isDestroyed) {
			// If the UI is already visible, just update it with the current state
			if (this.lastProgress.finished) {
				if (this.lastProgress.error)
					this.currentUI.error(this.lastProgress.message);
				else this.currentUI.finish(this.lastProgress.message);
			} else {
				this.currentUI.update(
					this.lastProgress.percent,
					this.lastProgress.status,
					this.lastProgress.details,
				);
			}
			return;
		}

		this.currentUI = new SyncProgressUI(
			type === "push" ? t("top.push_title") : t("top.pull_title"),
			() => {
				// Only nullify the reference when the dialog is actually closed
				this.currentUI = null;
			},
		);

		// Apply the current state immediately upon creation
		if (this.lastProgress.finished) {
			if (this.lastProgress.error)
				this.currentUI.error(this.lastProgress.message);
			else this.currentUI.finish(this.lastProgress.message);
		} else {
			this.currentUI.update(
				this.lastProgress.percent,
				this.lastProgress.status,
				this.lastProgress.details,
			);
		}
	}

	/** Store progress state and push it to the dialog if one is open. */
	private updateProgress(percent: number, status: string, details: string) {
		this.lastProgress = { ...this.lastProgress, percent, status, details };
		if (this.currentUI) this.currentUI.update(percent, status, details);
	}

	/** Load the persisted sync-state ledger (or `null` if none was saved). */
	private async loadSyncedState(): Promise<{
		commitSha: string;
		files: Record<string, string>;
	} | null> {
		try {
			const data = await this.loadData(SYNCED_STATE_KEY);
			return data || null;
		} catch {
			return null;
		}
	}

	/** Persist the sync-state ledger for a given commit SHA. */
	private async saveSyncedState(
		commitSha: string,
		files: Record<string, string>,
	) {
		await this.saveData(SYNCED_STATE_KEY, { commitSha, files });
	}

	/**
	 * Full pull pipeline:
	 *
	 *   1. Require a token, mark the task as active and show the UI.
	 *   2. Fetch the remote ref/tree; abort cleanly if the repo is empty.
	 *   3. Diff remote blobs against the ledger + local content, keeping only
	 *      the files that actually changed.
	 *   4. Download the changed blobs (concurrently, in small batches),
	 *      decrypt them and write them into the workspace; update the ledger.
	 *   5. Restore notebook names, install missing plugins/widgets/themes.
	 *   6. Delete local files that no longer exist on the remote.
	 *   7. Refresh the file-tree and reload the UI.
	 */
	private async pullFromGitHub() {
		if (!this.config.token) return showMessage(t("msg.configure_plugin")); //[cite: 2]
		this.activeTask = "pull";

		this.lastProgress = {
			percent: 0,
			status: t("progress.analysis"),
			details: t("progress.reading_remote"),
			finished: false,
			error: false,
			message: "",
		};
		this.showProgressUI("pull");

		try {
			const api = new GitHubAPI(
				this.config.token,
				this.config.username,
				this.config.repo,
			);

			const repoInfo = await (await api.getRepoInfo()).json();
			const branch = repoInfo.default_branch || "main";

			const refRes = await api.getRef(branch);
			if (!refRes.ok) {
				this.lastProgress = {
					...this.lastProgress,
					finished: true,
					message: t("msg.repo_empty"),
				};
				if (this.currentUI) this.currentUI.finish(t("msg.repo_empty"));
				return;
			}

			const refData = await refRes.json();
			const lastCommit = await (await api.getCommit(refData.object.sha)).json();

			const remoteItems = (await api.getRemoteTree(lastCommit.tree.sha)).filter(
				(i) => {
					// Only sync blob entries under the sync root, and drop the
					// excluded top-level folders (plugins, storage, conf, ...).
					if (i.type !== "blob") return false;
					const p = i.path;
					if (p.startsWith("data/")) {
						const rest = p.slice(5);
						const firstSegment = rest.split("/")[0];
						if (SKIP_ROOT_DIRS.includes(firstSegment)) return false;
					}
					return p.startsWith(SYNC_ROOT);
				},
			);

			// 1. Load the synced state
			const syncedState = await this.loadSyncedState();
			const syncedFiles = syncedState?.files || {};
			let stateUpdated = false;

			// Batch optimizer:
			// 1. Pre-filter files to find exactly what needs downloading (Runs instantly in memory)
			const toPull = [];
			for (let i = 0; i < remoteItems.length; i++) {
				const item = remoteItems[i];

				// Extract the plaintext path to ensure state ledger parity
				let originalPath = item.path;
				if (item.path.startsWith(`${SYNC_ROOT}/enc/`)) {
					originalPath = this.deobfuscateRemotePath(item.path);
				}

				const siPath = `/${originalPath}`;

				// Skip locked / volatile files that must never be overwritten.
				if (
					LOCKED_EXTENSIONS.some((ext) => siPath.toLowerCase().endsWith(ext)) ||
					siPath.includes("/temp/") ||
					SKIP_PATH_FRAGMENTS.some((f) => siPath.includes(f))
				) {
					continue;
				}

				if (siPath.endsWith(".siyuan.sy")) {
					continue;
				}

				// Manifests are installed via installMissingPlugins/Widgets/Themes
				// and must not be written as regular workspace files (it would make
				// the next push upload duplicate tree entries -> Git RPC 422).
				if (
					originalPath === PLUGIN_MANIFEST_PATH ||
					originalPath === WIDGET_MANIFEST_PATH ||
					originalPath === THEME_MANIFEST_PATH
				) {
					continue;
				}

				// Lookup state using the plaintext originalPath
				const knownRaw = syncedFiles[originalPath];
				const remoteSynced =
					knownRaw && knownRaw.includes(":")
						? knownRaw.split(":")[1]
						: knownRaw;

				// Compare against the actual local content (missing/deleted file
				// yields an empty SHA), exactly like the pre-state pull did,
				// so locally deleted documents get re-downloaded.
				const localContent = await siYuanGetFile(siPath);
				const localSha =
					localContent && localContent.byteLength > 0
						? await calculateGitSha(localContent)
						: "";

				if (remoteSynced !== item.sha || localSha !== item.sha) {
					toPull.push({ item, siPath, originalPath });
				}
			}

			// 2. Download and write the changed files concurrently in batches
			const CHUNK_SIZE_PULL = 5;

			for (let i = 0; i < toPull.length; i += CHUNK_SIZE_PULL) {
				const chunk = toPull.slice(i, i + CHUNK_SIZE_PULL);

				this.updateProgress(
					10 + Math.round((i / toPull.length) * 80),
					`Pull : ${i + chunk.length}/${toPull.length} files`,
					chunk
						.map((c) => c.originalPath)
						.join(", ")
						.slice(0, 50) + "...",
				);

				// Download up to 5 blobs in parallel, decrypt and write each one.
				await Promise.all(
					chunk.map(async ({ item, siPath, originalPath }) => {
						const content = await api.downloadBlob(item.sha);
						if (content && content.byteLength > 0) {
							try {
								const decrypted = await this.maybeDecrypt(content);
								await siYuanPutFile(siPath, decrypted);

								const ptSha = await calculateGitSha(decrypted);
								// Save state using the plaintext originalPath
								syncedFiles[originalPath] = `${ptSha}:${item.sha}`;
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

				await sleep(30);
			}

			// Restore notebook display names from their manifests (best-effort).
			try {
				await processNotebookManifests(remoteItems, api, (buf) =>
					this.maybeDecrypt(buf),
				);
			} catch {
				/* ignore */
			}

			// 3. Process Plugins, Widgets, and Themes manifest files
			// Download each manifest, parse it, and install the packages that
			// are missing locally.
			const onProgress = (pct: number, status: string, details: string) =>
				this.updateProgress(pct, status, details);

			const manifestItem = remoteItems.find(
				(i) => i.path === PLUGIN_MANIFEST_PATH,
			);
			let pluginsInstalled: number | null;
			if (manifestItem) {
				const manifestContent = await api.downloadBlob(manifestItem.sha);
				if (manifestContent) {
					try {
						const manifest = JSON.parse(
							new TextDecoder().decode(
								await this.maybeDecrypt(manifestContent),
							),
						);
						pluginsInstalled = await installMissingPlugins(
							manifest,
							onProgress,
						);
					} catch {
						/* ignore */
					}
				}
			}

			const widgetManifestItem = remoteItems.find(
				(i) => i.path === WIDGET_MANIFEST_PATH,
			);
			let widgetsInstalled: number | null;
			if (widgetManifestItem) {
				const widgetManifestContent = await api.downloadBlob(
					widgetManifestItem.sha,
				);
				if (widgetManifestContent) {
					try {
						const wManifest = JSON.parse(
							new TextDecoder().decode(
								await this.maybeDecrypt(widgetManifestContent),
							),
						);
						widgetsInstalled = await installMissingWidgets(
							wManifest,
							onProgress,
						);
					} catch {
						/* ignore */
					}
				}
			}

			const themeManifestItem = remoteItems.find(
				(i) => i.path === THEME_MANIFEST_PATH,
			);
			let themesInstalled: number | null;
			if (themeManifestItem) {
				const themeManifestContent = await api.downloadBlob(
					themeManifestItem.sha,
				);
				if (themeManifestContent) {
					try {
						const tManifest = JSON.parse(
							new TextDecoder().decode(
								await this.maybeDecrypt(themeManifestContent),
							),
						);
						themesInstalled = await installMissingThemes(tManifest, onProgress);
					} catch {
						/* ignore */
					}
				}
			}

			// provisory debug line, may include this info in the UI later on
			console.log(
				`[GitHub Sync] Installed ${pluginsInstalled ?? 0} plugins, ${widgetsInstalled ?? 0} widgets, ${themesInstalled ?? 0} themes from manifests.`,
			);

			// 4. Remove local files that no longer exist on the remote
			// Build a set of all "plaintext" remote paths (de-obfuscated) to
			// compare against the ledger.
			const remotePlainSet = new Set<string>();
			for (const item of remoteItems) {
				if (item.path.startsWith(`${SYNC_ROOT}/enc/`)) {
					remotePlainSet.add(this.deobfuscateRemotePath(item.path));
				} else {
					remotePlainSet.add(item.path);
				}
			}

			let deleted = 0;
			for (const localPath of Object.keys(syncedFiles)) {
				// Keep any file still present on the remote.
				if (remotePlainSet.has(localPath)) continue;

				const lower = localPath.toLowerCase();
				// Never delete locked/volatile files.
				if (LOCKED_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue;
				if (
					localPath.includes("/temp/") ||
					SKIP_PATH_FRAGMENTS.some((f) => localPath.includes(f))
				)
					continue;
				if (
					localPath.endsWith(".siyuan.sy") ||
					localPath.endsWith(`/${NOTEBOOK_MANIFEST_FILE}`)
				)
					continue;
				// Plugins are managed through their manifest, never deleted here.
				if (localPath.startsWith(`${SYNC_ROOT}/plugins/`)) continue;

				this.updateProgress(90, `Pull : delete`, localPath);

				if (await siYuanRemoveFile(`/${localPath}`)) {
					delete syncedFiles[localPath];
					deleted++;
					stateUpdated = true;
				}
			}

			// 5. Save the updated state mapping if files were modified[cite: 2]
			if (stateUpdated) {
				await this.saveSyncedState(lastCommit.sha, syncedFiles);
			}

			// Refresh the file tree so SiYuan picks up the new/changed files.
			if (deleted > 0 || stateUpdated) {
				await siYuanRefreshFiletree();
			}

			const finishMsg = "Pull complete. Reloading...";

			this.lastProgress = {
				...this.lastProgress,
				finished: true,
				message: finishMsg,
			};

			if (this.currentUI) {
				// Hide close button since we are reloading
				this.currentUI.finish(finishMsg, false);
			}
			await this.saveSyncTimestamp();

			// A reload makes SiYuan rebuild its indexes from the new files.
			setTimeout(() => window.location.reload(), 1500);
		} catch (e) {
			this.lastProgress = {
				...this.lastProgress,
				finished: true,
				error: true,
				message: friendlyError(e),
			};
			if (this.currentUI) this.currentUI.error(friendlyError(e));
		} finally {
			this.activeTask = null;
		}
	}

	/**
	 * Restore the workspace to the state of a given commit.
	 *
	 * Fetches the commit's tree, downloads every blob under the sync root
	 * (except the plugin's own folder), decrypts and writes them, then refreshes
	 * the file-tree and the ledger.
	 */
	async restoreCommit(sha: string, message: string) {
		const api = new GitHubAPI(
			this.config.token,
			this.config.username,
			this.config.repo,
		);
		const commitRes = await api.getCommit(sha);
		if (!commitRes.ok)
			throw new Error(t("error.cannot_fetch_commit") || "Cannot fetch commit");

		const commitData = await commitRes.json();
		const treeItems = await api.getRemoteTree(commitData.tree.sha);
		const blobs = treeItems.filter(
			(i) =>
				i.type === "blob" &&
				i.path.startsWith(SYNC_ROOT) &&
				!i.path.startsWith("data/plugins/siyuan-github-sync/"),
		);

		let updated = 0;
		for (const item of blobs) {
			// De-obfuscate encrypted paths back to real workspace paths.
			let siPath = `/${item.path}`;
			if (item.path.startsWith(`${SYNC_ROOT}/enc/`)) {
				siPath = `/${this.deobfuscateRemotePath(item.path)}`;
			}

			if (siPath.endsWith(`/${NOTEBOOK_MANIFEST_FILE}`)) {
				continue;
			}

			// Skip the same locked/volatile files as the pull flow.
			if (
				LOCKED_EXTENSIONS.some((ext) => siPath.toLowerCase().endsWith(ext)) ||
				siPath.includes("/temp/") ||
				SKIP_PATH_FRAGMENTS.some((f) => siPath.includes(f)) ||
				siPath.endsWith(".siyuan.sy")
			) {
				continue;
			}
			const writePath = siPath;

			const content = await api.downloadBlob(item.sha);
			if (content && content.byteLength > 0) {
				try {
					const decrypted = await this.maybeDecrypt(content);
					await siYuanPutFile(writePath, decrypted);
					updated++;
				} catch (e) {
					// throw a warn and skip
					console.warn(`[GitHub Sync] Failed to decrypt ${writePath}:`, e);
				}
				await sleep(30);
			}
		}
		await siYuanRefreshFiletree();

		// Restore notebook names too (best-effort).
		try {
			await processNotebookManifests(treeItems, api, (buf) =>
				this.maybeDecrypt(buf),
			);
		} catch {
			/* ignore */
		}

		// Rebuild the ledger from the restored tree.
		const newFilesState: Record<string, string> = {};
		treeItems.forEach((item) => {
			if (item.type === "blob") newFilesState[item.path] = item.sha;
		});
		await this.saveSyncedState(sha, newFilesState);

		showMessage(
			t("msg.restored")
				.replace("{n}", String(updated))
				.replace("{sha}", sha.slice(0, 7))
				.replace("{message}", message),
		);
		await this.saveSyncTimestamp();
	}

	/** Top-bar "History" click handler: require a token, then open the dialog. */
	private async handleHistoryClick() {
		if (!this.config.token) return showMessage(t("msg.configure_plugin"));
		new HistoryDialog(
			() => this.getHistory(),
			(sha: string, msg: string) => this.restoreCommit(sha, msg),
		);
	}

	/** Fetch the commit history (used by {@link HistoryDialog}). */
	async getHistory(): Promise<GitHubCommit[]> {
		const api = new GitHubAPI(
			this.config.token,
			this.config.username,
			this.config.repo,
		);
		return api.getCommits();
	}
}
