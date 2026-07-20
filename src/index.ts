import {
    Plugin,
    Setting,
    showMessage,
    getFrontend,
    Dialog,
} from "siyuan";
import "./index.scss";

// ─── Constantes ───────────────────────────────────────────────────────────────

const STORAGE_KEY    = "github-sync-config.json";
const GITHUB_API     = "https://api.github.com";
const SYNC_ROOT      = "data";
const MAX_FILE_BYTES = 25_000_000; // 25 MB

const SKIP_ROOT_DIRS = [
    "plugins", "conf", ".siyuan", "storage", "emojis",
    "public", "templates", "widgets", "siyuan-github-sync",
    "history",
];

const SKIP_PATH_FRAGMENTS = [
    ".git/",
    "/temp/",
];

const LOCKED_EXTENSIONS = [".db", ".db-shm", ".db-wal", ".log", ".lock"];
const SYNCED_STATE_KEY  = "github-sync-state.json";

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface GitHubConfig {
    username: string;
    repo: string;
    token: string;
    groqKey: string;
    showDiff: boolean;
    lastSync?: number;
}

const DEFAULT_CONFIG: GitHubConfig = { username: "", repo: "", token: "", groqKey: "", showDiff: true };

interface SiYuanDirEntry {
    name:    string;
    isDir:   boolean;
    updated: number;
}

interface GitHubTreeItem {
    path: string;
    mode: string;
    type: "blob" | "tree";
    sha:  string;
    size?: number;
}

interface FileToSync {
    siYuanPath: string;
    githubPath: string;
}

interface SyncedState {
    commitSha: string;
    files: Record<string, string>; // githubPath → SHA
}

interface MergePlan {
    toUpload:    { githubPath: string; content: ArrayBuffer }[];
    toReuse:     { githubPath: string; sha: string }[];
    toDelete:    { githubPath: string }[];
    toPull:      { githubPath: string; siYuanPath: string }[];
    conflicted:  { githubPath: string; siYuanPath: string }[];
}

// ─── Utilitaires ─────────────────────────────────────────────────────────────

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let bin = "";
    const CHUNK = 8192;
    for (let i = 0; i < bytes.byteLength; i += CHUNK) {
        bin += String.fromCharCode(...(bytes.subarray(i, i + CHUNK) as unknown as number[]));
    }
    return btoa(bin);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
    const bin   = atob(b64.replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}

/** Calcule le SHA-1 d'un blob Git (format: "blob [size]\0[content]") */
async function calculateGitSha(content: ArrayBuffer): Promise<string> {
    const header = new TextEncoder().encode(`blob ${content.byteLength}\0`);
    const combined = new Uint8Array(header.length + content.byteLength);
    combined.set(header);
    combined.set(new Uint8Array(content), header.length);
    const hashBuffer = await crypto.subtle.digest("SHA-1", combined);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

function encodePath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
}

function friendlyError(err: unknown): string {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (msg.includes("bad credentials") || msg.includes("401") || msg.includes("token")) return "❌ Token GitHub invalide ou expiré. Va dans Paramètres → génère un nouveau token.";
    if (msg.includes("not found") || msg.includes("404")) return "❌ Dépôt GitHub introuvable. Vérifie le nom du dépôt dans Paramètres.";
    if (msg.includes("networkerror") || msg.includes("failed to fetch") || msg.includes("network")) return "❌ Pas de connexion internet. Vérifie ta connexion.";
    if (msg.includes("rate limit") || msg.includes("403")) return "❌ Limite d'appels API GitHub atteinte. Réessaie dans 1 minute.";
    if (msg.includes("aborted") || msg.includes("timeout")) return "❌ Requête annulée (timeout). Réessaie.";
    if (msg.includes("size") || msg.includes("large")) return "❌ Fichier trop volumineux (>25 Mo). Ignoré.";
    return `❌ ${err instanceof Error ? err.message : String(err)}`;
}

// ─── UI de Progression ────────────────────────────────────────────────────────

class SyncProgressUI {
    private dialog: Dialog;
    private barElement: HTMLElement;
    private statusElement: HTMLElement;
    private detailsElement: HTMLElement;
    public isDestroyed = false;

    constructor(title: string, onClosed: () => void) {
        this.dialog = new Dialog({
            title,
            content: `
                <div class="b3-dialog__content" style="padding: 24px;">
                    <div id="sync-status" style="font-weight: bold; margin-bottom: 12px; color: var(--b3-theme-on-background);">Initialisation...</div>
                    <div style="height: 12px; background: var(--b3-border-color); border-radius: 6px; overflow: hidden; margin-bottom: 12px;">
                        <div id="sync-bar" style="width: 0%; height: 100%; background: var(--b3-theme-primary); transition: width 0.3s ease;"></div>
                    </div>
                    <div id="sync-details" style="font-size: 11px; opacity: 0.7; line-height: 1.4; word-break: break-all; min-height: 32px; font-family: monospace;">
                        Vérification des fichiers...
                    </div>
                </div>
            `,
            width: window.innerWidth < 600 ? `${window.innerWidth - 32}px` : "500px",
            destroyCallback: () => {
                this.isDestroyed = true;
                onClosed();
            }
        });
        this.statusElement  = this.dialog.element.querySelector("#sync-status");
        this.barElement     = this.dialog.element.querySelector("#sync-bar");
        this.detailsElement = this.dialog.element.querySelector("#sync-details");
    }

    update(percent: number, status: string, details: string) {
        if (this.isDestroyed) return;
        if (this.statusElement)  this.statusElement.textContent  = status;
        if (this.barElement)     this.barElement.style.width    = `${percent}%`;
        if (this.detailsElement) this.detailsElement.textContent = details;
    }

    finish(message: string) {
        if (this.isDestroyed) return;
        this.update(100, "✅ Terminé", message);
        const content = this.dialog.element.querySelector(".b3-dialog__content");
        if (content && !content.querySelector(".b3-dialog__action")) {
            const footer = document.createElement("div");
            footer.className = "b3-dialog__action";
            footer.style.marginTop = "16px";
            footer.innerHTML = `<button class="b3-button b3-button--outline">Fermer</button>`;
            (footer.querySelector(".b3-button--outline") as HTMLElement).onclick = () => this.dialog.destroy();
            content.appendChild(footer);
        }
    }

    error(message: string) {
        if (this.isDestroyed) return;
        this.update(100, "❌ Erreur", message);
        if (this.barElement) this.barElement.style.background = "var(--b3-theme-error)";
    }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class GitHubSyncPlugin extends Plugin {
    private config: GitHubConfig = { ...DEFAULT_CONFIG };
    private activeTask: "push" | "pull" | null = null;
    private currentUI: SyncProgressUI | null = null;
    private lastProgress = { percent: 0, status: "Initialisation...", details: "", finished: false, error: false, message: "" };
    private statusBarEl: HTMLElement | null = null;
    async onload() {
        this.addIcons(`<symbol id="iconGitHubUpload" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 13v-4H8l4-4 4 4h-3v4h-2z"/></symbol><symbol id="iconGitHubDownload" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 7v4h3l-4 4-4-4h3V9h2z"/></symbol><symbol id="iconGitHistory" viewBox="0 0 24 24"><path fill="currentColor" d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></symbol>`);
        const saved = await this.loadData(STORAGE_KEY);
        if (saved) this.config = { ...DEFAULT_CONFIG, ...saved };
        this.registerSettings();
        this.addTopBar({ icon: "iconGitHubUpload", title: "Smart Push (Incrémental)", position: "right", callback: () => this.handlePushClick() });
        this.addTopBar({ icon: "iconGitHubDownload", title: "Smart Pull (Incrémental)", position: "right", callback: () => this.handlePullClick() });
        this.addTopBar({ icon: "iconGitHistory", title: "📜 Historique des commits", position: "right", callback: () => this.handleHistoryClick() });
        setTimeout(() => this.attachToStatusBar(), 1000);
    }

    private attachToStatusBar() {
        const old = document.getElementById("siyuan-github-sync-status");
        if (old) old.remove();

        const tryAttach = (parent: Element) => {
            this.statusBarEl = document.createElement("span");
            this.statusBarEl.id = "siyuan-github-sync-status";
            this.statusBarEl.style.cssText = "font-size:11px;opacity:.65;margin:0 8px;color:var(--b3-theme-on-background);";
            this.updateStatusBar();
            parent.appendChild(this.statusBarEl);
            return true;
        };

        const target = document.querySelector("#statusBar #status") || document.querySelector("#statusBar");
        if (target && tryAttach(target)) return;

        this.statusBarEl = document.createElement("div");
        this.statusBarEl.id = "siyuan-github-sync-status";
        this.statusBarEl.style.cssText = "position:fixed;bottom:0;left:50%;transform:translateX(-50%);z-index:9999;font-size:11px;opacity:.65;pointer-events:none;color:var(--b3-theme-on-background);line-height:24px;";
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
            const mo = String(d.getMonth()+1).padStart(2, "0");
            this.statusBarEl.textContent = `☁️ ${dd}/${mo} ${hh}:${mm}`;
        } else {
            this.statusBarEl.textContent = "☁️ Sync";
        }
    }

    private async saveSyncTimestamp() {
        this.config.lastSync = Date.now();
        this.updateStatusBar();
        await this.saveData(STORAGE_KEY, this.config);
    }

    private registerSettings() {
        const uIn = this.mkInput("Utilisateur", this.config.username);
        const rIn = this.mkInput("Dépôt", this.config.repo);
        const tIn = this.mkInput("Token GitHub", this.config.token, "password");
        const gIn = this.mkInput("Clé API Groq (optionnel)", this.config.groqKey, "password");
        const dIn = document.createElement("input");
        dIn.type = "checkbox";
        dIn.checked = this.config.showDiff;
        dIn.style.cssText = "width:16px;height:16px;cursor:pointer;margin:0;";
        const tBtn = document.createElement("button");
        tBtn.className = "b3-button b3-button--outline fn__block";
        tBtn.textContent = "🔍 Tester GitHub";
        tBtn.onclick = async () => {
            tBtn.disabled = true;
            if (await this.testConnection(uIn.value, rIn.value, tIn.value)) showMessage("✅ OK"); else showMessage("❌ Erreur", 6000, "error");
            tBtn.disabled = false;
        };

        const eBtn = document.createElement("button");
        eBtn.className = "b3-button b3-button--outline fn__block";
        eBtn.textContent = "📤 Exporter";
        eBtn.onclick = () => {
            const cfg = { username: uIn.value.trim(), repo: rIn.value.trim(), token: tIn.value.trim(), groqKey: gIn.value.trim(), showDiff: dIn.checked };
            const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "siyuan-github-sync-config.json";
            a.click();
            URL.revokeObjectURL(a.href);
            showMessage("✅ Config exportée");
        };

        const iBtn = document.createElement("button");
        iBtn.className = "b3-button b3-button--outline fn__block";
        iBtn.textContent = "📥 Importer";
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
                    if (!data.username || !data.repo || !data.token) { showMessage("❌ Fichier invalide", 6000, "error"); return; }
                    uIn.value = data.username; rIn.value = data.repo; tIn.value = data.token;
                    gIn.value = data.groqKey || ""; dIn.checked = !!data.showDiff;
                    showMessage("✅ Config chargée. Appuie sur Enregistrer.");
                } catch { showMessage("❌ Fichier invalide", 6000, "error"); }
            };
            fi.click();
        };

        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
        btnRow.appendChild(tBtn); btnRow.appendChild(eBtn); btnRow.appendChild(iBtn);
        this.setting = new Setting({
            confirmCallback: async () => {
                this.config = { username: uIn.value.trim(), repo: rIn.value.trim(), token: tIn.value.trim(), groqKey: gIn.value.trim(), showDiff: dIn.checked };
                await this.saveData(STORAGE_KEY, this.config);
                showMessage("✅ Enregistré");
            }
        });
        this.setting.addItem({ title: "GitHub Utilisateur", createActionElement: () => uIn });
        this.setting.addItem({ title: "GitHub Dépôt", createActionElement: () => rIn });
        this.setting.addItem({ title: "GitHub Token PAT", createActionElement: () => tIn });
        this.setting.addItem({ title: "Clé API Groq (optionnel)", createActionElement: () => gIn });
        this.setting.addItem({ title: "Afficher le diff avant push", createActionElement: () => dIn });
        this.setting.addItem({ title: "Actions", createActionElement: () => btnRow });
    }

    private mkInput(ph: string, val: string, type = "text") {
        const el = document.createElement("input");
        el.className = "b3-text-field fn__block";
        el.placeholder = ph; el.value = val; el.type = type;
        return el;
    }

    private async testConnection(u: string, r: string, t: string) {
        try {
            const res = await fetch(`${GITHUB_API}/repos/${u}/${r}`, { headers: { Authorization: `Bearer ${t}`, Accept: "application/vnd.github+json" } });
            return res.status === 200;
        } catch { return false; }
    }

    // ── Actions UI ───────────────────────────────────────────────────────────

    private handlePushClick() {
        if (this.activeTask === "pull") { showMessage("⚠️ Pull en cours..."); return; }
        if (this.activeTask === "push") { this.showProgressUI("push"); return; }
        this.pushToGitHub();
    }

    private handlePullClick() {
        if (this.activeTask === "push") { showMessage("⚠️ Push en cours..."); return; }
        if (this.activeTask === "pull") { this.showProgressUI("pull"); return; }
        this.pullFromGitHub();
    }

    private showProgressUI(type: "push" | "pull") {
        if (this.currentUI && !this.currentUI.isDestroyed) return;
        this.currentUI = new SyncProgressUI(type === "push" ? "⏫ Smart Push (Incrémental)" : "⏬ Smart Pull (Incrémental)", () => { this.currentUI = null; });
        if (this.lastProgress.finished) {
            if (this.lastProgress.error) this.currentUI.error(this.lastProgress.message);
            else this.currentUI.finish(this.lastProgress.message, type === "pull");
        } else {
            this.currentUI.update(this.lastProgress.percent, this.lastProgress.status, this.lastProgress.details);
        }
    }

    private updateProgress(percent: number, status: string, details: string) {
        this.lastProgress = { ...this.lastProgress, percent, status, details };
        if (this.currentUI) this.currentUI.update(percent, status, details);
    }

    // ── SiYuan APIs ──────────────────────────────────────────────────────────

    private async siYuanReadDir(path: string): Promise<SiYuanDirEntry[]> {
        try {
            const res = await fetch("/api/file/readDir", { method: "POST", body: JSON.stringify({ path }) });
            const json = await res.json();
            return (json.code === 0 && json.data) ? json.data : [];
        } catch { return []; }
    }

    private async siYuanGetFile(path: string): Promise<ArrayBuffer | null> {
        try {
            const res = await fetch("/api/file/getFile", { method: "POST", body: JSON.stringify({ path }) });
            return res.ok ? res.arrayBuffer() : null;
        } catch { return null; }
    }

    private async siYuanPutFile(path: string, content: ArrayBuffer): Promise<boolean> {
        try {
            const fd = new FormData();
            fd.append("path", path);
            fd.append("file", new Blob([content]));
            const res = await fetch("/api/file/putFile", { method: "POST", body: fd });
            const json = await res.json();
            return json.code === 0;
        } catch { return false; }
    }

    private async siYuanRefreshFiletree(): Promise<boolean> {
        try {
            const res = await fetch("/api/filetree/refreshFiletree", { method: "POST", body: "{}" });
            const json = await res.json();
            return json.code === 0;
        } catch { return false; }
    }

    private async collectDir(siBase: string, ghBase: string): Promise<FileToSync[]> {
        const entries = await this.siYuanReadDir(siBase);
        const files: FileToSync[] = [];
        for (const e of entries) {
            const sp = siBase === "/" ? `/${e.name}` : `${siBase}/${e.name}`;
            const gp = ghBase ? `${ghBase}/${e.name}` : e.name;
            if (SKIP_ROOT_DIRS.includes(e.name)) continue;
            if (SKIP_PATH_FRAGMENTS.some(f => sp.includes(f))) continue;
            if (e.isDir) files.push(...await this.collectDir(sp, gp));
            else files.push({ siYuanPath: sp, githubPath: gp });
        }
        return files;
    }

    // ── GitHub APIs ──────────────────────────────────────────────────────────

    private async gh(path: string, method = "GET", body?: object) {
        return fetch(`${GITHUB_API}${path}`, {
            method,
            headers: { Authorization: `Bearer ${this.config.token}`, "Content-Type": "application/json", Accept: "application/vnd.github+json" },
            body: body ? JSON.stringify(body) : undefined
        });
    }

    /** Récupère TOUT l'arbre distant de manière efficace */
    private async getRemoteTree(treeSha: string): Promise<GitHubTreeItem[]> {
        const res = await this.gh(`/repos/${this.config.username}/${this.config.repo}/git/trees/${treeSha}?recursive=1`);
        const data = await res.json();
        return (data.tree || []) as GitHubTreeItem[];
    }

    // ── SMART DELTA SYNC ─────────────────────────────────────────────────────

    private async loadSyncedState(): Promise<SyncedState | null> {
        try {
            const data = await this.loadData(SYNCED_STATE_KEY);
            return data || null;
        } catch { return null; }
    }

    private async saveSyncedState(commitSha: string, files: Record<string, string>) {
        await this.saveData(SYNCED_STATE_KEY, { commitSha, files });
    }

    private async ghDownloadFile(path: string, ref?: string): Promise<ArrayBuffer | null> {
        try {
            const url = `/repos/${this.config.username}/${this.config.repo}/contents/${encodePath(path)}` + (ref ? `?ref=${ref}` : "");
            const res = await this.gh(url);
            if (!res.ok) return null;
            const data = await res.json();
            if (!data.content) return null;
            return base64ToArrayBuffer(data.content);
        } catch { return null; }
    }

    private async mergeBeforePush(
        localFiles: FileToSync[],
        remoteMap: Map<string, string>,
        lastCommitSha: string,
    ): Promise<MergePlan> {
        const synced = await this.loadSyncedState();
        const syncedFiles = synced?.files || {};
        const plan: MergePlan = { toUpload: [], toReuse: [], toDelete: [], toPull: [], conflicted: [] };

        const localPathSet = new Set(localFiles.map(f => f.githubPath));
        let processed = 0;

        for (const f of localFiles) {
            const content = await this.siYuanGetFile(f.siYuanPath);
            if (!content || content.byteLength > MAX_FILE_BYTES) { processed++; continue; }

            const localSha = await calculateGitSha(content);
            const remoteSha = remoteMap.get(f.githubPath);
            const syncedSha = syncedFiles[f.githubPath];

            if (localSha === remoteSha) {
                plan.toReuse.push({ githubPath: f.githubPath, sha: remoteSha });
            } else if (!remoteSha) {
                plan.toUpload.push({ githubPath: f.githubPath, content });
            } else if (!syncedSha || localSha !== syncedSha) {
                if (remoteSha !== syncedSha) {
                    plan.conflicted.push({ githubPath: f.githubPath, siYuanPath: f.siYuanPath });
                }
                plan.toUpload.push({ githubPath: f.githubPath, content });
            } else {
                plan.toPull.push({ githubPath: f.githubPath, siYuanPath: f.siYuanPath });
            }

            processed++;
            this.updateProgress(
                5 + Math.round((processed / localFiles.length) * 70),
                `Analyse : ${processed}/${localFiles.length}`,
                f.siYuanPath
            );
            if (processed % 5 === 0) await sleep(20);
        }

        for (const [path] of remoteMap) {
            if (path.startsWith(SYNC_ROOT) && !localPathSet.has(path)) {
                plan.toDelete.push({ githubPath: path });
            }
        }

        return plan;
    }

    private showDiffDialog(plan: MergePlan): Promise<boolean> {
        return new Promise(resolve => {
            const lines: string[] = [];
            if (plan.toUpload.length > 0) {
                lines.push(`<div style="margin:6px 0;font-weight:bold;color:var(--b3-theme-primary);">🆕 ${plan.toUpload.length} fichier(s) à envoyer</div>`);
                for (const u of plan.toUpload.slice(0, 20)) {
                    lines.push(`<div style="padding:2px 8px;font-size:12px;font-family:monospace;">+ ${u.githubPath}</div>`);
                }
                if (plan.toUpload.length > 20) lines.push(`<div style="padding:2px 8px;font-size:11px;opacity:.6;">… et ${plan.toUpload.length - 20} autre(s)</div>`);
            }
            if (plan.toDelete.length > 0) {
                lines.push(`<div style="margin:6px 0;font-weight:bold;color:#f44336;">🗑️ ${plan.toDelete.length} fichier(s) à supprimer</div>`);
                for (const d of plan.toDelete.slice(0, 20)) {
                    lines.push(`<div style="padding:2px 8px;font-size:12px;font-family:monospace;">- ${d.githubPath}</div>`);
                }
                if (plan.toDelete.length > 20) lines.push(`<div style="padding:2px 8px;font-size:11px;opacity:.6;">… et ${plan.toDelete.length - 20} autre(s)</div>`);
            }
            if (plan.toReuse.length > 0) {
                lines.push(`<div style="margin:6px 0;font-weight:bold;color:#4caf50;">✅ ${plan.toReuse.length} fichier(s) inchangé(s)</div>`);
            }
            if (plan.conflicted.length > 0) {
                lines.push(`<div style="margin:6px 0;font-weight:bold;color:#ff9800;">⚠️ ${plan.conflicted.length} conflit(s) (priorité locale)</div>`);
            }
            const dialog = new Dialog({
                title: "📋 Résumé avant envoi",
                content: `
                    <div class="b3-dialog__content" style="padding:16px;max-height:360px;overflow-y:auto;">
                        ${lines.join("") || "<div style='opacity:.6;'>Aucun changement détecté</div>"}
                    </div>
                    <div class="b3-dialog__action" style="padding:8px 16px;border-top:1px solid var(--b3-border-color);">
                        <button id="diff-confirm" class="b3-button b3-button--info">✅ Envoyer</button>
                        <button id="diff-cancel" class="b3-button b3-button--outline" style="margin-left:8px;">❌ Annuler</button>
                    </div>
                `,
                width: window.innerWidth < 600 ? `${window.innerWidth - 32}px` : "520px",
                destroyCallback: () => resolve(false),
            });
            dialog.element.querySelector("#diff-confirm")?.addEventListener("click", () => { dialog.destroy(); resolve(true); });
            dialog.element.querySelector("#diff-cancel")?.addEventListener("click", () => { dialog.destroy(); resolve(false); });
        });
    }

    private async pushToGitHub() {
        if (!this.config.token) return showMessage("⚠️ Configurez le plugin.");
        this.activeTask = "push";
        this.lastProgress = { percent: 0, status: "Analyse...", details: "Comparaison des SHAs...", finished: false, error: false, message: "" };
        this.showProgressUI("push");

        try {
            const localFiles = await this.collectDir("/", SYNC_ROOT);
            const repoInfo = await (await this.gh(`/repos/${this.config.username}/${this.config.repo}`)).json();
            const branch = repoInfo.default_branch || "main";

            let lastCommitSha: string | null = null;
            let remoteMap = new Map<string, string>();

            const refRes = await this.gh(`/repos/${this.config.username}/${this.config.repo}/git/refs/heads/${branch}`);
            if (refRes.ok) {
                const refData = await refRes.json();
                lastCommitSha = refData.object.sha;
                const lastCommit = await (await this.gh(`/repos/${this.config.username}/${this.config.repo}/git/commits/${lastCommitSha}`)).json();
                const remoteTree = await this.getRemoteTree(lastCommit.tree.sha);
                remoteTree.forEach(item => { if (item.type === "blob") remoteMap.set(item.path, item.sha); });
            }

            this.updateProgress(5, "Merge...", "Comparaison local / distant / dernière sync...");
            const plan = await this.mergeBeforePush(localFiles, remoteMap, lastCommitSha || "");

            for (const pull of plan.toPull) {
                const remoteContent = await this.ghDownloadFile(pull.githubPath, lastCommitSha || undefined);
                if (remoteContent) await this.siYuanPutFile(pull.siYuanPath, remoteContent);
                plan.toReuse.push({ githubPath: pull.githubPath, sha: remoteMap.get(pull.githubPath) });
            }

            const totalChanges = plan.toUpload.length + plan.toDelete.length;
            if (totalChanges === 0) {
                const newFilesState: Record<string, string> = {};
                for (const r of plan.toReuse) newFilesState[r.githubPath] = r.sha;
                await this.saveSyncedState(lastCommitSha || "", newFilesState);
                const msg = "Tout est déjà à jour ! Aucun envoi nécessaire.";
                this.lastProgress = { ...this.lastProgress, finished: true, message: msg };
                if (this.currentUI) this.currentUI.finish(msg);
                return;
            }

            if (!lastCommitSha) {
                if (this.config.showDiff) { const ok = await this.showDiffDialog(plan); if (!ok) { if (this.currentUI) this.currentUI.dialog.destroy(); this.activeTask = null; return; } }
                await this.pushInitialCommit(plan, branch);
                return;
            }

            if (this.config.showDiff) { const ok = await this.showDiffDialog(plan); if (!ok) { if (this.currentUI) this.currentUI.dialog.destroy(); this.activeTask = null; return; } }

            const treeItems: any[] = [];
            for (const r of plan.toReuse) treeItems.push({ path: r.githubPath, mode: "100644", type: "blob", sha: r.sha });

            const uploadedSummaries: { path: string; content: string }[] = [];
            for (let i = 0; i < plan.toUpload.length; i++) {
                const u = plan.toUpload[i];
                this.updateProgress(10 + Math.round((i / plan.toUpload.length) * 75), `Upload : ${i + 1}/${plan.toUpload.length}`, u.githubPath);
                const blobRes = await this.gh(`/repos/${this.config.username}/${this.config.repo}/git/blobs`, "POST", {
                    content: arrayBufferToBase64(u.content), encoding: "base64"
                });
                if (!blobRes.ok) {
                    console.error(`[GitHub Sync] Blob échoué pour ${u.githubPath}:`, await blobRes.text());
                    continue;
                }
                const blobData = await blobRes.json();
                treeItems.push({ path: u.githubPath, mode: "100644", type: "blob", sha: blobData.sha });
                uploadedSummaries.push({ path: u.githubPath, content: this.extractTextFromSyFile(u.content) });
            }

            for (const d of plan.toDelete) {
                treeItems.push({ path: d.githubPath, mode: "100644", type: "blob", sha: null });
                uploadedSummaries.push({ path: d.githubPath, content: "(fichier supprimé)" });
            }

            this.updateProgress(90, "Finalisation...", "Création de l'arbre...");
            const baseTreeRes = await this.gh(`/repos/${this.config.username}/${this.config.repo}/git/commits/${lastCommitSha}`);
            const baseTreeData = await baseTreeRes.json();
            const treeRes = await this.gh(`/repos/${this.config.username}/${this.config.repo}/git/trees`, "POST", {
                base_tree: baseTreeData.tree.sha, tree: treeItems
            });
            const treeData = await treeRes.json();

            const aiMsg = await this.generateCommitMessage(uploadedSummaries);
            const commitMsg = aiMsg || `Sync : +${plan.toUpload.length}, ~${plan.toReuse.length}, -${plan.toDelete.length}, ↕${plan.toPull.length} pull(s)`;
            const commitRes = await this.gh(`/repos/${this.config.username}/${this.config.repo}/git/commits`, "POST", {
                message: commitMsg,
                tree: treeData.sha, parents: [lastCommitSha]
            });
            const commitData = await commitRes.json();

            await this.gh(`/repos/${this.config.username}/${this.config.repo}/git/refs/heads/${branch}`, "PATCH", { sha: commitData.sha });

            const newFilesState: Record<string, string> = {};
            for (const r of plan.toReuse) newFilesState[r.githubPath] = r.sha;
            for (const u of plan.toUpload) {
                const uploadedSha = treeItems.find(t => t.path === u.githubPath)?.sha;
                if (uploadedSha) newFilesState[u.githubPath] = uploadedSha;
            }
            await this.saveSyncedState(commitData.sha, newFilesState);

            const parts: string[] = [];
            if (plan.toUpload.length) parts.push(`${plan.toUpload.length} envoyé(s)`);
            if (plan.toPull.length) parts.push(`${plan.toPull.length} récupéré(s)`);
            if (plan.toDelete.length) parts.push(`${plan.toDelete.length} supprimé(s)`);
            if (plan.toReuse.length) parts.push(`${plan.toReuse.length} inchangé(s)`);
            let msg = `Push terminé — ${parts.join(", ")}.`;
            if (plan.conflicted.length) msg += ` ⚠️ ${plan.conflicted.length} conflit(s) résolu(s) (priorité locale).`;
            this.lastProgress = { ...this.lastProgress, finished: true, message: msg };
            if (this.currentUI) this.currentUI.finish(msg);
            await this.saveSyncTimestamp();
        } catch (e) {
            this.lastProgress = { ...this.lastProgress, finished: true, error: true, message: friendlyError(e) };
            if (this.currentUI) this.currentUI.error(friendlyError(e));
        } finally { this.activeTask = null; }
    }

    private async pushInitialCommit(plan: MergePlan, branch: string) {
        let uploaded = 0;
        const total = plan.toUpload.length;
        let errors = 0;

        for (const u of plan.toUpload) {
            this.updateProgress(10 + Math.round((uploaded / Math.max(total, 1)) * 80), `Upload : ${uploaded + 1}/${total}`, u.githubPath);
            const res = await this.gh(`/repos/${this.config.username}/${this.config.repo}/contents/${encodePath(u.githubPath)}`, "PUT", {
                message: `Sync init : ${u.githubPath}`,
                content: arrayBufferToBase64(u.content),
                branch,
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ message: "unknown" }));
                console.error(`[GitHub Sync] Erreur upload ${u.githubPath}:`, err.message);
                errors++;
            }
            uploaded++;
            if (uploaded % 5 === 0) await sleep(100);
        }

        const newRefRes = await this.gh(`/repos/${this.config.username}/${this.config.repo}/git/refs/heads/${branch}`);
        if (newRefRes.ok) {
            const newRef = await newRefRes.json();
            const newCommit = await (await this.gh(`/repos/${this.config.username}/${this.config.repo}/git/commits/${newRef.object.sha}`)).json();
            const newTree = await this.getRemoteTree(newCommit.tree.sha);
            const newFilesState: Record<string, string> = {};
            newTree.forEach(item => { if (item.type === "blob") newFilesState[item.path] = item.sha; });
            await this.saveSyncedState(newRef.object.sha, newFilesState);
        }

        let msg = `Push initial terminé — ${uploaded} fichiers envoyés.`;
        if (errors > 0) msg += ` ⚠️ ${errors} erreur(s).`;
        this.lastProgress = { ...this.lastProgress, finished: true, message: msg };
        if (this.currentUI) this.currentUI.finish(msg);
    }

    private async pullFromGitHub() {
        if (!this.config.token) return showMessage("⚠️ Configurez le plugin.");
        this.activeTask = "pull";
        this.lastProgress = { percent: 0, status: "Analyse...", details: "Lecture du dépôt distant...", finished: false, error: false, message: "" };
        this.showProgressUI("pull");

        try {
            const repoInfo = await (await this.gh(`/repos/${this.config.username}/${this.config.repo}`)).json();
            const branch = repoInfo.default_branch || "main";

            const refRes = await this.gh(`/repos/${this.config.username}/${this.config.repo}/git/refs/heads/${branch}`);
            if (!refRes.ok) {
                const msg = "Le dépôt est vide. Faites un Push d'abord.";
                this.lastProgress = { ...this.lastProgress, finished: true, message: msg };
                if (this.currentUI) this.currentUI.finish(msg);
                return;
            }
            const refData = await refRes.json();
            const lastCommit = await (await this.gh(`/repos/${this.config.username}/${this.config.repo}/git/commits/${refData.object.sha}`)).json();
            const remoteItems = (await this.getRemoteTree(lastCommit.tree.sha)).filter(i => {
                if (i.type !== "blob") return false;
                const p = i.path;
                if (p.startsWith("data/")) {
                    const rest = p.slice(5);
                    const firstSegment = rest.split("/")[0];
                    if (SKIP_ROOT_DIRS.includes(firstSegment)) return false;
                }
                return p.startsWith(SYNC_ROOT);
            });

            let updated = 0, skipped = 0, errors = 0;
            for (let i = 0; i < remoteItems.length; i++) {
                const item = remoteItems[i];
                const siPath = item.path.slice(SYNC_ROOT.length);
                this.updateProgress(Math.round((i / remoteItems.length) * 100), `Pull : ${i + 1}/${remoteItems.length}`, siPath);

                if (LOCKED_EXTENSIONS.some(ext => siPath.toLowerCase().endsWith(ext)) || siPath.includes("/temp/") || SKIP_PATH_FRAGMENTS.some(f => siPath.includes(f))) {
                    skipped++; continue;
                }

                if (siPath.endsWith(".siyuan.sy")) { skipped++; continue; }

                const localContent = await this.siYuanGetFile(siPath);
                const localSha = localContent ? await calculateGitSha(localContent) : "";

                if (localSha === item.sha) {
                    skipped++;
                } else {
                    const content = await this.ghDownloadFile(item.path);
                    if (content && content.byteLength > 0) {
                        const ok = await this.siYuanPutFile(siPath, content);
                        if (ok) { updated++; }
                        else { errors++; console.error(`[GitHub Sync] Écriture échouée: ${siPath}`); }
                    } else {
                        errors++;
                        console.error(`[GitHub Sync] Téléchargement échoué: ${item.path}`);
                    }
                }
                await sleep(30);
            }

            await this.siYuanRefreshFiletree();
            const newFilesState: Record<string, string> = {};
            remoteItems.forEach(item => { newFilesState[item.path] = item.sha; });
            await this.saveSyncedState(refData.object.sha, newFilesState);

            let msg = `Pull terminé : ${updated} fichiers mis à jour, ${skipped} déjà à jour ou protégés.`;
            if (errors > 0) msg += ` ⚠️ ${errors} erreur(s).`;
            this.lastProgress = { ...this.lastProgress, finished: true, message: msg };
            if (this.currentUI) this.currentUI.finish(msg);
            await this.saveSyncTimestamp();
            setTimeout(() => window.location.reload(), 1500);
        } catch (e) {
            this.lastProgress = { ...this.lastProgress, finished: true, error: true, message: friendlyError(e) };
            if (this.currentUI) this.currentUI.error(friendlyError(e));
        } finally { this.activeTask = null; }
    }

    // ── Historique & Restauration ──────────────────────────────────────────

    private async handleHistoryClick() {
        if (!this.config.token) return showMessage("⚠️ Configurez le plugin.");
        new HistoryDialog(this);
    }

    async getHistory(): Promise<any[]> {
        const res = await this.gh(`/repos/${this.config.username}/${this.config.repo}/commits?per_page=30`);
        if (!res.ok) throw new Error("Impossible de récupérer l'historique");
        return res.json();
    }

    private extractTextFromSyFile(content: ArrayBuffer): string {
        try {
            const text = new TextDecoder().decode(content);
            const json = JSON.parse(text);
            const texts: string[] = [];
            const walk = (obj: unknown, depth = 0) => {
                if (!obj || typeof obj !== "object" || depth > 8) return;
                if (Array.isArray(obj)) { obj.forEach(v => walk(v, depth + 1)); return; }
                const o = obj as Record<string, unknown>;
                if (o.content && typeof o.content === "string" && o.content.length > 5) texts.push(o.content);
                if (o.markdown && typeof o.markdown === "string" && o.markdown.length > 5) texts.push(o.markdown);
                if (o.text && typeof o.text === "string" && o.text.length > 5) texts.push(o.text);
                if (o.name && typeof o.name === "string" && o.name.length > 5) texts.push(o.name);
                if (o.title && typeof o.title === "string" && o.title.length > 5) texts.push(o.title);
                for (const val of Object.values(o)) {
                    if (typeof val === "object") walk(val, depth + 1);
                }
            };
            walk(json);
            return texts.join("\n").replace(/\s+/g, " ").trim().slice(0, 800);
        } catch {
            const text = new TextDecoder().decode(content);
            return text.replace(/[^\w\s\u00C0-\u00FF-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 600);
        }
    }

    private async generateCommitMessage(summaries: { path: string; content: string }[]): Promise<string> {
        if (!this.config.groqKey) return "";
        try {
            let fileDesc = summaries.map(s => {
                const title = s.content.split("\n")[0].replace(/#{1,6}\s*/, "").trim();
                const extra = s.content.length > 80 ? s.content.slice(0, 200) : "";
                return `- ${s.path}: ${title} — ${extra}`;
            }).join("\n");
            if (fileDesc.length > 6000) fileDesc = fileDesc.slice(0, 6000) + "\n...";
            const prompt = `Tu es un expert Git. Génère un message de commit très précis en français (max 72 caractères) décrivant les changements réels ci-dessous. Sois spécifique sur le contenu modifié, pas générique.\n\nFichiers modifiés :\n${fileDesc}`;
            const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: { Authorization: `Bearer ${this.config.groqKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], max_tokens: 120 })
            });
            if (!res.ok) return "";
            const data = await res.json();
            const msg = data.choices?.[0]?.message?.content?.trim();
            return msg ? msg.replace(/["']/g, "").split("\n")[0].slice(0, 72) : "";
        } catch { return ""; }
    }

    async restoreCommit(sha: string, message: string) {
        const commitRes = await this.gh(`/repos/${this.config.username}/${this.config.repo}/git/commits/${sha}`);
        if (!commitRes.ok) throw new Error("Impossible de récupérer le commit");
        const commitData = await commitRes.json();
        const treeItems = await this.getRemoteTree(commitData.tree.sha);
        const blobs = treeItems.filter(i =>
            i.type === "blob" && i.path.startsWith(SYNC_ROOT) &&
            !i.path.startsWith("data/plugins/siyuan-github-sync/")
        );

        let updated = 0;
        for (const item of blobs) {
            const siPath = item.path.slice(SYNC_ROOT.length);
            if (LOCKED_EXTENSIONS.some(ext => siPath.toLowerCase().endsWith(ext)) ||
                siPath.includes("/temp/") || SKIP_PATH_FRAGMENTS.some(f => siPath.includes(f)) ||
                siPath.endsWith(".siyuan.sy")) continue;

            const content = await this.ghDownloadFile(item.path, sha);
            if (content && content.byteLength > 0) {
                await this.siYuanPutFile(siPath, content);
                updated++;
            }
            await sleep(30);
        }

        await this.siYuanRefreshFiletree();

        const newFilesState: Record<string, string> = {};
        treeItems.forEach(item => { if (item.type === "blob") newFilesState[item.path] = item.sha; });
        await this.saveSyncedState(sha, newFilesState);

        showMessage(`✅ Restauré : ${updated} fichiers (commit: ${sha.slice(0, 7)} — ${message})`);
        setTimeout(() => window.location.reload(), 1500);
    }
}

// ─── History Dialog ─────────────────────────────────────────────────────────

class HistoryDialog {
    private plugin: GitHubSyncPlugin;
    private dialog: Dialog;
    private listEl: HTMLElement;

    constructor(plugin: GitHubSyncPlugin) {
        this.plugin = plugin;
        this.dialog = new Dialog({
            title: "📜 Historique des commits",
            content: `
                <div class="b3-dialog__content" style="padding: 16px; max-height: 480px; overflow-y: auto;">
                    <div id="history-list" style="min-height: 80px;">
                        <div style="text-align:center;padding:32px;color:var(--b3-theme-on-background);">Chargement...</div>
                    </div>
                </div>
                <div class="b3-dialog__action" style="padding: 8px 16px; border-top: 1px solid var(--b3-border-color);">
                    <button id="history-refresh" class="b3-button b3-button--outline">🔄 Rafraîchir</button>
                    <button id="history-close" class="b3-button b3-button--outline" style="margin-left: 8px;">Fermer</button>
                </div>
            `,
            width: window.innerWidth < 600 ? `${window.innerWidth - 32}px` : "600px",
        });
        this.listEl = this.dialog.element.querySelector("#history-list");
        this.dialog.element.querySelector("#history-refresh").addEventListener("click", () => this.load());
        this.dialog.element.querySelector("#history-close").addEventListener("click", () => this.dialog.destroy());
        this.load();
    }

    private async load() {
        this.listEl.innerHTML = `<div style="text-align:center;padding:32px;color:var(--b3-theme-on-background);">Chargement...</div>`;
        try {
            const commits = await this.plugin.getHistory();
            if (commits.length === 0) {
                this.listEl.innerHTML = `<div style="text-align:center;padding:32px;color:var(--b3-theme-on-background);">Aucun commit trouvé.</div>`;
                return;
            }
            let html = "";
            for (const c of commits) {
                const sha = c.sha.slice(0, 7);
                const date = new Date(c.commit.author.date).toLocaleString("fr-FR");
                const author = c.commit.author.name;
                const msg = c.commit.message.split("\n")[0];
                html += `
                    <div style="display:flex;align-items:center;padding:10px 8px;border-bottom:1px solid var(--b3-border-color);gap:8px;">
                        <span style="font-family:monospace;font-size:11px;color:var(--b3-theme-primary);min-width:64px;">${sha}</span>
                        <div style="flex:1;min-width:0;">
                            <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this.escapeHtml(msg)}</div>
                            <div style="font-size:11px;opacity:0.6;">${date} par ${this.escapeHtml(author)}</div>
                        </div>
                        <button class="b3-button b3-button--outline restore-btn" data-sha="${c.sha}" data-msg="${this.escapeHtml(msg)}" style="flex-shrink:0;">Restaurer</button>
                    </div>
                `;
            }
            this.listEl.innerHTML = html;
            this.listEl.querySelectorAll(".restore-btn").forEach(btn => {
                btn.addEventListener("click", async (e) => {
                    const el = e.currentTarget as HTMLElement;
                    el.disabled = true;
                    el.textContent = "⏳...";
                    try {
                        await this.plugin.restoreCommit(el.dataset.sha, el.dataset.msg);
                        this.dialog.destroy();
                    } catch (err) {
                        showMessage(`❌ Restauration échouée : ${err.message}`, 6000, "error");
                        el.disabled = false;
                        el.textContent = "Restaurer";
                    }
                });
            });
        } catch (err) {
            this.listEl.innerHTML = `<div style="text-align:center;padding:32px;color:var(--b3-theme-error);">❌ ${this.escapeHtml(err.message)}</div>`;
        }
    }

    private escapeHtml(s: string): string {
        const div = document.createElement("div");
        div.textContent = s;
        return div.innerHTML;
    }
}
