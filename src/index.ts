import { Plugin, Setting, Dialog, showMessage } from "siyuan";
import "./index.scss";
import {
	GitHubConfig,
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
	decryptFile,
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
import { SyncProgressUI, showDiffDialog } from "./ui";
import { HistoryDialog } from "./history";
import { t, setLocale, availableLocales, getLocale, langs } from "./i18n";

const CHUNK_SIZE = 200;

export default class GitHubSyncPlugin extends Plugin {
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

	private config: GitHubConfig = { ...DEFAULT_CONFIG };
	private activeTask: "push" | "pull" | null = null;
	private currentUI: SyncProgressUI | null = null;
	private lastProgress = {
		percent: 0,
		status: t("status.initializing"),
		details: "",
		finished: false,
		error: false,
		message: "",
	};
	private statusBarEl: HTMLElement | null = null;

	// Add this variable directly above the method
	private keysCache: { password?: string; promise: Promise<CryptoKey[] | null> } | null = null;

	// When true, the plugin re-pushes the whole repo WITHOUT encryption (used by
	// the "remove encryption" flow). No new write will be encrypted while set.
	private removeEncryption = false;

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

	private async maybeEncrypt(content: ArrayBuffer): Promise<ArrayBuffer> {
		const keys = await this.deriveRepoKeys();
		if (!keys || keys.length === 0) return content;
		// Always encrypt with the first (strongest) successfully generated key
		return encryptFile(content, keys[0]);
	}

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
			throw new Error(`Decryption failed: Verify your password. (${msg})`);
		}
	}

	async onload() {
		this.addIcons(
			`<symbol id="iconGitHubUpload" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 13v-4H8l4-4 4 4h-3v4h-2z"/></symbol><symbol id="iconGitHubDownload" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 7v4h3l-4 4-4-4h3V9h2z"/></symbol><symbol id="iconGitHistory" viewBox="0 0 24 24"><path fill="currentColor" d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></symbol>`,
		);
		const saved = await this.loadData(STORAGE_KEY);
		if (saved) {
			this.config = { ...DEFAULT_CONFIG, ...saved };
			try {
				setLocale(this.config.language ?? "en");
				(window as any).__github_sync_locale = getLocale();
			} catch {}
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
		const target =
			document.querySelector("#statusBar #status") ||
			document.querySelector("#statusBar");
		if (target && tryAttach(target)) return;

		this.statusBarEl = document.createElement("div");
		this.statusBarEl.id = "siyuan-github-sync-status";
		this.statusBarEl.style.cssText =
			"position:fixed;bottom:0;left:50%;transform:translateX(-50%);z-index:9999;font-size:11px;opacity:.65;pointer-events:none;color:var(--b3-theme-on-background);line-height:24px;";
		this.updateStatusBar();
		document.body.appendChild(this.statusBarEl);
	}

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

	private async saveSyncTimestamp() {
		this.config.lastSync = Date.now();
		this.updateStatusBar();
		await this.saveData(STORAGE_KEY, this.config);
	}

	private registerSettings() {
		const uIn = this.mkInput(t("setting.github_user"), this.config.username);
		const rIn = this.mkInput(t("setting.github_repo"), this.config.repo);
		const tIn = this.mkInput(
			t("setting.github_token"),
			this.config.token,
			"password",
		);

		const t_Toggle = document.createElement("button");
		t_Toggle.type = "button";
		t_Toggle.className = "b3-button b3-button--outline";
		t_Toggle.style.cssText = "margin-left:8px;padding:4px 8px;font-size:14px;";
		t_Toggle.textContent = "👁️";
		t_Toggle.onclick = () => {
			if (tIn.type === "password") {
				tIn.type = "text";
				t_Toggle.textContent = "🙈";
			} else {
				tIn.type = "password";
				t_Toggle.textContent = "👁️";
			}
		};

		const gIn = this.mkInput(
			t("setting.groq_key"),
			this.config.groqKey,
			"password",
		);

		const dIn = document.createElement("input");
		dIn.type = "checkbox";
		dIn.checked = this.config.showDiff;
		dIn.style.cssText = "width:16px;height:16px;cursor:pointer;margin:0;";

		const tBtn = document.createElement("button");
		tBtn.className = "b3-button b3-button--outline fn__block";
		tBtn.textContent = t("button.test_github");
		tBtn.onclick = async () => {
			tBtn.disabled = true;
			const api = new GitHubAPI(tIn.value.trim(), uIn.value, rIn.value);
			if (await api.testConnection()) showMessage(t("status.ok"));
			else showMessage(t("status.error"), 6000, "error");
			tBtn.disabled = false;
		};

		const pIn = this.mkInput(
			t("setting.encryption_password"),
			this.config.encryptionPassword || "",
			"password",
		);
		pIn.title = t("hint.encryption_password");

		const pToggle = document.createElement("button");
		pToggle.type = "button";
		pToggle.className = "b3-button b3-button--outline";
		pToggle.style.cssText = "margin-left:8px;padding:4px 8px;font-size:14px;";
		pToggle.textContent = "👁️";
		pToggle.onclick = () => {
			if (pIn.type === "password") {
				pIn.type = "text";
				pToggle.textContent = "🙈";
			} else {
				pIn.type = "password";
				pToggle.textContent = "👁️";
			}
		};

		const eBtn = document.createElement("button");
		eBtn.className = "b3-button b3-button--outline fn__block";
		eBtn.textContent = t("button.export");
		eBtn.onclick = () => {
			const hasToken = !!tIn.value.trim();
			const hasGroq = !!gIn.value.trim();
			const hasPassword = !!pIn.value.trim();
			const warnParts: string[] = [];
			if (hasToken) warnParts.push(t("part.the") + "GitHub token");
			if (hasGroq) warnParts.push(t("part.the") + "the Groq API key");
			if (hasPassword) warnParts.push(t("part.the") + "encryption password");

			if (warnParts.length > 0) {
				const ok = confirm(
					`${t("msg.export_warning_prefix")} ${warnParts.join(t("part.and"))}${t("part.export_warning_suffix")}`,
				);
				if (!ok) return;
			}
			const cfg: any = {
				username: uIn.value.trim(),
				repo: rIn.value.trim(),
				token: tIn.value.trim(),
				groqKey: gIn.value.trim(),
				showDiff: dIn.checked,
				language: (this.config && this.config.language) || "en",
			};
			if (pIn.value.trim()) cfg.encryptionPassword = pIn.value.trim();

			const blob = new Blob([JSON.stringify(cfg, null, 2)], {
				type: "application/json",
			});
			const a = document.createElement("a");
			a.href = URL.createObjectURL(blob);
			a.download = "siyuan-github-sync-config.json";
			a.click();
			URL.revokeObjectURL(a.href);
			showMessage(t("msg.config_exported"));
		};

		const iBtn = document.createElement("button");
		iBtn.className = "b3-button b3-button--outline fn__block";
		iBtn.textContent = t("button.import");
		iBtn.onclick = () => {
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
						showMessage("  Invalid file", 6000, "error");
						return;
					}
					uIn.value = data.username;
					rIn.value = data.repo;
					tIn.value = data.token;
					gIn.value = data.groqKey || "";
					dIn.checked = !!data.showDiff;
					pIn.value = data.encryptionPassword || "";

					if (data.language) {
						try {
							setLocale(data.language);
						} catch {}
					}
					showMessage(t("msg.config_loaded"));
				} catch {
					showMessage(t("error.invalid_file"), 6000, "error");
				}
			};
			fi.click();
		};

		const btnRow = document.createElement("div");
		btnRow.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";

		const passWrap = document.createElement("div");
		passWrap.style.cssText = "display:flex;gap:8px;align-items:center;";
		passWrap.appendChild(pIn);
		passWrap.appendChild(pToggle);

		const tokenWrap = document.createElement("div");
		tokenWrap.style.cssText = "display:flex;gap:8px;align-items:center;";
		tokenWrap.appendChild(tIn);
		tokenWrap.appendChild(t_Toggle);

		btnRow.appendChild(tBtn);
		btnRow.appendChild(eBtn);
		btnRow.appendChild(iBtn);

		const forgetBtn = document.createElement("button");
		forgetBtn.className = "b3-button b3-button--outline fn__block";
		forgetBtn.title = t("hint.remove_encryption");
		forgetBtn.textContent = t("button.forget_password");
		forgetBtn.onclick = () => {
			this.removeEncryptionWithPassword(pIn);
		};
		btnRow.appendChild(forgetBtn);

		this.setting = new Setting({
			confirmCallback: async () => {
				this.config = {
					...this.config, // preserves lastSync and other hidden properties
					username: uIn.value.trim(),
					repo: rIn.value.trim(),
					token: tIn.value.trim(),
					groqKey: gIn.value.trim(),
					showDiff: dIn.checked,
					language: this.config.language || "en",
					encryptionPassword: pIn.value.trim() || undefined,
				};
				await this.saveData(STORAGE_KEY, this.config);
				showMessage(t("msg.saved"));
			},
		});

		const langSelect = document.createElement("select");
		langSelect.className = "b3-select fn__block";
		const _langLabels: Record<string, string> = langs;
		for (const loc of availableLocales()) {
			const opt = document.createElement("option");
			opt.value = loc;
			opt.textContent = _langLabels[loc] || loc;
			langSelect.appendChild(opt);
		}
		langSelect.value = this.config.language || getLocale();
		langSelect.onchange = () => {
			this.config.language = langSelect.value;
			try {
				setLocale(langSelect.value);
				(window as any).__github_sync_locale = getLocale();
			} catch {}
		};

		this.setting.addItem({
			title: t("setting.github_user"),
			createActionElement: () => uIn,
		});
		this.setting.addItem({
			title: t("setting.github_repo"),
			createActionElement: () => rIn,
		});
		this.setting.addItem({
			title: t("setting.github_token"),
			createActionElement: () => {
				const wrap = document.createElement("div");
				wrap.appendChild(tokenWrap);
				return wrap;
			},
		});
		this.setting.addItem({
			title: t("setting.groq_key"),
			createActionElement: () => gIn,
		});

		this.setting.addItem({
			title: t("setting.encryption_password"),
			createActionElement: () => {
				const wrap = document.createElement("div");
				wrap.appendChild(passWrap);
				return wrap;
			},
		});

		this.setting.addItem({
			title: t("setting.show_diff"),
			createActionElement: () => dIn,
		});
		this.setting.addItem({
			title: t("setting.language"),
			createActionElement: () => langSelect,
		});
		this.setting.addItem({
			title: t("setting.actions"),
			createActionElement: () => btnRow,
		});
	}

	private removeEncryptionWithPassword(pIn: HTMLInputElement) {
		if (this.activeTask) {
			showMessage(t("action.push"), 4000, "error");
			return;
		}
		const dialog = new Dialog({
			title: t("dialog.remove_encryption_title"),
			content: `
                <div class="b3-dialog__content" style="padding:16px;">
                    <div style="margin-bottom:12px;line-height:1.7;white-space:pre-wrap;">${t("dialog.remove_encryption_body")}</div>
                    <input id="remove-encryption-pwd" class="b3-text-field fn__block" type="password" placeholder="${t("placeholder.current_password")}" style="margin-bottom:12px;" />
                    <div style="font-size:12px;opacity:.65;">${t("hint.remove_encryption")}</div>
                </div>
                <div class="b3-dialog__action" style="padding:8px 16px;border-top:1px solid var(--b3-border-color);">
                    <button id="remove-encryption-confirm" class="b3-button b3-button--outline">${t("button.confirm")}</button>
                    <button id="remove-encryption-cancel" class="b3-button b3-button--outline" style="margin-left:8px;">${t("button.close")}</button>
                </div>
            `,
			width: window.innerWidth < 600 ? `${window.innerWidth - 32}px` : "540px",
		});
		const pwdEl = dialog.element.querySelector<HTMLInputElement>('#remove-encryption-pwd');
		dialog.element.querySelector('#remove-encryption-cancel').addEventListener("click", () => dialog.destroy());
		const confirm = async () => {
			const oldPwd = pwdEl.value;
			if (!oldPwd.trim()) {
				showMessage(t("error.password_required"), 6000, "error");
				pwdEl.focus();
				return;
			}
			dialog.destroy();
			try {
				await this.removeEncryptionToPlain(oldPwd.trim());
				pIn.value = "";
				showMessage(t("msg.encryption_removed"), 8000);
			} catch (e) {
				showMessage(friendlyError(e), 8000, "error");
			}
		};
		dialog.element.querySelector('#remove-encryption-confirm').addEventListener("click", confirm);
		pwdEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") confirm();
		});
		pwdEl.focus();
	}

	private async removeEncryptionToPlain(oldPassword: string) {
		if (!this.config.token) throw new Error(t("msg.configure_plugin"));
		const api = new GitHubAPI(
			this.config.token,
			this.config.username,
			this.config.repo,
		);

		this.activeTask = "push";
		this.lastProgress = {
			percent: 0,
			status: t("progress.removing_encryption"),
			details: t("progress.reading_remote"),
			finished: false,
			error: false,
			message: "",
		};
		this.showProgressUI("push");

		try {
			const repoInfo = await (await api.getRepoInfo()).json();
			const branch = repoInfo.default_branch || "main";
			const refRes = await api.getRef(branch);
			if (!refRes.ok) {
				// Nothing usable to decrypt on the remote, just clear the setting.
				this.keysCache = null;
				this.config.encryptionPassword = undefined;
				await this.saveData(STORAGE_KEY, this.config);
				const msg = t("msg.encryption_removed");
				this.lastProgress = {
					...this.lastProgress,
					finished: true,
					message: msg,
				};
				if (this.currentUI) this.currentUI.finish(msg);
				return;
			}
			const refData = await refRes.json();
			const lastCommitSha = refData.object.sha;
			const lastCommit = await (await api.getCommit(lastCommitSha)).json();
			const remoteTree = (await api.getRemoteTree(lastCommit.tree.sha)) as GitHubTreeItem[];

			// Find an actually-encrypted blob so the OLD password can be verified.
			let verifyItem: GitHubTreeItem | null = null;
			for (const item of remoteTree) {
				if (item.type !== "blob") continue;
				if (
					!item.path.startsWith(`${SYNC_ROOT}/enc/`) &&
					!item.path.endsWith(`/${NOTEBOOK_MANIFEST_FILE}`)
				)
					continue;
				const buf = await api.downloadBlob(item.sha);
				if (buf && isEncryptedBuffer(buf)) {
					verifyItem = item;
					break;
				}
			}

			if (verifyItem) {
				this.updateProgress(
					2,
					t("progress.removing_encryption"),
					t("progress.verifying_password"),
				);
				const salt = await getDeterministicSalt(
					this.config.username.trim(),
					this.config.repo.trim(),
				);
				const verifyBuf = await api.downloadBlob(verifyItem.sha);
				if (!verifyBuf) {
					throw new Error(t("error.bad_password"));
				}
				try {
					const keys = await deriveKeys(oldPassword, salt);
					await decryptFile(verifyBuf, keys);
				} catch (e) {
					throw new Error(t("error.bad_password"));
				}
			}

			// Re-push the whole repository as plaintext and delete the old
			// encrypted blobs so nothing can be recovered from the remote.
			this.removeEncryption = true;
			try {
				await this.rePushAllPlain(api, branch, lastCommitSha, remoteTree);
			} finally {
				this.removeEncryption = false;
			}

			this.keysCache = null;
			this.config.encryptionPassword = undefined;
			await this.saveData(STORAGE_KEY, this.config);
			this.lastProgress = {
				...this.lastProgress,
				percent: 100,
				finished: true,
				message: t("msg.encryption_removed"),
			};
			if (this.currentUI) this.currentUI.finish(t("msg.encryption_removed"));
			await this.saveSyncTimestamp();
		} catch (e) {
			this.lastProgress = {
				...this.lastProgress,
				finished: true,
				error: true,
				message: friendlyError(e),
			};
			if (this.currentUI) this.currentUI.error(friendlyError(e));
			throw e;
		} finally {
			this.activeTask = null;
		}
	}

	private async rePushAllPlain(
		api: GitHubAPI,
		branch: string,
		lastCommitSha: string,
		remoteTree: GitHubTreeItem[],
	) {
		const generatedManifestPaths = new Set([
			PLUGIN_MANIFEST_PATH,
			WIDGET_MANIFEST_PATH,
			THEME_MANIFEST_PATH,
		]);
		const localFiles = (await collectDir(`/${SYNC_ROOT}`, SYNC_ROOT)).filter(
			(f) =>
				!generatedManifestPaths.has(f.githubPath) &&
				!f.githubPath.endsWith(`/${NOTEBOOK_MANIFEST_FILE}`),
		);
		const pluginManifest = await generatePluginManifest();
		const widgetManifest = await generateWidgetManifest();
		const themeManifest = await generateThemeManifest();
		const notebookManifests = await generateNotebookManifests();

		const localFileMap = new Map<string, string>();
		for (const f of localFiles) localFileMap.set(f.githubPath, f.siYuanPath);

		const treeItems: any[] = [];
		const reusedPaths = new Set<string>();

		// 1. DELETE all obfuscated (encrypted) blobs.
		this.updateProgress(4, t("progress.cleaning_enc"), "encrypted files...");
		for (const item of remoteTree) {
			if (item.type !== "blob") continue;
			if (!item.path.startsWith(`${SYNC_ROOT}/enc/`)) continue;
			treeItems.push({
				path: item.path,
				mode: "100644",
				type: "blob",
				sha: null,
			});
		}

		// 2. Handle plaintext remote blobs: reuse what matches local, delete the rest.
		for (const item of remoteTree) {
			if (item.type !== "blob") continue;
			if (item.path.startsWith(`${SYNC_ROOT}/enc/`)) continue;
			if (!item.path.startsWith(`${SYNC_ROOT}/`)) continue;

			const localSi = localFileMap.get(item.path);
			if (!localSi) {
				if (
					generatedManifestPaths.has(item.path) ||
					item.path.endsWith(`/${NOTEBOOK_MANIFEST_FILE}`)
				) {
					// Regenerated in step 4, do not emit a delete for them here.
					continue;
				}
				treeItems.push({
					path: item.path,
					mode: "100644",
					type: "blob",
					sha: null,
				});
				continue;
			}
			const content = await siYuanGetFile(localSi);
			if (
				content &&
				content.byteLength > 0 &&
				(await calculateGitSha(content)) === item.sha
			) {
				treeItems.push({
					path: item.path,
					mode: "100644",
					type: "blob",
					sha: item.sha,
				});
				reusedPaths.add(item.path);
			}
		}

		// 3. Upload every local file as a plaintext blob.
		let count = 0;
		for (const f of localFiles) {
			if (reusedPaths.has(f.githubPath)) continue;
			const content = await siYuanGetFile(f.siYuanPath);
			if (!content || content.byteLength === 0) continue;
			if (content.byteLength > MAX_FILE_BYTES) continue;
			this.updateProgress(
				10 + Math.round((count / Math.max(1, localFiles.length)) * 70),
				t("progress.uploading_plaintext").replace(
					"{n}",
					`${count + 1}/${localFiles.length}`,
				),
				f.githubPath,
			);
			const blobRes = await api.createBlob(arrayBufferToBase64(content));
			if (!blobRes.ok) {
				throw new Error(
					`[GitHub Sync] Blob failed for ${f.githubPath}: ${await blobRes.text()}`,
				);
			}
			const blobData = await blobRes.json();
			treeItems.push({
				path: f.githubPath,
				mode: "100644",
				type: "blob",
				sha: blobData.sha,
			});
			count++;
		}

		// 4. Upload manifests (plaintext thanks to the removeEncryption flag).
		for (const m of [
			{ path: PLUGIN_MANIFEST_PATH, content: pluginManifest.content },
			{ path: WIDGET_MANIFEST_PATH, content: widgetManifest.content },
			{ path: THEME_MANIFEST_PATH, content: themeManifest.content },
		]) {
			const blobRes = await api.createBlob(arrayBufferToBase64(m.content));
			if (blobRes.ok) {
				const bd = await blobRes.json();
				treeItems.push({
					path: m.path,
					mode: "100644",
					type: "blob",
					sha: bd.sha,
				});
			}
		}
		for (const nm of notebookManifests) {
			const blobRes = await api.createBlob(
				arrayBufferToBase64(await this.maybeEncrypt(nm.content)),
			);
			if (blobRes.ok) {
				const bd = await blobRes.json();
				treeItems.push({
					path: nm.githubPath,
					mode: "100644",
					type: "blob",
					sha: bd.sha,
				});
			}
		}

		this.updateProgress(88, t("progress.cleaning_enc"), t("progress.creating_tree"));

		const baseTreeRes = await api.getCommit(lastCommitSha);
		const baseTreeData = await baseTreeRes.json();
		let currentTreeSha = baseTreeData.tree.sha;
		const treeMap = new Map<string, any>();
		for (const tEnter of treeItems) treeMap.set(tEnter.path, tEnter);
		const dedupedTreeItems = [...treeMap.values()];
		for (let i = 0; i < dedupedTreeItems.length; i += CHUNK_SIZE) {
			const chunk = dedupedTreeItems.slice(i, i + CHUNK_SIZE);
			let treeRes: Response | undefined;
			let attempts = 0;
			const maxAttempts = 5;
			while (attempts < maxAttempts) {
    treeRes = await api.createTree(currentTreeSha, chunk);
    if (treeRes.ok) break;
    if (treeRes.status >= 500) {
        attempts++;
        await sleep(attempts * 5000);
    } else {
        break;
    }
			}
			if (!treeRes || !treeRes.ok) {
    const errText = (await treeRes?.text()) || "Unknown API Error";
    throw new Error(`[GitHub Sync] Tree creation failed (Chunk ${Math.floor(i / CHUNK_SIZE) + 1}): ${treeRes?.statusText} - ${errText}`);
			}
			const treeData = await treeRes.json();
			currentTreeSha = treeData.sha;
		}

		const commitRes = await api.createCommit(
			"chore: removed encryption (re-pushed in cleartext)",
			currentTreeSha,
			[lastCommitSha],
		);
		if (!commitRes.ok) {
			const errText = await commitRes.text();
			throw new Error(
				`[GitHub Sync] Commit failed: ${commitRes.statusText} - ${errText}`,
			);
		}
		const commitData = await commitRes.json();
		const refRes = await api.updateRef(branch, commitData.sha);
		if (!refRes.ok) {
			const errText = await refRes.text();
			throw new Error(
				`[GitHub Sync] Ref update failed: ${refRes.statusText} - ${errText}`,
			);
		}

		const newFilesState: Record<string, string> = {};
		for (const tEnter of treeItems) {
			if (!tEnter.sha) continue;
			const p = tEnter.path;
			if (p.startsWith(`${SYNC_ROOT}/enc/`)) continue;
			if (
				p === PLUGIN_MANIFEST_PATH ||
				p === WIDGET_MANIFEST_PATH ||
				p === THEME_MANIFEST_PATH ||
				p.endsWith(`/${NOTEBOOK_MANIFEST_FILE}`)
			)
				continue;
			newFilesState[p] = `${tEnter.sha}:${tEnter.sha}`;
		}
		await this.saveSyncedState(commitData.sha, newFilesState);
	}

	private mkInput(ph: string, val: string, type = "text") {
		const el = document.createElement("input");
		el.className = "b3-text-field fn__block";
		el.placeholder = ph;
		el.value = val;
		el.type = type;
		return el;
	}

	private handlePushClick() {
		if (this.activeTask === "pull") {
			showMessage(t("action.push"));
			return;
		}
		if (this.activeTask === "push") {
			this.showProgressUI("push");
			return;
		}
		this.pushToGitHub();
	}

	private handlePullClick() {
		if (this.activeTask === "push") {
			showMessage(t("action.pull"));
			return;
		}
		if (this.activeTask === "pull") {
			this.showProgressUI("pull");
			return;
		}
		this.pullFromGitHub();
	}

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

	private updateProgress(percent: number, status: string, details: string) {
		this.lastProgress = { ...this.lastProgress, percent, status, details };
		if (this.currentUI) this.currentUI.update(percent, status, details);
	}

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

	private async saveSyncedState(
		commitSha: string,
		files: Record<string, string>,
	) {
		await this.saveData(SYNCED_STATE_KEY, { commitSha, files });
	}

	private async mergeBeforePush(
		localFiles: FileToSync[],
		remoteMap: Map<string, string>,
		lastCommitSha: string,
	): Promise<MergePlan> {
		const synced = await this.loadSyncedState();
		const syncedFiles = synced?.files || {};
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
		let skippedLarge = 0;

		for (const f of localFiles) {
			const content = await siYuanGetFile(f.siYuanPath);
			if (!content) {
				processed++;
				continue;
			}
			if (content.byteLength > MAX_FILE_BYTES) {
				processed++;
				skippedLarge++;
				continue;
			}
			const localSha = await calculateGitSha(content);
			const remoteSha = remoteMap.get(f.githubPath);
			const syncedRaw = syncedFiles[f.githubPath];

			let localSynced = syncedRaw;
			let remoteSynced = syncedRaw;
			if (syncedRaw && syncedRaw.includes(":")) {
				const parts = syncedRaw.split(":");
				localSynced = parts[0];
				remoteSynced = parts[1];
			}

			if (localSha === remoteSha) {
				plan.toReuse.push({ githubPath: f.githubPath, sha: remoteSha });
			} else if (!remoteSha || !syncedRaw) {
				// Force upload to repair missing state and break the ghost conflict loop
				plan.toUpload.push({
					githubPath: f.githubPath,
					siYuanPath: f.siYuanPath,
				});
			} else if (localSha !== localSynced) {
				if (remoteSha !== remoteSynced)
					plan.conflicted.push({
						githubPath: f.githubPath,
						siYuanPath: f.siYuanPath,
					});
				else
					plan.toUpload.push({
						githubPath: f.githubPath,
						siYuanPath: f.siYuanPath,
					});
			} else if (remoteSha !== remoteSynced) {
				plan.toPull.push({
					githubPath: f.githubPath,
					siYuanPath: f.siYuanPath,
				});
			} else {
				plan.toReuse.push({ githubPath: f.githubPath, sha: remoteSha });
			}

			processed++;
			this.updateProgress(
				5 + Math.round((processed / localFiles.length) * 70),
				`${t("progress.analysis")} : ${processed}/${localFiles.length}`,
				f.siYuanPath,
			);
			if (processed % 5 === 0) await sleep(20);
		}

		const manifestPathSet = new Set([
			PLUGIN_MANIFEST_PATH,
			WIDGET_MANIFEST_PATH,
			THEME_MANIFEST_PATH,
		]);

		for (const [path] of remoteMap) {
			if (
				path.startsWith(SYNC_ROOT) &&
				!localPathSet.has(path) &&
				!manifestPathSet.has(path) &&
				!path.endsWith(`/${NOTEBOOK_MANIFEST_FILE}`)
			) {
				// Use the state ledger to differentiate between a local deletion and a new remote file
				if (syncedFiles[path]) {
					plan.toDelete.push({ githubPath: path });
				} else {
					plan.toPull.push({ githubPath: path, siYuanPath: `/${path}` });
				}
			}
		}
		plan.skippedLarge = skippedLarge;
		return plan;
	}

	private async pushToGitHub() {
		if (!this.config.token) return showMessage(t("msg.configure_plugin"));
		this.activeTask = "push";
		this.lastProgress = {
			percent: 0,
			status: t("progress.analysis"),
			details: "Checking SHAs...",
			finished: false,
			error: false,
			message: "",
		};
		this.showProgressUI("push");

		try {
			const api = new GitHubAPI(
				this.config.token,
				this.config.username,
				this.config.repo,
			);
			const generatedManifestPaths = new Set([
				PLUGIN_MANIFEST_PATH,
				WIDGET_MANIFEST_PATH,
				THEME_MANIFEST_PATH,
			]);
			const localFiles = (await collectDir(`/${SYNC_ROOT}`, SYNC_ROOT)).filter(
				(f) =>
					!generatedManifestPaths.has(f.githubPath) &&
					!f.githubPath.endsWith(`/${NOTEBOOK_MANIFEST_FILE}`),
			);
			const pluginManifest = await generatePluginManifest();
			const manifestSha = await calculateGitSha(pluginManifest.content);
			const widgetManifest = await generateWidgetManifest();
			const widgetManifestSha = await calculateGitSha(widgetManifest.content);
			const themeManifest = await generateThemeManifest();
			const themeManifestSha = await calculateGitSha(themeManifest.content);
			const notebookManifests = await generateNotebookManifests();
			const repoInfo = await (await api.getRepoInfo()).json();
			const branch = repoInfo.default_branch || "main";

			let lastCommitSha: string | null = null;
			let remoteMap = new Map<string, string>();
			const actualRemotePathSet = new Set<string>();
			let refRes = await api.getRef(branch);

			if (!refRes.ok) {
				// Empty repository (no commit yet): the git blobs/trees/commits
				// endpoints all return 409 "Git Repository is empty" until the
				// repo has a first commit. Seed one so the initial push works.
				console.warn(
					"[GitHub Sync] Repository has no commits, seeding an initial commit...",
				);
				const initRes = await api.initEmptyRepo(branch);
				if (!initRes.ok) {
					const initText = await initRes.text();
					console.error(
						"[GitHub Sync] Failed to seed empty repository:",
						initText,
					);
				} else {
					refRes = await api.getRef(branch);
				}
			}

			if (refRes.ok) {
				const refData = await refRes.json();
				lastCommitSha = refData.object.sha;
				const lastCommit = await (await api.getCommit(lastCommitSha)).json();
				const remoteTree = await api.getRemoteTree(lastCommit.tree.sha);
				remoteTree.forEach((item) => {
					if (item.type === "blob") actualRemotePathSet.add(item.path);
				});

				// --- verification block ---
				const verifyNode = remoteTree.find(
					(i: any) =>
						i.type === "blob" &&
						(i.path.endsWith(`/${NOTEBOOK_MANIFEST_FILE}`) ||
							i.path.includes("/enc/")),
				);
				if (verifyNode) {
					const testBlob = await api.downloadBlob(verifyNode.sha);
					if (testBlob && isEncryptedBuffer(testBlob)) {
						try {
							await this.maybeDecrypt(testBlob);
						} catch (e) {
							throw new Error(t("error.bad_password"));
						}
					}
				}
				// -----------------------------------

				remoteTree.forEach((item) => {
					if (item.type === "blob") {
						const orig = this.deobfuscateRemotePath(item.path);
						remoteMap.set(orig, item.sha);
					}
				});
			}

			this.updateProgress(5, t("merge.status"), t("merge.compare"));
			const plan = await this.mergeBeforePush(
				localFiles,
				remoteMap,
				lastCommitSha || "",
			);

			const remoteManifestSha = remoteMap.get(PLUGIN_MANIFEST_PATH);
			const manifestChanged = remoteManifestSha !== manifestSha;
			const remoteWidgetManifestSha = remoteMap.get(WIDGET_MANIFEST_PATH);
			const widgetManifestChanged =
				remoteWidgetManifestSha !== widgetManifestSha;
			const remoteThemeManifestSha = remoteMap.get(THEME_MANIFEST_PATH);
			const themeManifestChanged = remoteThemeManifestSha !== themeManifestSha;
			let notebookManifestsChanged = false;

			for (const nm of notebookManifests) {
				const remoteNMSha = remoteMap.get(nm.githubPath);
				const localNMSha = await calculateGitSha(nm.content);
				if (remoteNMSha !== localNMSha) {
					notebookManifestsChanged = true;
					break;
				}
			}

			for (const pull of plan.toPull) {
				const pullSha = remoteMap.get(pull.githubPath);
				if (pullSha) {
					const remoteContent = await api.downloadBlob(pullSha);
					if (remoteContent)
						await siYuanPutFile(
							pull.siYuanPath,
							await this.maybeDecrypt(remoteContent),
						);
				}
				plan.toReuse.push({
					githubPath: pull.githubPath,
					sha: remoteMap.get(pull.githubPath)!,
				});
			}

			const totalChanges = plan.toUpload.length + plan.toDelete.length;
			if (
				totalChanges === 0 &&
				plan.conflicted.length === 0 &&
				!manifestChanged &&
				!widgetManifestChanged &&
				!themeManifestChanged &&
				!notebookManifestsChanged
			) {
				const newFilesState: Record<string, string> = {};
				for (const r of plan.toReuse) newFilesState[r.githubPath] = r.sha;
				await this.saveSyncedState(lastCommitSha || "", newFilesState);
				const msg = plan.conflicted.length
					? t("msg.no_changes_conflicts").replace(
							"{n}",
							String(plan.conflicted.length),
						)
					: t("msg.no_changes_none");
				this.lastProgress = {
					...this.lastProgress,
					finished: true,
					message: msg,
				};
				if (this.currentUI) this.currentUI.finish(msg);
				return;
			}

			if (!lastCommitSha) {
				if (this.config.showDiff) {
					const ok = await showDiffDialog(plan);
					if (!ok) {
						if (this.currentUI) this.currentUI.destroy();
						this.activeTask = null;
						return;
					}
				}
				await this.pushInitialCommit(
					plan,
					branch,
					pluginManifest,
					widgetManifest,
					themeManifest,
					notebookManifests,
					api,
				);
				return;
			}

			if (this.config.showDiff) {
				const ok = await showDiffDialog(plan);
				if (!ok) {
					if (this.currentUI) this.currentUI.destroy();
					this.activeTask = null;
					return;
				}
			}

			const treeItems: any[] = [];
			const manifestPathSet = new Set<string>([
				PLUGIN_MANIFEST_PATH,
				WIDGET_MANIFEST_PATH,
				THEME_MANIFEST_PATH,
			]);
			notebookManifests.forEach((nm) => manifestPathSet.add(nm.githubPath));

			for (const r of plan.toReuse) {
				const remotePath = manifestPathSet.has(r.githubPath)
					? r.githubPath
					: this.obfuscateRemotePath(r.githubPath);
				treeItems.push({
					path: remotePath,
					mode: "100644",
					type: "blob",
					sha: r.sha,
				});
			}

			const uploadedSummaries: { path: string; content: string }[] = [];
			for (let i = 0; i < plan.toUpload.length; i++) {
				const u = plan.toUpload[i];
				this.updateProgress(
					10 + Math.round((i / plan.toUpload.length) * 75),
					`Upload : ${i + 1}/${plan.toUpload.length}`,
					u.githubPath,
				);
				const content = await siYuanGetFile(u.siYuanPath);
				if (!content) continue;
				const blobRes = await api.createBlob(
					arrayBufferToBase64(await this.maybeEncrypt(content)),
				);

				console.log(
					`[DEBUG] File Blob - path: ${u.githubPath}, ok: ${blobRes.ok}, bodyUsed: ${blobRes.bodyUsed}`,
				);

				if (!blobRes.ok) {
					console.error(
						`[GitHub Sync] Blob failed for ${u.githubPath}:`,
						await blobRes.text(),
					);
					continue;
				}
				const blobData = await blobRes.json();
				const remotePath = manifestPathSet.has(u.githubPath)
					? u.githubPath
					: this.obfuscateRemotePath(u.githubPath);
				treeItems.push({
					path: remotePath,
					mode: "100644",
					type: "blob",
					sha: blobData.sha,
				});
				uploadedSummaries.push({
					path: u.githubPath,
					content: extractTextFromSyFile(content),
				});
			}

			for (const d of plan.toDelete) {
				const remotePath = manifestPathSet.has(d.githubPath)
					? d.githubPath
					: this.obfuscateRemotePath(d.githubPath);

				// GitHub requires the exact format {"type":"blob","sha":null} WITH
				// the null present to delete a file. It also rejects deleting a
				// file that no longer exists in the base tree, so only emit the
				// entry when the path is actually present remotely.
				if (!actualRemotePathSet.has(remotePath)) continue;

				treeItems.push({
					path: remotePath,
					mode: "100644",
					type: "blob",
					sha: null,
				});
				uploadedSummaries.push({
					path: d.githubPath,
					content: t("msg.file_deleted"),
				});
			}

			this.updateProgress(
				90,
				t("progress.upload_plugin_manifest"),
				PLUGIN_MANIFEST_PATH,
			);
			const manifestBlobRes = await api.createBlob(
				arrayBufferToBase64(pluginManifest.content),
			);

			console.log(
				`[DEBUG] Plugin Manifest Blob - ok: ${manifestBlobRes.ok}, bodyUsed: ${manifestBlobRes.bodyUsed}`,
			);

			if (manifestBlobRes.ok) {
				const pluginManifestBlobData = await manifestBlobRes.json();
				treeItems.push({
					path: PLUGIN_MANIFEST_PATH,
					mode: "100644",
					type: "blob",
					sha: pluginManifestBlobData.sha,
				});
			}

			this.updateProgress(
				92,
				t("progress.upload_widget_manifest"),
				WIDGET_MANIFEST_PATH,
			);
			const widgetManifestBlobRes = await api.createBlob(
				arrayBufferToBase64(widgetManifest.content),
			);
			if (widgetManifestBlobRes.ok) {
				const widgetManifestBlobData = await widgetManifestBlobRes.json();
				treeItems.push({
					path: WIDGET_MANIFEST_PATH,
					mode: "100644",
					type: "blob",
					sha: widgetManifestBlobData.sha,
				});
			}

			this.updateProgress(
				94,
				t("progress.upload_theme_manifest"),
				THEME_MANIFEST_PATH,
			);
			const themeManifestBlobRes = await api.createBlob(
				arrayBufferToBase64(themeManifest.content),
			);
			if (themeManifestBlobRes.ok) {
				const themeManifestBlobData = await themeManifestBlobRes.json();
				treeItems.push({
					path: THEME_MANIFEST_PATH,
					mode: "100644",
					type: "blob",
					sha: themeManifestBlobData.sha,
				});
			}

			let notebooksUploaded = 0;
			for (const nm of notebookManifests) {
				this.updateProgress(
					96,
					`Upload manifeste carnet (${++notebooksUploaded}/${notebookManifests.length})...`,
					nm.githubPath,
				);
				// Encrypting notebook manifests to protect names during incremental push
				const nmBlobRes = await api.createBlob(
					arrayBufferToBase64(await this.maybeEncrypt(nm.content)),
				);
				if (nmBlobRes.ok) {
					const nmBlobData = await nmBlobRes.json();
					treeItems.push({
						path: nm.githubPath,
						mode: "100644",
						type: "blob",
						sha: nmBlobData.sha,
					});
				}
			}

			this.updateProgress(
				98,
				t("progress.finalizing"),
				t("progress.creating_tree"),
			);
			const baseTreeRes = await api.getCommit(lastCommitSha);
			const baseTreeData = await baseTreeRes.json();
			let currentTreeSha = baseTreeData.tree.sha;

			// Deduplicate entries by path (a generated manifest and a stray local
			// file can otherwise collide and make Git RPC fail with BadObjectState)
			const treeMap = new Map<string, any>();
			for (const t of treeItems) treeMap.set(t.path, t);
			const dedupedTreeItems = [...treeMap.values()];

			for (let i = 0; i < dedupedTreeItems.length; i += CHUNK_SIZE) {
				const chunk = dedupedTreeItems.slice(i, i + CHUNK_SIZE);
				const treeRes = await api.createTree(currentTreeSha, chunk);

				console.log(
					`[DEBUG] Tree Creation - ok: ${treeRes.ok}, bodyUsed: ${treeRes.bodyUsed}`,
				);

				if (!treeRes.ok) {
					const errText = await treeRes.text();
					throw new Error(
						`[GitHub Sync] Tree creation failed (Chunk ${Math.floor(i / CHUNK_SIZE) + 1}): ${treeRes.statusText} - ${errText}`,
					);
				}
				const treeData = await treeRes.json();
				currentTreeSha = treeData.sha;
			}

			const aiMsg = await generateCommitMessage(
				this.config.groqKey,
				uploadedSummaries,
			);
			const commitMsg =
				aiMsg ||
				`Sync : +${plan.toUpload.length}, ~${plan.toReuse.length}, -${plan.toDelete.length},  ${plan.toPull.length} pull(s)`;

			const commitRes = await api.createCommit(commitMsg, currentTreeSha, [
				lastCommitSha,
			]);

			console.log(
				`[DEBUG] Commit Creation - ok: ${commitRes.ok}, bodyUsed: ${commitRes.bodyUsed}`,
			);

			if (!commitRes.ok) {
				const errText = await commitRes.text();
				throw new Error(
					`[GitHub Sync] Commit failed: ${commitRes.statusText} - ${errText}`,
				);
			}
			const commitData = await commitRes.json();

			refRes = await api.updateRef(branch, commitData.sha);
			if (!refRes.ok) {
				const errText = await refRes.text();
				throw new Error(
					`[GitHub Sync] Ref update failed: ${refRes.statusText} - ${errText}`,
				);
			}

			const oldState = await this.loadSyncedState();
			const oldSyncedFiles = oldState?.files || {};

			const newFilesState: Record<string, string> = {};
			for (const r of plan.toReuse) {
				newFilesState[r.githubPath] = oldSyncedFiles[r.githubPath] || r.sha;
			}
			for (const u of plan.toUpload) {
				const expectedPath = manifestPathSet.has(u.githubPath)
					? u.githubPath
					: this.obfuscateRemotePath(u.githubPath);

				const uploadedSha = treeItems.find((t) => t.path === expectedPath)?.sha;
				if (uploadedSha) {
					const content = await siYuanGetFile(u.siYuanPath);
					const ptSha = content ? await calculateGitSha(content) : uploadedSha;
					newFilesState[u.githubPath] = `${ptSha}:${uploadedSha}`;
				}
			}
			await this.saveSyncedState(commitData.sha, newFilesState);

			const parts: string[] = [];
			if (plan.toUpload.length)
				parts.push(`${plan.toUpload.length} ${t("stat.sent")}`);
			if (plan.toPull.length)
				parts.push(`${plan.toPull.length} ${t("stat.pulled")}`);
			if (plan.toDelete.length)
				parts.push(`${plan.toDelete.length} ${t("stat.deleted")}`);
			if (plan.toReuse.length)
				parts.push(`${plan.toReuse.length} ${t("stat.unchanged")}`);

			let msg = `${t("msg.push_done_prefix")} ${parts.join(", ")}.`;
			if (plan.skippedLarge)
				msg += `   ${plan.skippedLarge} ${t("msg.skipped_files")}`;
			if (plan.conflicted.length) {
				const conflictNote = t("msg.conflicts_unresolved").replace(
					"{n}",
					String(plan.conflicted.length),
				);
				msg += conflictNote;
			}

			this.lastProgress = {
				...this.lastProgress,
				finished: true,
				message: msg,
			};
			if (this.currentUI) this.currentUI.finish(msg);
			await this.saveSyncTimestamp();
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

	private async pushInitialCommit(
		plan: MergePlan,
		branch: string,
		pluginManifest: ManifestFile,
		widgetManifest: ManifestFile,
		themeManifest: ManifestFile,
		notebookManifests: ManifestFile[],
		api: GitHubAPI,
	) {
		let uploaded = 0;
		const total = plan.toUpload.length;
		let errors = 0;
		const errorBodies: string[] = [];
		const treeItems: any[] = [];
		const manifestPathSet = new Set<string>([
			PLUGIN_MANIFEST_PATH,
			WIDGET_MANIFEST_PATH,
			THEME_MANIFEST_PATH,
		]);
		notebookManifests.forEach((nm) => manifestPathSet.add(nm.githubPath));

		for (const u of plan.toUpload) {
			this.updateProgress(
				10 + Math.round((uploaded / Math.max(total, 1)) * 80),
				`Upload : ${uploaded + 1}/${total}`,
				u.githubPath,
			);
			const content = await siYuanGetFile(u.siYuanPath);
			if (!content) continue;
			const blobRes = await api.createBlob(
				arrayBufferToBase64(await this.maybeEncrypt(content)),
			);

			if (blobRes.ok) {
				const blobData = await blobRes.json();
				const remotePath = manifestPathSet.has(u.githubPath)
					? u.githubPath
					: this.obfuscateRemotePath(u.githubPath);
				treeItems.push({
					path: remotePath,
					mode: "100644",
					type: "blob",
					sha: blobData.sha,
				});
							uploaded++;
			} else {
				const errBody = await blobRes.text();
				console.error(
					`[GitHub Sync] Blob failed for ${u.githubPath}: ${blobRes.status} ${errBody}`,
				);
				errorBodies.push(errBody);
				errors++;
			}
		}

		for (const m of [pluginManifest, widgetManifest, themeManifest]) {
			let content = m.content;
			const mRes = await api.createBlob(arrayBufferToBase64(content));
			if (mRes.ok) {
				const mData = await mRes.json();
				treeItems.push({
					path: m.githubPath,
					mode: "100644",
					type: "blob",
					sha: mData.sha,
				});
			} else {
				const errBody = await mRes.text();
				console.error(
					`[GitHub Sync] Manifest Blob failed for ${m.githubPath}: ${mRes.status} ${errBody}`,
				);
				errorBodies.push(errBody);
				errors++;
			}
		}

		for (const m of notebookManifests) {
			// Protect notebook titles strictly
			const mRes = await api.createBlob(
				arrayBufferToBase64(await this.maybeEncrypt(m.content)),
			);
			if (mRes.ok) {
				const mData = await mRes.json();
				treeItems.push({
					path: m.githubPath,
					mode: "100644",
					type: "blob",
					sha: mData.sha,
				});
			} else {
				const errBody = await mRes.text();
				console.error(
					`[GitHub Sync] Notebook Blob failed for ${m.githubPath}: ${mRes.status} ${errBody}`,
				);
				errorBodies.push(errBody);
				errors++;
			}
		}

		if (treeItems.length > 0) {
			this.updateProgress(
				95,
				t("progress.finalizing"),
				t("progress.creating_tree"),
			);
			await sleep(2000);
			let currentTreeSha = "";

			for (let i = 0; i < treeItems.length; i += CHUNK_SIZE) {
				const chunk = treeItems.slice(i, i + CHUNK_SIZE);
				let treeRes: Response | undefined;
				let attempts = 0;
				const maxAttempts = 5;
				while (attempts < maxAttempts) {
					treeRes = await api.createTree(currentTreeSha, chunk);
					if (treeRes.ok) break;
					if (treeRes.status >= 500) {
						attempts++;
						const delay = attempts * 5000;
						await sleep(delay);
					} else {
						break;
					}
				}
				if (!treeRes || !treeRes.ok) {
					const errText = (await treeRes?.text()) || "Unknown API Error";
					throw new Error(
						`[GitHub Sync] Tree creation failed (Chunk ${Math.floor(i / CHUNK_SIZE) + 1}): ${treeRes?.statusText} - ${errText}`,
					);
				}
				const treeData = await treeRes.json();
				currentTreeSha = treeData.sha;
				await sleep(2000);
			}

			const commitRes = await api.createCommit("Sync init", currentTreeSha, []);
			if (!commitRes.ok) {
				const errText = await commitRes.text();
				throw new Error(
					`[GitHub Sync] Initial commit failed: ${commitRes.statusText} - ${errText}`,
				);
			}
			const commitData = await commitRes.json();
			const refRes = await api.updateRef(branch, commitData.sha);
			if (!refRes.ok) {
				const errText = await refRes.text();
				throw new Error(
					`[GitHub Sync] Initial ref update failed: ${refRes.statusText} - ${errText}`,
				);
			}

			const newFilesState: Record<string, string> = {};
			treeItems.forEach((item) => {
				const originalPath = this.deobfuscateRemotePath(item.path);
				newFilesState[originalPath] = item.sha;
			});
			await this.saveSyncedState(commitData.sha, newFilesState);
		}

		let msg = t("msg.push_initial_done").replace("{n}", String(uploaded));
		if (errors > 0) {
			msg += " ⚠️ " + errors + " erreur(s).";
			if (errorBodies.length > 0) {
				msg += " Premier problème : " + errorBodies[0].slice(0, 300);
			}
		}
		this.lastProgress = { ...this.lastProgress, finished: true, message: msg };

		await this.saveSyncTimestamp();

		if (this.currentUI) this.currentUI.finish(msg);
	}

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

			// Batch optimizer
			// 1. Pre-filter files to find exactly what needs downloading (Runs instantly in memory)
			const toPull = [];
			for (let i = 0; i < remoteItems.length; i++) {
				const item = remoteItems[i];

				// Extract the plaintext path to ensure state ledger parity
				let originalPath = item.path;
				if (item.path.startsWith(`${SYNC_ROOT}/enc/`)) {
					originalPath = this.deobfuscateRemotePath(item.path);
				}

				let siPath = `/${originalPath}`;

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
								throw new Error(t("error.pull_verification_failed"));
							}
						}
					}),
				);

				await sleep(30);
			}

			try {
				await processNotebookManifests(remoteItems, api, (buf) =>
					this.maybeDecrypt(buf),
				);
			} catch {
				/* ignore */
			}

			// 3. Process Plugins, Widgets, and Themes manifest files
			const onProgress = (pct: number, status: string, details: string) => this.updateProgress(pct, status, details);

			const manifestItem = remoteItems.find(i => i.path === PLUGIN_MANIFEST_PATH);
			if (manifestItem) {
				const manifestContent = await api.downloadBlob(manifestItem.sha);
				if (manifestContent) {
					try {
						const manifest = JSON.parse(new TextDecoder().decode(await this.maybeDecrypt(manifestContent)));
						pluginsInstalled = await installMissingPlugins(manifest, onProgress);
					} catch { /* ignore */ }
				}
			}

			const widgetManifestItem = remoteItems.find(i => i.path === WIDGET_MANIFEST_PATH);
			if (widgetManifestItem) {
				const widgetManifestContent = await api.downloadBlob(widgetManifestItem.sha);
				if (widgetManifestContent) {
					try {
						const wManifest = JSON.parse(new TextDecoder().decode(await this.maybeDecrypt(widgetManifestContent)));
						widgetsInstalled = await installMissingWidgets(wManifest, onProgress);
					} catch { /* ignore */ }
				}
			}

			const themeManifestItem = remoteItems.find(i => i.path === THEME_MANIFEST_PATH);
			if (themeManifestItem) {
				const themeManifestContent = await api.downloadBlob(themeManifestItem.sha);
				if (themeManifestContent) {
					try {
						const tManifest = JSON.parse(new TextDecoder().decode(await this.maybeDecrypt(themeManifestContent)));
						themesInstalled = await installMissingThemes(tManifest, onProgress);
					} catch { /* ignore */ }
				}
			}

			// 4. Remove local files that no longer exist on the remote
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
				if (remotePlainSet.has(localPath)) continue;

				const lower = localPath.toLowerCase();
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
				if (localPath.startsWith(`${SYNC_ROOT}/plugins/`)) continue;

				this.updateProgress(
					90,
					`Pull : delete`,
					localPath,
				);

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

			if (deleted > 0 || stateUpdated) {
				await siYuanRefreshFiletree();
			}

			let finishMsg = "Pull complete. Reloading...";

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
			let siPath = `/${item.path}`;
			if (item.path.startsWith(`${SYNC_ROOT}/enc/`)) {
				siPath = `/${this.deobfuscateRemotePath(item.path)}`;
			}

			if (siPath.endsWith(`/${NOTEBOOK_MANIFEST_FILE}`)) {
				continue;
			}

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
					// Ignore and skip
				}
				await sleep(30);
			}
		}
		await siYuanRefreshFiletree();

		try {
			await processNotebookManifests(treeItems, api, (buf) =>
				this.maybeDecrypt(buf),
			);
		} catch {
			/* ignore */
		}

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

	private async handleHistoryClick() {
		if (!this.config.token) return showMessage(t("msg.configure_plugin"));
		new HistoryDialog(
			() => this.getHistory(),
			(sha: string, msg: string) => this.restoreCommit(sha, msg),
		);
	}

	async getHistory(): Promise<any[]> {
		const api = new GitHubAPI(
			this.config.token,
			this.config.username,
			this.config.repo,
		);
		return api.getCommits();
	}
}
