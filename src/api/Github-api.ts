import {
	GITHUB_API,
	GitHubTreeItem,
	GitHubCommit,
	GitHubTreePayload,
	GitPluginConfig,
} from "../shared-utils/types";
import { base64ToArrayBuffer, sleep } from "../shared-utils/utils";
import { t } from "../shared-utils/i18n";

export class GitHubError extends Error {
	constructor(
		public status: number,
		public statusText: string,
		public body: string,
		public url: string,
	) {
		super(`[GitHub API] ${status} ${statusText} on ${url}`);
		this.name = "GitHubError";
	}
}

/**
 * GitHub REST API client.
 * Provides rate-limit-aware fetch wrappers for interacting with git objects
 * (trees, blobs, commits, refs) and surfaces HTTP errors for centralized handling.
 */
export class GitHubAPI {
	/**
	 * @param config	Access the config info
	 */
	constructor(private config: GitPluginConfig) {}

	/**
	 * Perform an authenticated request against the GitHub REST API with
	 * automatic rate-limit handling.
	 *
	 * On HTTP 403/429 (rate limited) it waits either the `retry-after` hint,
	 * the `x-ratelimit-reset` time, or an exponential backoff, then retries up
	 * to `retries` times. Other non-OK responses are returned to the caller.
	 */
	async gh(
		path: string,
		method = "GET",
		body?: object,
		retries = 3,
	): Promise<Response> {
		// Force cache bypassing by appending a unique timestamp to GET requests
		const url =
			method === "GET"
				? `${GITHUB_API}${path}${path.includes("?") ? "&" : "?"}t=${Date.now()}`
				: `${GITHUB_API}${path}`;
		let attempt = 0;

		while (attempt < retries) {
			console.debug(
				`[GitHub Sync] API Request: ${method} ${url} (Attempt ${attempt + 1})`,
			);
			const res = await fetch(url, {
				method,
				headers: {
					Authorization: `Bearer ${this.config.token}`,
					"Content-Type": "application/json",
					Accept: "application/vnd.github+json",
					"Cache-Control": "no-cache", // Explicitly request fresh data
				},
				body: body ? JSON.stringify(body) : undefined,
			});

			const remaining = res.headers.get("x-ratelimit-remaining");
			if (remaining) {
				console.debug(`[GitHub Sync] Rate limit remaining: ${remaining}`);
			}

			// automatic rate limit handling
			if (res.status === 403 || res.status === 429) {
				const retryAfter = res.headers.get("retry-after");
				const resetTime = res.headers.get("x-ratelimit-reset");
				let waitTime: number;

				if (retryAfter) {
					// Secondary rate limit: GitHub tells us exactly when to retry.
					waitTime = parseInt(retryAfter, 10) * 1000;
					console.warn(
						`[GitHub Sync] Secondary rate limit hit. Waiting ${waitTime}ms.`,
					);
				} else if (resetTime) {
					// Primary rate limit: wait until the reset timestamp, plus a buffer.
					const resetMs = parseInt(resetTime, 10) * 1000;
					waitTime = Math.max(1000, resetMs - Date.now() + 1000);
					console.warn(
						`[GitHub Sync] Primary rate limit hit. Waiting ${waitTime}ms.`,
					);
				} else {
					// No headers available: fall back to exponential backoff.
					waitTime = Math.pow(2, attempt) * 2000;
					console.warn(
						`[GitHub Sync] Rate limit hit with no headers. Waiting ${waitTime}ms.`,
					);
				}

				await sleep(waitTime);
				attempt++;
				continue;
			}

			if (res.status < 200 || res.status >= 300) {
				const errorBody = await res.text();
				// Mute expected 404 and 409 errors from the console
				if (res.status !== 404 && res.status !== 409) {
					console.error(
						`[GitHub Sync] VERBOSE API ERROR:\n` +
							`  URL: ${method} ${url}\n` +
							`  Status: ${res.status} ${res.statusText}\n` +
							`  Headers: ${res.headers}\n` +
							`  Body: ${errorBody}`,
					);
				}
				throw new GitHubError(res.status, res.statusText, errorBody, url);
			}

			return res;
		}
		throw new Error(
			`[GitHub Sync] Failed after ${retries} retries due to rate limiting.`,
		);
	}

	/**
	 * Recursively fetch every node of a git tree.
	 *
	 * The special empty-tree SHA (the tree of an unborn branch) is treated as
	 * an empty list. A 404 (missing tree) is also mapped to `[]`.
	 */
	async getRemoteTree(treeSha: string): Promise<GitHubTreeItem[]> {
		if (treeSha === "4b825dc642cb6eb9a060e54bf8d69288fbee4904") {
			return [];
		}
		try {
			const res = await this.gh(
				`/repos/${this.config.username}/${this.config.repo}/git/trees/${treeSha}?recursive=1`,
			);
			const data = await res.json();
			return (data.tree || []) as GitHubTreeItem[];
		} catch (err) {
			if (err instanceof GitHubError && err.status === 404) return [];
			throw err;
		}
	}

	/**
	 * Download a blob (file content) by its SHA and decode it to an ArrayBuffer.
	 *
	 * Returns `null` on any failure so callers can skip gracefully.
	 */
	async downloadBlob(sha: string): Promise<ArrayBuffer | null> {
		try {
			const url = `/repos/${this.config.username}/${this.config.repo}/git/blobs/${sha}`;
			const res = await this.gh(url);
			const data = await res.json();
			if (!data.content) return null;

			return base64ToArrayBuffer(data.content);
		} catch (err) {
			console.error(`[GitHub Sync] downloadBlob exception for ${sha}:`, err);
			return null;
		}
	}
	/** Verify that the token can access the repository (HTTP 200 = OK). */
	async testConnection(): Promise<boolean> {
		try {
			const res = await this.gh(
				`/repos/${this.config.username}/${this.config.repo}`,
			);
			return res.status === 200;
		} catch {
			return false;
		}
	}

	/** Fetch the 30 most recent commits of the repository. */
	async getCommits(): Promise<GitHubCommit[]> {
		const res = await this.gh(
			`/repos/${this.config.username}/${this.config.repo}/commits?per_page=30`,
		);
		if (res.status < 200 || res.status >= 300)
			throw new Error(t("msg.repo_empty"));
		return res.json();
	}

	/** Fetch repository metadata (default branch, ownership, etc.). */
	getRepoInfo() {
		return this.gh(`/repos/${this.config.username}/${this.config.repo}`);
	}

	/** Fetch the SHA that a branch currently points to. */
	getRef(branch: string) {
		return this.gh(
			`/repos/${this.config.username}/${this.config.repo}/git/ref/heads/${branch}`,
		);
	}

	/** Fetch a single commit object (including its tree SHA). */
	getCommit(sha: string) {
		return this.gh(
			`/repos/${this.config.username}/${this.config.repo}/git/commits/${sha}`,
		);
	}

	/** Create a git blob from base64-encoded content and return its SHA. */
	createBlob(content: string) {
		return this.gh(
			`/repos/${this.config.username}/${this.config.repo}/git/blobs`,
			"POST",
			{
				content,
				encoding: "base64",
			},
		);
	}

	/**
	 * Seed an initial commit so the git-object endpoints become usable.
	 *
	 * GitHub returns 409 "Git Repository is empty" for every git endpoint
	 * (blobs/trees/commits) until the repo owns at least one commit. A
	 * placeholder file is created through the contents API to unlock them for
	 * the very first push.
	 */
	async initEmptyRepo(branch: string) {
		const path = "_siyuan-github-sync-init";
		const content = btoa("Initialized by siyuan-github-sync plugin.");
		return this.gh(
			`/repos/${this.config.username}/${this.config.repo}/contents/${path}`,
			"PUT",
			{
				message: "chore: init repository for siyuan-github-sync",
				content,
				branch,
			},
		);
	}

	/**
	 * Create a git tree (optionally against a base tree).
	 *
	 * `treeItems` entries use GitHub's format: `{ path, mode, type, sha }`.
	 * A `sha: null` entry marks a deletion. Chunking large trees is the
	 * caller's responsibility.
	 */
	createTree(baseTree: string, treeItems: GitHubTreeItem[]) {
		const payload: GitHubTreePayload = { tree: treeItems };
		if (baseTree) {
			payload.base_tree = baseTree;
		}
		return this.gh(
			`/repos/${this.config.username}/${this.config.repo}/git/trees`,
			"POST",
			payload,
		);
	}

	/** Create a commit object pointing at a tree, with the given parents. */
	createCommit(message: string, tree: string, parents: string[]) {
		return this.gh(
			`/repos/${this.config.username}/${this.config.repo}/git/commits`,
			"POST",
			{
				message,
				tree,
				parents,
			},
		);
	}

	/** Move a branch pointer to a new commit SHA (effectively the "push"). */
	updateRef(branch: string, sha: string) {
		return this.gh(
			`/repos/${this.config.username}/${this.config.repo}/git/refs/heads/${branch}`,
			"PATCH",
			{ sha, force: true },
		);
	}
}
