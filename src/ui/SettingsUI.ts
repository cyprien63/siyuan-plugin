/**
 * Configuration interface manager.
 * Renders the SiYuan settings panel, handles user inputs (credentials, preferences),
 * and routes manual trigger actions (import/export, repository reset).
 */

import { Dialog, showMessage, Setting } from "siyuan";
import { t, availableLocales, setLocale, getLocale } from "../shared-utils/i18n";
import GitHubSyncPlugin from "../index";
import { SyncEngine } from "../engine/SyncEngine";
import { GitPluginConfig, SyncError } from "../shared-utils/types";
import { SyncProgressUI } from "./ProgressUI";

export class SettingsUI {
	constructor(
		private plugin: GitHubSyncPlugin,
		private engine: SyncEngine,
	) {
		this.engine.removeAllListeners()

		this.engine.on(
			"progress",
			(percent: number, status: string, details: string) => {
				this.updateProgressUI(percent, status, details);
			},
		);

		this.engine.on("error", (err: SyncError | string) => {
    const msg = err instanceof SyncError ? err.message : String(err);
    showMessage(msg, 6000, "error");
		});
	}

	private updateProgressUI = (() => {
        // UI Progress bar Instance
        let ui: SyncProgressUI | null = null;

        return (pct: number, status: string, details: string): void => {
            // Instantiate the UI on the first event emission
            if (!ui || ui.isDestroyed) {
                ui = new SyncProgressUI(t("button.reset_repo"), () => {
                    ui = null; // Clean up memory when the dialog closes
                });
            }

            // Route the UI update based on completion percentage
            if (pct >= 100) {
                ui.finish(details, true);
            } else {
                ui.update(pct, status, details);
            }
        };
    })();

	/**
	 * Build the plugin settings page.
	 *
	 * All input elements are captured in closures so the "Save" handler can
	 * read their values without re-querying the DOM. The token and encryption
	 * password fields have a show/hide eye toggle.
	 */
	public registerSettings(): void {
		// Abstract DOM creation for inputs
		const inputFields = {
			username: this.mkInput(t("setting.github_user"), this.plugin.config.username),
			repo: this.mkInput(t("setting.github_repo"), this.plugin.config.repo),
			token: this.mkInput(
				t("setting.github_token"),
				this.plugin.config.token,
				"password",
			),
			groqKey: this.mkInput(
				t("setting.groq_key"),
				this.plugin.config.groqKey,
				"password",
			),
			encryptionPassword: this.mkInput(
				t("setting.encryption_password"),
				this.plugin.config.encryptionPassword || "",
				"password",
			),
			showDiff: this.mkInput(t("setting.show_diff"), this.plugin.config.showDiff ? "true" : "false", "checkbox"),
			language: this.mkSelect(t("setting.language"), this.plugin.config.language || "en"),
			actions: null, // will be populated later

		};

		// Callback that updates the input fields from the config parameter
		// used for the import button to update this UI after importing
		// only the current fields are updated
		// so that only confirmCallback writes to the json config file
		// and a "save" action is required as the only way to save the config
		const updateCurrentFieldsFromNewConfig = (cfg: GitPluginConfig) => {
			inputFields.username.value = cfg.username || "";
			inputFields.repo.value = cfg.repo || "";
			inputFields.token.value = cfg.token || "";
			inputFields.groqKey.value = cfg.groqKey || "";
			inputFields.encryptionPassword.value = cfg.encryptionPassword || "";
			inputFields.showDiff.checked = !!cfg.showDiff;
			inputFields.language.value = cfg.language || "en";
		};

		// populate action buttons
		inputFields.actions = this.populateActionButtons(updateCurrentFieldsFromNewConfig);

		// Dynamic language change callback
		inputFields.language.onchange = () => {
			const newLang = inputFields.language.value;
			try {
				setLocale(newLang);
				showMessage(t("msg.language_changed"), 4000);
				(window as Window).__github_sync_locale = getLocale();
			} catch (err) {
				console.error("[GitHub Sync] Failed to set locale from language selector:", err);
				showMessage(t("msg.language_change_failed"), 6000, "error");
			}
		}

		// define settings object
		this.plugin.setting = new Setting({
			// callback for confirm button click
			confirmCallback: async () => {
				// save the values from the input fields into the plugin config
				this.plugin.config.username = inputFields.username.value.trim();
				this.plugin.config.repo = inputFields.repo.value.trim();
				this.plugin.config.token = inputFields.token.value.trim();
				this.plugin.config.groqKey = inputFields.groqKey.value.trim();
				this.plugin.config.encryptionPassword = inputFields.encryptionPassword.value.trim();
				this.plugin.config.showDiff = inputFields.showDiff.checked;
				this.plugin.config.language = inputFields.language.value;


				await this.plugin.saveData(
					"github-sync-config.json",
					this.plugin.config,
				);
				showMessage(t("msg.saved"));
			},
		});

		// --------------------------------------------
		// items population
		// --------------------------------------------

		// username
		this.plugin.setting.addItem({
				title: t("setting.github_user"),
				createActionElement: () => inputFields.username,
			});

		// repo
		this.plugin.setting.addItem({
				title: t("setting.github_repo"),
				createActionElement: () => inputFields.repo,
			});

		// PAT (+ visibility toggle)
		this.plugin.setting.addItem({
				title: t("setting.github_token"),
				// Wrap the token input to automatically append the visibility toggle
				createActionElement: () => this.wrapWithToggle(inputFields.token),
			});

		// Groq API key (+ visibility toggle)
		this.plugin.setting.addItem({
				title: t("setting.groq_key"),
				// Wrap the token input to automatically append the visibility toggle
				createActionElement: () => this.wrapWithToggle(inputFields.groqKey),
			});

		// encryption password item (+ visibility toggle)
		this.plugin.setting.addItem({
			title: t("setting.encryption_password"),
			createActionElement: () => this.wrapWithToggle(inputFields.encryptionPassword),
		});

		// show diff checkbox
		this.plugin.setting.addItem({
			title: t("setting.show_diff"),
			createActionElement: () => inputFields.showDiff,
		});

		// language select
		this.plugin.setting.addItem({
			title: t("setting.language"),
			createActionElement: () => inputFields.language,
		});

		// action buttons
		this.plugin.setting.addItem({
			title: t("setting.actions"),
			createActionElement: () => inputFields.actions,
		});
	}

	private mkSelect(ph: string, val: string) {
		const el: HTMLSelectElement = document.createElement("select");
		el.className = "b3-select fn__block";
		el.style.cssText = "width:100%;padding:4px 8px;font-size:14px;";
		el.title = ph;
		availableLocales().forEach((lang) => {
			const option = document.createElement("option");
			option.value = lang;
			option.textContent = lang.toUpperCase();
			if (lang === val) option.selected = true;
			el.appendChild(option);
		});
		return el;
	}

	private mkInput(ph: string, val: string, type = "text") {
		const el: HTMLInputElement = document.createElement("input");
		el.type = type;
		el.title = ph;
		switch (type) {
			case "checkbox":
				el.style.cssText = "width:16px;height:16px;cursor:pointer;margin:0;";
				el.checked = val === "true";
				break;
			case "text":
			case "password":
				el.className = "b3-text-field fn__block";
				el.placeholder = ph;
				el.value = val;
				break;
			default:
				throw new Error(`Unsupported input type: ${type}`);
		}
		return el;
		}

	private mkActionButton(label: string, onClick: (btn?: HTMLButtonElement) => void | Promise<void>): HTMLButtonElement {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "b3-button b3-button--outline fn__block";
		//btn.style.cssText = "padding:4px 8px;font-size:14px;";
		btn.textContent = label;

		// assign click handler
		btn.onclick = () => onClick(btn);
		return btn;
	}

	private mkVisibilityToggle(targetInput: HTMLInputElement): HTMLButtonElement {
		// create visibility toggle
		const toggleBtn = document.createElement("button");
		toggleBtn.type = "button";
		toggleBtn.className = "b3-button b3-button--outline";
		toggleBtn.style.cssText = "margin-left:8px;padding:4px 8px;font-size:14px;";
		toggleBtn.textContent = "👁️";

		// visibility toggle handler
		toggleBtn.onclick = () => {
			const isPassword = targetInput.type === "password";
			targetInput.type = isPassword ? "text" : "password";
			toggleBtn.textContent = isPassword ? "🙈" : "👁️";
		};

		return toggleBtn;
	}

	private wrapWithToggle(input: HTMLInputElement): HTMLDivElement {
		// create wrapper and append visibility toggle after the og input
		const wrap = document.createElement("div");
		wrap.style.cssText = "display:flex;gap:8px;align-items:center;width:100%;";
		wrap.appendChild(input);
		wrap.appendChild(this.mkVisibilityToggle(input));
		return wrap;
	}

	private populateActionButtons(onImportComplete: (cfg: GitPluginConfig) => void): HTMLDivElement {
		const buttonsContainer = document.createElement("div");
		buttonsContainer.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
		buttonsContainer.title = t("setting.actions");

		// define button label and click handling logic
		const buttons = {
			testGitHub: this.mkActionButton(t("button.test_github"), async (btn) => {
				btn.disabled = true;
				await this.engine.testGitHubConnection();
				btn.disabled = false;
			}),
			export: this.mkActionButton(t("button.export"), async () => {
				this.engine.exportConfig(this.plugin.config);
			}),
			import: this.mkActionButton(t("button.import"), async () => {
				const newConfig = await this.engine.importConfig(this.plugin.config);
				// scrap invalid config
				if (!newConfig) return;
				// update UI
				onImportComplete(newConfig)
			}),
			emptyRepo: this.mkActionButton(t("button.reset_repo"), async (btn) => {
				btn.disabled = true;
				// define warning dialog in UI
				const dialog = new Dialog({
					title: t("dialog.remove_encryption_title"),
					content: `
            <div class="b3-dialog__content" style="padding:16px;">
                <div style="margin-bottom:12px;line-height:1.7;white-space:pre-wrap;">${t("dialog.remove_encryption_body")}</div>
                <div style="margin-top:16px;padding:12px;background:var(--b3-theme-error-background, rgba(234, 76, 137, 0.1));color:var(--b3-theme-error, #ea4c89);border-radius:4px;font-weight:bold;">
                    ${t("dialog.remove_encryption_warning")}
                </div>
            </div>
            <div class="b3-dialog__action" style="padding:8px 16px;border-top:1px solid var(--b3-border-color);">
                <button id="remove-encryption-confirm" class="b3-button b3-button--outline b3-button--error">${t("button.confirm")}</button>
                <button id="remove-encryption-cancel" class="b3-button b3-button--outline" style="margin-left:8px;">${t("button.close")}</button>
            </div>
        `,
					width: window.innerWidth < 600 ? `${window.innerWidth - 32}px` : "540px",
				});
				this.engine.resetRepoDialog(dialog);
				btn.disabled = false;
			}),
		}

		// populate div with buttons
		for (const btn of Object.values(buttons)) {
			buttonsContainer.appendChild(btn);
		}

		return buttonsContainer;
	}
}
