/**
 * UI dialogs for the sync plugin.
 *
 * This module holds the two dialogs shown during sync operations:
 *   - `SyncProgressUI`: modal progress bar (status text + progress bar +
 *     details line) used by push / pull / remove-encryption flows.
 *   - `showDiffDialog`: confirmation dialog listing the changes a push would
 *     make (upload / delete / reuse / conflicts), resolving to a boolean.
 */
import { Dialog } from "siyuan";
import { MergePlan } from "./types";
//import { sanitizeForDisplay } from "./utils";
import { t } from "./i18n";

/**
 * Modal dialog that displays the live progress of a sync operation.
 *
 * The dialog exposes `update()`, `finish()` and `error()` so the plugin can
 * drive the UI without holding a reference to the DOM. `isDestroyed` guards
 * against updating a dialog that has already been closed.
 */
export class SyncProgressUI {
    private dialog: Dialog;
    private barElement: HTMLElement;
    private statusElement: HTMLElement;
    private detailsElement: HTMLElement;
    /** True once the dialog has been destroyed; all updates are then ignored. */
    public isDestroyed = false;

    /**
     * @param title    Dialog window title.
     * @param onClosed Callback fired when the dialog is destroyed (used by the
     *                 plugin to null out its reference to this instance).
     */
    constructor(title: string, onClosed: () => void) {
        this.dialog = new Dialog({
            title,
            content: `
                <div class="b3-dialog__content" style="padding: 24px;">
                    <div id="sync-status" style="font-weight: bold; margin-bottom: 12px; color: var(--b3-theme-on-background);">${t('status.initializing')}</div>
                    <div style="height: 12px; background: var(--b3-border-color); border-radius: 6px; overflow: hidden; margin-bottom: 12px;">
                        <div id="sync-bar" style="width: 0%; height: 100%; background: var(--b3-theme-primary); transition: width 0.3s ease;"></div>
                    </div>
                    <div id="sync-details" style="font-size: 11px; opacity: 0.7; line-height: 1.4; word-break: break-all; min-height: 32px; font-family: monospace;">
                        ${t('progress.analysis')}
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

    /**
     * Refresh the three widgets: status text, progress-bar width and the
     * small monospace details line.
     */
    update(percent: number, status: string, details: string) {
        if (this.isDestroyed) return;
        if (this.statusElement)  this.statusElement.textContent  = status;
        if (this.barElement)     this.barElement.style.width    = `${percent}%`;
        if (this.detailsElement) this.detailsElement.textContent = details;
    }

    /**
     * Mark the operation as completed: bar at 100% + "Done" status, and
     * optionally a Close button to dismiss the dialog.
     */
    finish(message: string, showButton = true) {
        if (this.isDestroyed) return;
        this.update(100, t('ui.done'), message);
        if (!showButton) return;
        // Add a "Close" footer button unless one already exists (idempotent).
        const content = this.dialog.element.querySelector(".b3-dialog__content");
        if (content && !content.querySelector(".b3-dialog__action")) {
            const footer = document.createElement("div");
            footer.className = "b3-dialog__action";
            footer.style.marginTop = "16px";
            footer.innerHTML = `<button class="b3-button b3-button--outline">Close</button>`;
            (footer.querySelector(".b3-button--outline") as HTMLElement).onclick = () => this.dialog.destroy();
            content.appendChild(footer);
        }
    }

    /** Destroy the dialog if it is still alive. */
    destroy() {
        if (!this.isDestroyed) this.dialog.destroy();
    }

    /** Mark the operation as failed: 100% bar, "Error" status, red bar. */
    error(message: string) {
        if (this.isDestroyed) return;
        this.update(100, t('ui.error'), message);
        if (this.barElement) this.barElement.style.background = "var(--b3-theme-error)";
    }
}

/**
 * Show a pre-push summary dialog and resolve to whether the user confirmed.
 *
 * The summary lists (with emoji + color) the files to upload, delete, reuse,
 * the conflicts and the oversized skipped files. Only the first ~20 entries
 * of each group are shown to keep the dialog readable.
 *
 * @returns Promise resolving to `true` if the user clicked "Send".
 */
export function showDiffDialog(plan: MergePlan): Promise<boolean> {
    return new Promise(resolve => {
        const lines: string[] = [];
        if (plan.toUpload.length > 0) {
            lines.push(`<div style="margin:6px 0;font-weight:bold;color:var(--b3-theme-primary);">🆕 ${plan.toUpload.length} ${t('diff.files_to_upload')}</div>`);
            for (const u of plan.toUpload.slice(0, 20)) {
                lines.push(`<div style="padding:2px 8px;font-size:12px;font-family:monospace;">+ ${u.githubPath}</div>`);
            }
            if (plan.toUpload.length > 20) lines.push(`<div style="padding:2px 8px;font-size:11px;opacity:.6;">… et ${plan.toUpload.length - 20} ${t('diff.other')}</div>`);
        }
        if (plan.toDelete.length > 0) {
                    lines.push(`<div style="margin:6px 0;font-weight:bold;color:#f44336;">🗑️ ${plan.toDelete.length} ${t('diff.files_to_delete')}</div>`);
                    for (const d of plan.toDelete.slice(0, 20)) {
                        lines.push(`<div style="padding:2px 8px;font-size:12px;font-family:monospace;">- ${d.githubPath}</div>`);
                    }
                    if (plan.toDelete.length > 20) lines.push(`<div style="padding:2px 8px;font-size:11px;opacity:.6;">… et ${plan.toDelete.length - 20} ${t('diff.other')}</div>`);
                }
        if (plan.toReuse.length > 0) {
            lines.push(`<div style="margin:6px 0;font-weight:bold;color:#4caf50;">✅ ${plan.toReuse.length} ${t('diff.unchanged')}</div>`);
        }
        if (plan.conflicted.length > 0) {
            lines.push(`<div style="margin:6px 0;font-weight:bold;color:#ff9800;">${t('diff.conflicts')}</div>`);
            for (const c of plan.conflicted.slice(0, 10)) {
                lines.push(`<div style="padding:2px 8px;font-size:12px;font-family:monospace;">⚠ ${c.githubPath}</div>`);
            }
            if (plan.conflicted.length > 10) lines.push(`<div style="padding:2px 8px;font-size:11px;opacity:.6;">… ${t('part.and')} ${plan.conflicted.length - 10} ${t('part.other')}</div>`);
        }
        if (plan.skippedLarge > 0) {
					lines.push(`<div style="margin:6px 0;font-weight:bold;color:#9e9e9e;">📦 ${plan.skippedLarge} ${t('diff.skipped_large')} (>25 Mo)</div>`);
        }
        const dialog = new Dialog({
            title: t('diff.title'),
            content: `
                <div class="b3-dialog__content" style="padding:16px;max-height:360px;overflow-y:auto;">
                    ${lines.join("") || `<div style='opacity:.6;'>${t('diff.no_changes')}</div>`}
                </div>
                <div class="b3-dialog__action" style="padding:8px 16px;border-top:1px solid var(--b3-border-color);">
                    <button id="diff-confirm" class="b3-button b3-button--info">${t('diff.send')}</button>
                    <button id="diff-cancel" class="b3-button b3-button--outline" style="margin-left:8px;">${t('diff.cancel')}</button>
                </div>
            `,
            width: window.innerWidth < 600 ? `${window.innerWidth - 32}px` : "520px",
            // Closing the dialog by any other means (X button / Escape) counts
            // as a cancellation.
            destroyCallback: () => resolve(false),
        });
        dialog.element.querySelector("#diff-confirm")?.addEventListener("click", () => { dialog.destroy(); resolve(true); });
        dialog.element.querySelector("#diff-cancel")?.addEventListener("click", () => { dialog.destroy(); resolve(false); });
    });
}
