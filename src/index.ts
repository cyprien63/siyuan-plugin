/**
 * Main plugin entry point.
 * Initializes configurations, UI components (SettingsUI, StatusBarUI),
 * internal state (SyncStateLedger), and the backend orchestrator (SyncEngine),
 * wiring them directly to SiYuan top-bar commands.
 */

import { Plugin, showMessage } from "siyuan";

import { SyncEngine } from "./engine/SyncEngine";
import { SyncStateLedger } from "./engine/SyncStateLedger";
import { CryptoModule } from "./engine/CryptoModule";

import { GitHubAPI } from "./api/Github-api";
import { SiYuanAPI } from "./api/Siyuan-api";

import { SettingsUI } from "./ui/SettingsUI";
import { StatusBarUI } from "./ui/statusBarUI";

import { t, setLocale, getLocale } from "./shared-utils/i18n";
import {
	STORAGE_KEY,
	DEFAULT_CONFIG,
	GitPluginConfig,
	SyncError,
} from "./shared-utils/types";
import { friendlyError } from "./shared-utils/utils";

export default class GitHubSyncPlugin extends Plugin {
	private engine!: SyncEngine;
	private ui!: SettingsUI;
	private ledger!: SyncStateLedger;
	private statusBar!: StatusBarUI;
	public config: GitPluginConfig = { ...DEFAULT_CONFIG };

	async onload() {
		const saved = await this.loadData(STORAGE_KEY);
		if (saved) {
			this.config = { ...DEFAULT_CONFIG, ...saved };
		}

		try {
			setLocale(this.config.language ?? "en");
			(window as Window).__github_sync_locale = getLocale();
		} catch (e) {
			console.error(
				`[GitHub Sync] Failed to load locale '${this.config.language}'`,
				e,
			);
		}

		const siyuan = new SiYuanAPI();
		const api = new GitHubAPI(
			this.config.token,
			this.config.username,
			this.config.repo,
		);
		const crypto = new CryptoModule(this.config);
		this.ledger = new SyncStateLedger(this);
		this.engine = new SyncEngine(api, crypto, this.ledger, this.config, siyuan);

		this.ui = new SettingsUI(this, this.engine);
		this.ui.registerSettings();

		this.statusBar = new StatusBarUI(this, this.config);
		setTimeout(() => this.statusBar.attach(), 1000);

		this.addTopBar({
			icon: "iconGitHubUpload",
			title: t("top.push_title"),
			position: "right",
			callback: async () => {
				try {
					await this.engine.pushToGitHub();
					await this.statusBar.saveTimestamp();
				} catch (err) {
					const msg =
						err instanceof SyncError ? err.message : friendlyError(err);
					showMessage(msg, 6000, "error");
				}
			},
		});

		this.addTopBar({
			icon: "iconGitHubDownload",
			title: t("top.pull_title"),
			position: "right",
			callback: async () => {
				try {
					await this.engine.pullFromGitHub();
					await this.statusBar.saveTimestamp();
				} catch (err) {
					const msg =
						err instanceof SyncError ? err.message : friendlyError(err);
					showMessage(msg, 6000, "error");
				}
			},
		});
	}
}
