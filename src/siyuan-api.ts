/**
 * Wrappers around SiYuan's built-in HTTP APIs.
 *
 * Every function talks to the local SiYuan instance through its internal
 * `/api/...` endpoints. The wrappers are defensive by design: they never
 * throw — on any failure they return a safe default (`[]`, `false`, `null`),
 * so callers can treat them as optional operations.
 *
 * Sections:
 *  - File operations      (readDir / getFile / putFile / removeFile)
 *  - Notebook operations  (list / open / get & set configuration)
 *  - Appearance           (active theme, light/dark mode)
 *  - Bazaar (marketplace) (install plugins / widgets / themes)
 *  - Directory collection (walk the workspace and build the sync file list)
 */
import {
	SiYuanDirEntry,
	NotebookManifestEntry,
	FileToSync,
	SKIP_ROOT_DIRS,
	SKIP_PATH_FRAGMENTS,
	LOCKED_EXTENSIONS,
} from "./types";

/** List the entries of a workspace directory (`/api/file/readDir`). */
export async function siYuanReadDir(path: string): Promise<SiYuanDirEntry[]> {
	try {
		const res = await fetch("/api/file/readDir", {
			method: "POST",
			body: JSON.stringify({ path }),
		});
		const json = await res.json();
		return json.code === 0 && json.data ? json.data : [];
	} catch {
		return [];
	}
}

/** Read a file from the workspace and return its raw bytes (`/api/file/getFile`). */
export async function siYuanGetFile(path: string): Promise<ArrayBuffer | null> {
	try {
		const res = await fetch("/api/file/getFile", {
			method: "POST",
			body: JSON.stringify({ path }),
		});
		return res.ok ? res.arrayBuffer() : null;
	} catch {
		return null;
	}
}

/** Write a file to the workspace (`/api/file/putFile`, multipart upload). */
export async function siYuanPutFile(
	path: string,
	content: ArrayBuffer,
): Promise<boolean> {
	try {
		const fd = new FormData();
		fd.append("path", path);
		fd.append("file", new Blob([content]));
		const res = await fetch("/api/file/putFile", { method: "POST", body: fd });
		const json = await res.json();
		return json.code === 0;
	} catch {
		return false;
	}
}

/** Ask SiYuan to rebuild its file-tree (needed after batch pull/deletes). */
export async function siYuanRefreshFiletree(): Promise<boolean> {
	try {
		const res = await fetch("/api/filetree/refreshFiletree", {
			method: "POST",
			body: "{}",
		});
		const json = await res.json();
		return json.code === 0;
	} catch {
		return false;
	}
}

/** Delete a file from the workspace (`/api/file/removeFile`). */
export async function siYuanRemoveFile(path: string): Promise<boolean> {
	try {
		const res = await fetch("/api/file/removeFile", {
			method: "POST",
			body: JSON.stringify({ path }),
		});
		const json = await res.json();
		return json.code === 0;
	} catch {
		return false;
	}
}

/**
 * List every notebook of the workspace.
 *
 * Returns only `{ id, name }` pairs, since that is all the manifests need.
 */
export async function siYuanListNotebooks(): Promise<NotebookManifestEntry[]> {
	try {
		const res = await fetch("/api/notebook/lsNotebooks", {
			method: "POST",
			body: "{}",
		});
		const json = await res.json();
		if (json.code !== 0 || !json.data?.notebooks) return [];
		return json.data.notebooks.map((nb: any) => ({
			id: nb.id,
			name: nb.name || "",
		}));
	} catch {
		return [];
	}
}

/** Open a notebook in the UI (`/api/notebook/openNotebook`). */
export async function siYuanOpenNotebook(notebookId: string): Promise<boolean> {
	try {
		const res = await fetch("/api/notebook/openNotebook", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ notebook: notebookId }),
		});
		const json = await res.json();
		return json.code === 0;
	} catch {
		return false;
	}
}

/** Fetch a notebook's configuration (`/api/notebook/getNotebookConf`). */
export async function siYuanGetNotebookConf(notebookId: string): Promise<any> {
	try {
		const res = await fetch("/api/notebook/getNotebookConf", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ notebook: notebookId }),
		});
		const json = await res.json();
		return json.code === 0 ? json.data : null;
	} catch {
		return null;
	}
}

/** Update a notebook's configuration (`/api/notebook/setNotebookConf`). */
export async function siYuanSetNotebookConf(
	notebookId: string,
	conf: any,
): Promise<boolean> {
	try {
		const res = await fetch("/api/notebook/setNotebookConf", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ notebook: notebookId, conf }),
		});
		const json = await res.json();
		return json.code === 0;
	} catch {
		return false;
	}
}

/**
 * Read the current appearance settings (theme + light/dark mode).
 *
 * `mode` is 0 for light and 1 for dark.
 */
export async function getCurrentAppearance(): Promise<{
	mode: number;
	themeLight: string;
	themeDark: string;
} | null> {
	try {
		const res = await fetch("/api/system/getConf", {
			method: "POST",
			body: "{}",
		});
		const json = await res.json();
		if (json.code !== 0 || !json.data?.appearance) return null;
		const a = json.data.appearance;
		return {
			mode: a.mode ?? 0,
			themeLight: a.themeLight ?? "",
			themeDark: a.themeDark ?? "",
		};
	} catch {
		return null;
	}
}

/**
 * Set the active theme for the given mode (light=0 / dark=1).
 *
 * Used after a pull that installed new themes, to restore the previously
 * active theme saved inside the theme manifest.
 */
export async function setActiveTheme(
	themeDir: string,
	mode: number,
): Promise<boolean> {
	try {
		const confRes = await fetch("/api/system/getConf", {
			method: "POST",
			body: "{}",
		});
		const confJson = await confRes.json();
		if (confJson.code !== 0 || !confJson.data?.appearance) return false;
		const app = { ...confJson.data.appearance };
		if (mode === 0) app.themeLight = themeDir;
		else app.themeDark = themeDir;
		app.mode = mode;
		const res = await fetch("/api/setting/setAppearance", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ appearance: app }),
		});
		const json = await res.json();
		return json.code === 0;
	} catch {
		return false;
	}
}

/**
 * Install a plugin from the SiYuan marketplace by its name.
 *
 * Looks the package up in the bazaar, then triggers the official installer.
 */
export async function installSinglePlugin(
	pluginName: string,
): Promise<boolean> {
	try {
		const listRes = await fetch("/api/bazaar/getBazaarPlugin", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ frontend: "all", keyword: pluginName }),
		});
		const listJson = await listRes.json();
		if (listJson.code !== 0 || !listJson.data?.packages) return false;
		const pkg = listJson.data.packages.find((p: any) => p.name === pluginName);
		if (!pkg) return false;
		const installRes = await fetch("/api/bazaar/installBazaarPlugin", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				repoURL: pkg.repoURL,
				repoHash: pkg.repoHash,
				packageName: pkg.name,
				frontend: "all",
			}),
		});
		const installJson = await installRes.json();
		return installJson.code === 0;
	} catch {
		return false;
	}
}

/** Install a widget from the SiYuan marketplace by its name. */
export async function installSingleWidget(
	widgetName: string,
): Promise<boolean> {
	try {
		const listRes = await fetch("/api/bazaar/getBazaarWidget", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ keyword: widgetName }),
		});
		const listJson = await listRes.json();
		if (listJson.code !== 0 || !listJson.data?.packages) return false;
		const pkg = listJson.data.packages.find((p: any) => p.name === widgetName);
		if (!pkg) return false;
		const installRes = await fetch("/api/bazaar/installBazaarWidget", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				repoURL: pkg.repoURL,
				repoHash: pkg.repoHash,
				packageName: pkg.name,
			}),
		});
		const installJson = await installRes.json();
		return installJson.code === 0;
	} catch {
		return false;
	}
}

/** Install a theme from the SiYuan marketplace by its name. */
export async function installSingleTheme(
	themeName: string,
	mode = 0,
): Promise<boolean> {
	try {
		const listRes = await fetch("/api/bazaar/getBazaarTheme", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ keyword: themeName }),
		});
		const listJson = await listRes.json();
		if (listJson.code !== 0 || !listJson.data?.packages) return false;
		const pkg = listJson.data.packages.find((p: any) => p.name === themeName);
		if (!pkg) return false;
		const installRes = await fetch("/api/bazaar/installBazaarTheme", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				repoURL: pkg.repoURL,
				repoHash: pkg.repoHash,
				packageName: pkg.name,
				mode,
			}),
		});
		const installJson = await installRes.json();
		return installJson.code === 0;
	} catch {
		return false;
	}
}

/**
 * Recursively walk a workspace directory and build the list of files to sync.
 *
 * Each visited file is mapped to a `FileToSync` with its SiYuan path and its
 * GitHub path. Directories / files matching the exclusion rules
 * (`SKIP_ROOT_DIRS`, `SKIP_PATH_FRAGMENTS`, `LOCKED_EXTENSIONS`) are skipped.
 */
export async function collectDir(
	siBase: string,
	ghBase: string,
): Promise<FileToSync[]> {
	const entries = await siYuanReadDir(siBase);
	const files: FileToSync[] = [];

	for (const e of entries) {
		const sp = siBase === "/" ? `/${e.name}` : `${siBase}/${e.name}`;
		const gp = ghBase ? `${ghBase}/${e.name}` : e.name;

		if (SKIP_ROOT_DIRS.includes(e.name)) continue;
		if (SKIP_PATH_FRAGMENTS.some((f) => sp.includes(f))) continue;

		// Add this check to filter locked extensions
		if (LOCKED_EXTENSIONS.some((ext) => e.name.toLowerCase().endsWith(ext)))
			continue;

		if (e.isDir) files.push(...(await collectDir(sp, gp)));
		else files.push({ siYuanPath: sp, githubPath: gp });
	}
	return files;
}
