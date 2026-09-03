import { Dialog, showMessage, Setting } from "siyuan";
import { t, availableLocales } from "./i18n";
import GitHubSyncPlugin from "./index";
import { SyncEngine } from "./SyncEngine";
import { GitPluginConfig } from "./types";

export class SettingsUI {
	constructor(
		private plugin: GitHubSyncPlugin,
		private engine: SyncEngine,
	) {
		this.engine.on(
			"progress",
			(pct: number, status: string, details: string) => {
				this.updateProgressUI(pct, status, details);
			},
		);

		this.engine.on("error", (err: string) => {
			showMessage(err, 6000, "error");
		});
	}

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
			actions: this.populateActionButtons(),

		};

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

	private updateProgressUI(pct: number, status: string, details: string): void {
		// Manage the SyncProgressUI instance strictly within this domain
		// TODO
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

	private populateActionButtons(): HTMLDivElement {
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
		//TODO
		}

		// populate div with buttons
		for (const btn of Object.values(buttons)) {
			buttonsContainer.appendChild(btn);
		}

		return buttonsContainer;
	}
}
