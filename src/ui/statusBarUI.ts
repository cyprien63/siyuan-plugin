import { Plugin } from "siyuan";
import { GitPluginConfig, STORAGE_KEY } from "../shared-utils/types";

export class StatusBarUI {
    private statusBarEl: HTMLElement | null = null;

    constructor(
        private plugin: Plugin,
        private config: GitPluginConfig
    ) {}

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
