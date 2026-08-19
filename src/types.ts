/**
 * Shared constants and TypeScript types for the GitHub Sync plugin.
 *
 * This module is the single source of truth for the paths, keys and shapes
 * used across the whole plugin. It has no runtime dependencies, so it is
 * safe to import from anywhere (API wrappers, UI, crypto, etc.).
 */

/**
 * Key under which the plugin configuration (username, repo, token, ...) is
 * persisted locally with SiYuan's `saveData()`.
 */
export const STORAGE_KEY = "github-sync-config.json";

/** Base URL of the GitHub REST API used for every request. */
export const GITHUB_API = "https://api.github.com";

/**
 * Root folder inside the GitHub repository (and inside SiYuan's workspace
 * `data/` folder) that is actually synced.
 */
export const SYNC_ROOT = "data";

/**
 * Hard limit for a single uploaded file (25 MB). Files larger than this are
 * skipped during a push because GitHub blobs / SiYuan transfers get too heavy.
 */
export const MAX_FILE_BYTES = 25_000_000;

/**
 * Top-level workspace directories that are NEVER synced. They contain local
 * configuration, caches, or volatile data that must not be pushed to GitHub
 * (plugins and widgets are synced through their own generated manifests).
 */
export const SKIP_ROOT_DIRS = [
	"plugins",
	"conf",
	".siyuan",
	"!storage/av",
	"storage",
	"emojis",
	"public",
	"templates",
	"widgets",
	"siyuan-github-sync",
	"history",
];

/**
 * Path fragments that disqualify a file from being synced (e.g. `.git/`
 * internals or SiYuan's live `temp/` files).
 */
export const SKIP_PATH_FRAGMENTS = [".git/", "/temp/"];

/**
 * File extensions considered "locked" while SiYuan is running (SQLite
 * databases, write-ahead logs, lock files). They are never read, uploaded
 * or deleted because they change continuously and are managed by SiYuan.
 */
export const LOCKED_EXTENSIONS = [".db", ".db-shm", ".db-wal", ".log", ".lock"];

/**
 * Key under which the last-sync state ledger is stored with `saveData()`.
 * It maps each synced file to a `plaintextSha:remoteSha` pair so the 3-way
 * merge can tell local vs remote changes apart.
 */
export const SYNCED_STATE_KEY = "github-sync-state.json";

/** Remote location of the generated plugin manifest (`data/plugin-manifest.json`). */
export const PLUGIN_MANIFEST_PATH = `${SYNC_ROOT}/plugin-manifest.json`;
/** Remote location of the generated widget manifest (`data/widget-manifest.json`). */
export const WIDGET_MANIFEST_PATH = `${SYNC_ROOT}/widget-manifest.json`;
/** Remote location of the generated theme manifest (`data/theme-manifest.json`). */
export const THEME_MANIFEST_PATH = `${SYNC_ROOT}/theme-manifest.json`;
/** Name of the per-notebook manifest file pushed next to each notebook folder. */
export const NOTEBOOK_MANIFEST_FILE = "notebook.json";
/**
 * Name of this plugin itself. It is always excluded from the plugin manifests
 * so a pull never tries to install or remove the plugin that is running it.
 */
export const PLUGIN_SELF_NAME = "siyuan-github-sync";

/**
 * Plugin configuration as persisted under `STORAGE_KEY`.
 *
 * The token and the encryption password are sensitive values: they are stored
 * through SiYuan's `saveData()` API, which keeps them in the workspace's data
 * store rather than in the code repository.
 */
export interface GitHubConfig {
	/** GitHub account / organisation that owns the repository. */
	username: string;
	/** Name of the GitHub repository to sync with. */
	repo: string;
	/** GitHub Personal Access Token with the `repo` scope. */
	token: string;
	/** Optional Groq API key used to auto-generate AI commit messages. */
	groqKey: string;
	/** If true, a summary diff dialog is shown before every push. */
	showDiff: boolean;
	/** UI language of the plugin ("en", "fr" or "zh"). */
	language?: string;
	/** Timestamp (ms since epoch) of the last successful sync. */
	lastSync?: number;
	/** Client-side encryption password (AES-GCM). Omitted when disabled. */
	encryptionPassword?: string;
}

/** Sensible defaults applied when no saved configuration exists yet. */
export const DEFAULT_CONFIG: GitHubConfig = {
	username: "",
	repo: "",
	token: "",
	groqKey: "",
	showDiff: true,
	language: "en",
};

/** A single entry returned by SiYuan's `/api/file/readDir`. */
export interface SiYuanDirEntry {
	/** Entry name (file or folder) inside the directory. */
	name: string;
	/** Whether this entry is a directory. */
	isDir: boolean;
	/** Last modification timestamp of the entry. */
	updated: number;
}

/**
 * A node of a GitHub git tree (as returned by the
 * `GET /git/trees/{sha}?recursive=1` endpoint).
 */
export interface GitHubTreeItem {
	/** Full path of the entry inside the repository. */
	path: string;
	/** Git file mode (e.g. "100644" for regular files). */
	mode: string;
	/** Node kind: a file (`blob`) or a folder (`tree`). */
	type: "blob" | "tree";
	/** Git object SHA of the blob (or tree). */
	sha: string;
	/** Blob size in bytes, when provided by the API. */
	size?: number;
}

/** A file to sync, expressed with both its SiYuan and GitHub path. */
export interface FileToSync {
	/** Workspace path used by SiYuan (e.g. `/data/notes/foo.sy`). */
	siYuanPath: string;
	/** Repository-relative path used by GitHub (e.g. `data/notes/foo.sy`). */
	githubPath: string;
}

/**
 * Persisted sync-state ledger saved under `SYNCED_STATE_KEY`.
 *
 * `files` maps every synced GitHub path to a `"plaintextSha:remoteSha"` pair
 * that lets the 3-way merge compare local content, remote content and the
 * last known state independently.
 */
export interface SyncedState {
	/** SHA of the commit that produced this state. */
	commitSha: string;
	/** Per-file ledger: githubPath -> "plaintextSha:remoteSha". */
	files: Record<string, string>;
}

/**
 * Result of the 3-way merge computed before a push (`mergeBeforePush`).
 * Each list holds files grouped by the action the push should take.
 */
export interface MergePlan {
	/** Files that must be re-encrypted and uploaded as new blobs. */
	toUpload: { githubPath: string; siYuanPath: string }[];
	/** Files whose remote blob can be reused as-is (SHA unchanged). */
	toReuse: { githubPath: string; sha: string }[];
	/** Files that must be removed from the remote tree. */
	toDelete: { githubPath: string }[];
	/** Remote files that must be downloaded into the local workspace. */
	toPull: { githubPath: string; siYuanPath: string }[];
	/** Files modified on both sides; left for the user to resolve. */
	conflicted: { githubPath: string; siYuanPath: string }[];
	/** Number of local files skipped because they exceed MAX_FILE_BYTES. */
	skippedLarge: number;
}

/** A single plugin/widget/theme entry recorded in a generated manifest. */
export interface PluginManifestEntry {
	/** Marketplace name of the package. */
	name: string;
	/** Installed version, used to detect upgrades. */
	version: string;
}

/** Manifest file describing the installed plugins or widgets. */
export interface PluginManifest {
	/** List of installed packages. */
	plugins: PluginManifestEntry[];
}

/** Manifest payload for a single notebook (stores its human-readable name). */
export interface NotebookManifestEntry {
	/** SiYuan notebook identifier (folder name in `data/`). */
	id: string;
	/** Display name of the notebook. */
	name: string;
}

/** A generated manifest ready to be uploaded, together with its remote path. */
export interface ManifestFile {
	/** GitHub path where the manifest must be written. */
	githubPath: string;
	/** Raw bytes (usually UTF-8 JSON) of the manifest. */
	content: ArrayBuffer;
}
