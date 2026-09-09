// Manager for the syncronization state of the workplace files
// it provides checks for remote and local SHA of single files
// plus saving and loading file states (eg. local SHA vs remote SHA)
// so that the plugin can know if a file has changed locally or remotely and needs to be synced

import { Plugin } from "siyuan";
import { SYNCED_STATE_KEY, SyncedState } from "../shared-utils/types";

export class SyncStateLedger {
	private state: Record<string, string> = {};
	private lastCommitSha: string = "";

	constructor(private plugin: Plugin) {}

	// load latest saved states from storage, if any, otherwise initialize empty state
	public async load(): Promise<void> {
		try {
			const data = (await this.plugin.loadData(
				SYNCED_STATE_KEY,
			)) as SyncedState;
			if (data) {
				this.state = data.files || {};
				this.lastCommitSha = data.commitSha || "";
			}
		} catch {
			this.state = {};
		}
	}

	// save current whole state to storage, including the last commit SHA
	public async save(commitSha: string): Promise<void> {
		this.lastCommitSha = commitSha;
		await this.plugin.saveData(SYNCED_STATE_KEY, {
			commitSha: this.lastCommitSha,
			files: this.state,
		});
	}

	public getRemoteSha(path: string): string | null {
		const raw = this.state[path];
		return raw && raw.includes(":") ? raw.split(":")[1] : raw || null;
	}

	public getLocalSha(path: string): string | null {
		const raw = this.state[path];
		return raw && raw.includes(":") ? raw.split(":")[0] : raw || null;
	}

	// save file state
	public updateFile(path: string, localSha: string, remoteSha: string): void {
		this.state[path] = `${localSha}:${remoteSha}`;
	}

	// remove file from state (keeping track of local deletion)
	public removeFile(path: string): void {
		delete this.state[path];
	}

	// share current internal state upon request
	public getState(): Record<string, string> {
		return this.state;
	}
}
