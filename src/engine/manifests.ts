/**
 * Marketplace and metadata orchestrator.
 * Generates and processes lightweight JSON manifests for installed plugins, widgets,
 * themes, and notebook names to bypass syncing volatile raw workspace folders.
 */
import {
	PluginManifest,
	PluginManifestEntry,
	NotebookManifestEntry,
	GitHubTreeItem,
	ManifestFile,
	SYNC_ROOT,
	NOTEBOOK_MANIFEST_FILE,
	PLUGIN_MANIFEST_PATH,
	WIDGET_MANIFEST_PATH,
	THEME_MANIFEST_PATH,
	PLUGIN_SELF_NAME,
} from "../shared-utils/types";
import { SiYuanAPI } from "../api/Siyuan-api";
import { GitHubAPI } from "../api/Github-api";
import { sleep } from "../shared-utils/utils";
import { t } from "../shared-utils/i18n";

/**
 * Read the locally installed plugins by scanning each plugin.json under `data/plugins`.
 *
 * The plugin itself (`PLUGIN_SELF_NAME`) is always excluded so the synced
 * manifest never references the plugin that is doing the syncing.
 */
export async function collectInstalledPlugins(siyuan: SiYuanAPI): Promise<PluginManifest> {
	const entries = await siyuan.readDir(`${SYNC_ROOT}/plugins`);
	const plugins: PluginManifestEntry[] = [];
	for (const e of entries) {
		if (!e.isDir || e.name === PLUGIN_SELF_NAME) continue;
		try {
			const raw = await siyuan.getFile(
				`${SYNC_ROOT}/plugins/${e.name}/plugin.json`,
			);
			if (!raw) continue;
			const text = new TextDecoder().decode(raw);
			const json = JSON.parse(text);
			if (json.name && json.version) {
				plugins.push({ name: json.name, version: json.version });
			}
		} catch {
			continue;
		}
	}
	return { plugins };
}

/** Build the plugin manifest file ready to be uploaded. */
export async function generatePluginManifest(siyuan: SiYuanAPI): Promise<ManifestFile> {
	const manifest = await collectInstalledPlugins(siyuan);
	const json = JSON.stringify(manifest, null, 2);
	const content = new TextEncoder().encode(json).buffer;
	return { githubPath: PLUGIN_MANIFEST_PATH, content };
}

/**
 * Install every plugin listed in a remote manifest that is missing locally.
 *
 * @returns The number of plugins actually installed.
 */
export async function installMissingPlugins(
	siyuan: SiYuanAPI,
	remoteManifest: PluginManifest,
	onProgress?: (pct: number, status: string, details: string) => void,
): Promise<number> {
	const local = await collectInstalledPlugins(siyuan);
	const localMap = new Map(local.plugins.map((p) => [p.name, p.version]));
	const toInstall = remoteManifest.plugins.filter(
		(p) => p.name !== PLUGIN_SELF_NAME && !localMap.has(p.name),
	);
	if (toInstall.length === 0) return 0;
	let installed = 0;
	for (let i = 0; i < toInstall.length; i++) {
		const p = toInstall[i];
		if (onProgress)
			onProgress(
				90 + Math.round((i / toInstall.length) * 10),
				`${t("install.plugin_prefix")} ${i + 1}/${toInstall.length}`,
				p.name,
			);
		const ok = await siyuan.installPlugin(p.name);
		if (ok) installed++;
		await sleep(200);
	}
	return installed;
}

/** Read the locally installed widgets by scanning each widget.json under `data/widgets`. */
export async function collectInstalledWidgets(siyuan: SiYuanAPI): Promise<PluginManifest> {
	const entries = await siyuan.readDir(`${SYNC_ROOT}/widgets`);
	const plugins: PluginManifestEntry[] = [];
	for (const e of entries) {
		if (!e.isDir) continue;
		try {
			const raw = await siyuan.getFile(
				`${SYNC_ROOT}/widgets/${e.name}/widget.json`,
			);
			if (!raw) continue;
			const text = new TextDecoder().decode(raw);
			const json = JSON.parse(text);
			if (json.name && json.version) {
				plugins.push({ name: json.name, version: json.version });
			}
		} catch {
			continue;
		}
	}
	return { plugins };
}

/** Build the widget manifest file ready to be uploaded. */
export async function generateWidgetManifest(siyuan: SiYuanAPI): Promise<ManifestFile> {
	const manifest = await collectInstalledWidgets(siyuan);
	const json = JSON.stringify(manifest, null, 2);
	const content = new TextEncoder().encode(json).buffer;
	return { githubPath: WIDGET_MANIFEST_PATH, content };
}

/**
 * Install every widget listed in a remote manifest that is missing locally.
 *
 * @returns The number of widgets actually installed.
 */
export async function installMissingWidgets(
	siyuan: SiYuanAPI,
	remoteManifest: PluginManifest,
	onProgress?: (pct: number, status: string, details: string) => void,
): Promise<number> {
	const local = await collectInstalledWidgets(siyuan);
	const localMap = new Map(local.plugins.map((p) => [p.name, p.version]));
	const toInstall = remoteManifest.plugins.filter((p) => !localMap.has(p.name));
	if (toInstall.length === 0) return 0;
	let installed = 0;
	for (let i = 0; i < toInstall.length; i++) {
		const p = toInstall[i];
		if (onProgress)
			onProgress(
				90 + Math.round((i / toInstall.length) * 10),
				`${t("install.widget_prefix")} ${i + 1}/${toInstall.length}`,
				p.name,
			);
		const ok = await siyuan.installWidget(p.name);
		if (ok) installed++;
		await sleep(200);
	}
	return installed;
}

/**
 * Read the locally installed themes by scanning each theme.json under `conf/appearance/themes`.
 *
 * When `includeActive` is true, the currently active light/dark themes are
 * also appended, so they can be re-applied on another device after a pull.
 */
export async function collectInstalledThemes(
	siyuan: SiYuanAPI,
	includeActive = false,
): Promise<PluginManifest> {
	const THEMES_DIR = "conf/appearance/themes";
	const entries = await siyuan.readDir(THEMES_DIR);
	const plugins: PluginManifestEntry[] = [];
	for (const e of entries) {
		if (!e.isDir) continue;
		try {
			const raw = await siyuan.getFile(`${THEMES_DIR}/${e.name}/theme.json`);
			if (!raw) continue;
			const text = new TextDecoder().decode(raw);
			const json = JSON.parse(text);
			if (json.name && json.version) {
				plugins.push({ name: json.name, version: json.version });
			}
		} catch {
			continue;
		}
	}
	const result: PluginManifest = { plugins };
	if (includeActive) {
		const appearance = await siyuan.getCurrentAppearance();
		if (appearance) {
			result.themeLight = appearance.themeLight;
			result.themeDark = appearance.themeDark;
		}
	}
	return result;
}

/** Build the theme manifest file ready to be uploaded. */
export async function generateThemeManifest(siyuan: SiYuanAPI): Promise<ManifestFile> {
	const manifest = await collectInstalledThemes(siyuan, true);
	const json = JSON.stringify(manifest, null, 2);
	const content = new TextEncoder().encode(json).buffer;
	return { githubPath: THEME_MANIFEST_PATH, content };
}

/**
 * Install every theme listed in a remote manifest that is missing locally,
 * then restore the previously active theme if any new theme was installed.
 *
 * @returns The number of themes actually installed.
 */
export async function installMissingThemes(
	siyuan: SiYuanAPI,
	remoteManifest: PluginManifest,
	onProgress?: (pct: number, status: string, details: string) => void,
): Promise<number> {
	const local = await collectInstalledThemes(siyuan);
	const localMap = new Map(
		local.plugins.map((p: PluginManifestEntry) => [p.name, p.version]),
	);
	const toInstall =
		remoteManifest.plugins?.filter(
			(p: PluginManifestEntry) => !localMap.has(p.name),
		) ?? [];
	if (toInstall.length === 0) return 0;
	const appearance = await siyuan.getCurrentAppearance();
	const currentMode = appearance?.mode ?? 0;
	let installed = 0;
	for (let i = 0; i < toInstall.length; i++) {
		const p = toInstall[i];
		if (onProgress)
			onProgress(
				90 + Math.round((i / toInstall.length) * 10),
				`${t("install.theme_prefix")} ${i + 1}/${toInstall.length}`,
				p.name,
			);
		const ok = await siyuan.installTheme(p.name, currentMode);
		if (ok) installed++;
		await sleep(200);
	}
	// Re-apply the theme that was active on the source device, so the look of
	// the workspace is preserved across devices.
	if (installed > 0) {
		const restored = await siyuan.getCurrentAppearance();
		const currentMode = restored?.mode ?? 0;
		if (currentMode === 0 && remoteManifest.themeLight) {
			await siyuan.setActiveTheme(remoteManifest.themeLight, 0);
		} else if (currentMode === 1 && remoteManifest.themeDark) {
			await siyuan.setActiveTheme(remoteManifest.themeDark, 1);
		}
	}
	return installed;
}

/**
 * Collect every notebook together with its effective display name.
 *
 * The name is read from the notebook configuration, falling back to the raw
 * notebook entry name when the config does not expose one.
 */
export async function collectNotebookManifests(siyuan: SiYuanAPI): Promise<
	NotebookManifestEntry[]
> {
	const notebooks = await siyuan.listNotebooks();
	const entries: NotebookManifestEntry[] = [];
	for (const nb of notebooks) {
		const conf = await siyuan.getNotebookConf(nb.id);
		const name = conf?.conf?.name || conf?.name || nb.name;
		if (name) entries.push({ id: nb.id, name });
	}
	return entries;
}

/**
 * Build one notebook manifest per notebook (`data/<id>/notebook.json`).
 *
 * These tiny files store the display names so a pull can restore readable
 * notebook titles (which are otherwise obfuscated along with the paths).
 */
export async function generateNotebookManifests(siyuan: SiYuanAPI): Promise<ManifestFile[]> {
	const notebooks = await collectNotebookManifests(siyuan);
	return notebooks.map((nb) => {
		const json = JSON.stringify({ id: nb.id, name: nb.name }, null, 2);
		const content = new TextEncoder().encode(json).buffer;
		return {
			githubPath: `${SYNC_ROOT}/${nb.id}/${NOTEBOOK_MANIFEST_FILE}`,
			content,
		};
	});
}

/**
 * Apply the notebook names found in remote manifests to the local notebooks.
 *
 * For every `data/<id>/notebook.json` blob found in the remote tree, the
 * notebook is opened and its display name is set from the (decrypted) manifest
 * content.
 *
 * @returns The number of notebooks whose name was restored.
 */
export async function processNotebookManifests(
	siyuan: SiYuanAPI,
	remoteItems: GitHubTreeItem[],
	github: GitHubAPI,
	decryptFn: (buf: ArrayBuffer) => Promise<ArrayBuffer>,
	onProgress?: (pct: number, status: string, details: string) => void,
): Promise<number> {
	const manifestItems = remoteItems.filter(
		(i) =>
			i.type === "blob" &&
			i.path.startsWith(`${SYNC_ROOT}/`) &&
			i.path.endsWith(`/${NOTEBOOK_MANIFEST_FILE}`),
	);
	if (manifestItems.length === 0) return 0;
	let processed = 0;

	for (let i = 0; i < manifestItems.length; i++) {
		const item = manifestItems[i];
		const notebookId = item.path.split("/")[1];
		if (!notebookId) continue;

		if (onProgress)
			onProgress(
				90 + Math.round((i / manifestItems.length) * 10),
				`${t("notebook.prefix")} ${i + 1}/${manifestItems.length}`,
				notebookId,
			);

		let content = await github.downloadBlob(item.sha);
		if (!content) continue;

		try {
			content = await decryptFn(content);
			const manifestText = new TextDecoder().decode(content);
			const manifest: NotebookManifestEntry = JSON.parse(manifestText);
			if (!manifest.name) continue;

			await siyuan.openNotebook(notebookId);
			const confData = await siyuan.getNotebookConf(notebookId);
			if (confData?.conf) {
				confData.conf.name = manifest.name;
				await siyuan.setNotebookConf(notebookId, confData.conf);
			}
			processed++;
			await sleep(50);
		} catch {
			continue;
		}
	}
	return processed;
}
