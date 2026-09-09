import { Plugin } from "siyuan";
import { GitPluginConfig, STORAGE_KEY } from "../shared-utils/types";

export class StatusBarUI {
    private statusBarEl: HTMLElement | null = null;

    constructor(
        private plugin: Plugin,
        private config: GitPluginConfig
		) {
			// add UI icons
			plugin.addIcons(
				`<symbol id="iconGitHubUpload" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 13v-4H8l4-4 4 4h-3v4h-2z"/></symbol><symbol id="iconGitHubDownload" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 7v4h3l-4 4-4-4h3V9h2z"/></symbol><symbol id="iconGitHistory" viewBox="0 0 24 24"><path fill="currentColor" d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></symbol>`,
			);
    }

    public attach() {
        const old = document.getElementById("siyuan-github-sync-status");
        if (old) old.remove();

        const tryAttach = (parent: Element) => {
            this.statusBarEl = document.createElement("span");
            this.statusBarEl.id = "siyuan-github-sync-status";
            this.statusBarEl.style.cssText = "font-size:11px;opacity:.65;margin:0 8px;color:var(--b3-theme-on-background);";
            this.update();
            parent.appendChild(this.statusBarEl);
            return true;
        };

        const target = document.querySelector("#statusBar #status") || document.querySelector("#statusBar");
        if (target && tryAttach(target)) return;

        this.statusBarEl = document.createElement("div");
        this.statusBarEl.id = "siyuan-github-sync-status";
        this.statusBarEl.style.cssText = "position:fixed;bottom:0;left:50%;transform:translateX(-50%);z-index:9999;font-size:11px;opacity:.65;pointer-events:none;color:var(--b3-theme-on-background);line-height:24px;";
        this.update();
        document.body.appendChild(this.statusBarEl);
    }

    private update() {
        if (!this.statusBarEl) return;
        const loaded = this.config.lastSync;
        if (loaded) {
            const d = new Date(loaded);
            const hh = String(d.getHours()).padStart(2, "0");
            const mm = String(d.getMinutes()).padStart(2, "0");
            const dd = String(d.getDate()).padStart(2, "0");
            const mo = String(d.getMonth() + 1).padStart(2, "0");
            this.statusBarEl.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px;">🔄 Sync: ${dd}/${mo} ${hh}:${mm}</span>`;
        } else {
            this.statusBarEl.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px;">🔄 Sync: --/--</span>`;
        }
    }

    public async saveTimestamp() {
        this.config.lastSync = Date.now();
        this.update();
        await this.plugin.saveData(STORAGE_KEY, this.config);
    }
}
