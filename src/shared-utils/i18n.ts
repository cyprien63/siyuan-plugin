/**
 * Lightweight internationalization (i18n) for the plugin.
 *
 * There is no external i18n library: translations live in a plain map of
 * locale -> key -> string (English, French and Chinese). The current locale is
 * a module-level variable toggled by `setLocale()`, and every UI string goes
 * through `t()` so the plugin can switch language at runtime.
 */
type LocaleMap = { [key: string]: string };

/** Human-readable labels for every supported locale (used in the language select). */
export const langs: Record<string, string> = {
	fr: "Français",
	en: "English",
	zh: "简体中文",
};

/** All translation strings, indexed by locale, then by dotted key. */

const locales: Record<string, LocaleMap> = {
	"action.pull": {
		fr: "⏳ Pull en cours...",
		en: "⏳ Pull in progress...",
		zh: "⏳ 正在拉取...",
	},
	"action.push": {
		fr: "⏳ Push en cours...",
		en: "⏳ Push in progress...",
		zh: "⏳ 正在推送...",
	},

	"button.close": {
		fr: "Fermer",
		en: "Close",
		zh: "关闭",
	},
	"button.confirm": {
		fr: "✔️ Confirmer et ré-uploader",
		en: "✔️ Confirm and re-upload",
		zh: "✔️ 确认并重新上传",
	},
	"button.export": {
		fr: "📥 Exporter",
		en: "📥 Export",
		zh: "📥 导出配置",
	},
	"button.hide": {
		fr: "Masquer",
		en: "Hide",
		zh: "隐藏",
	},
	"button.import": {
		fr: "📤 Importer",
		en: "📤 Import",
		zh: "📤 导入配置",
	},
	"button.refresh": {
		fr: "🔄 Rafraîchir",
		en: "🔄 Refresh",
		zh: "🔄 刷新",
	},
	"button.reset_repo": {
		fr: "🗑️ Réinitialiser le dépôt",
		en: "🗑️ Reset Repository",
		zh: "🗑️ 重置存储库",
	},
	"button.restore": {
		fr: "Restaurer",
		en: "Restore",
		zh: "恢复",
	},
	"button.show": {
		fr: "Afficher",
		en: "Show",
		zh: "显示",
	},
	"button.test_github": {
		fr: "🧪 Tester GitHub",
		en: "🧪 Test GitHub",
		zh: "🧪 测试连接",
	},

	"dialog.remove_encryption_body": {
		fr: `Le dépôt distant va être ré-uploadé SANS chiffrement :
	• tout le contenu sera ré-uploadé en clair (les NOMS des carnets seront aussi restaurés)
	• tous les anciens fichiers chiffrés seront supprimés du dépôt pour que personne ne puisse les récupérer.
Confirmez pour continuer`,
		en: `The remote repository will be re-pushed WITHOUT encryption:
	• all content will be re-uploaded in cleartext (notebook NAMES will be restored too)
	• every old encrypted file will be deleted from the remote so nobody can recover it.
Confirm to continue`,
		zh: `远程仓库将被重新推送且不使用加密：
	• 所有内容将以明文形式重新上传（笔记本名称也将恢复
	• 每一个旧的加密文件都将从远程仓库删除，以确保无人可以恢复
确认以继续`,
	},
	"dialog.remove_encryption_title": {
		fr: "🔓 Supprimer le chiffrement",
		en: "🔓 Remove encryption",
		zh: "🔓 移除加密",
	},
	"dialog.remove_encryption_warning": {
		fr: `Si vous devez modifier ou supprimer votre mot de passe, vous devez réinitialiser votre dépôt.
	• Cette opération supprimera tous les fichiers du dépôt.
Confirmer pour continuer`,
		en: `If you need to change or remove your password, you need to reset your repository.
		• With this operation, all files in the repository will be deleted and it will be necessary to be pushed again with the newly desired configuration.
Confirm to continue`,
		zh: `如果您需要更改或删除密码，则需要重置您的存储库
	• 此操作将删除存储库中的所有文件，您需要使用新的配置重新推送存储库。
确认继续`,
	},
	"dialog.reset_repo_title": {
		fr: "🗑️ SUPPRIMER TOUS les fichiers du dépôt",
		en: "🗑️ DELETE ALL files from repository",
		zh: "🗑️ 从存储库中删除所有文件",
	},

	"diff.cancel": {
		fr: "❌ Annuler",
		en: "❌ Cancel",
		zh: "❌ 取消",
	},
	"diff.conflicts": {
		fr: "conflit(s)",
		en: "conflict(s)",
		zh: "冲突文件",
	},
	"diff.files_to_delete": {
		fr: "fichier(s) à supprimer",
		en: "file(s) to remove",
		zh: "待删除文件",
	},
	"diff.files_to_upload": {
		fr: "fichier(s) à envoyer",
		en: "file(s) to send",
		zh: "待发送文件",
	},
	"diff.files_unchanged": {
		fr: "fichier(s) inchangé(s)",
		en: "file(s) unchanged",
		zh: "未修改文件",
	},
	"diff.no_changes": {
		fr: "Aucun changement détecté",
		en: "No changes detected",
		zh: "未检测到更改",
	},
	"diff.other": {
		fr: "autre(s) fichier(s)",
		en: "other file(s)",
		zh: "其他文件",
	},
	"diff.send": {
		fr: "🚀 Envoyer",
		en: "🚀 Send",
		zh: "🚀 发送",
	},
	"diff.skipped_large": {
		fr: "fichier(s) ignoré(s) (>25 Mo)",
		en: "file(s) skipped (>25 MB)",
		zh: "跳过文件 (>25 MB)",
	},
	"diff.title": {
		fr: "📊 Résumé avant envoi",
		en: "📊 Summary before push",
		zh: "📊 推送前确认",
	},

	"error.bad_password": {
		fr: "❌ Mot de passe de chiffrement invalide pour le dépôt distant.",
		en: "❌ Invalid encryption password for remote repository.",
		zh: "❌ 远程仓库的加密密码无效。",
	},
	"error.file_too_large": {
		fr: "⚠️ Fichier trop volumineux (>25 Mo). Ignoré.",
		en: "⚠️ File too large (>25 MB). Ignored.",
		zh: "⚠️ 文件过大 (>25 MB)，已跳过。",
	},
	"error.invalid_file": {
		fr: "❌ Fichier invalide.",
		en: "❌ Invalid file.",
		zh: "❌ 无效文件。",
	},
	"error.no_internet": {
		fr: "❌ Pas de connexion internet. Vérifie ta connexion.",
		en: "❌ No internet connection. Check your network.",
		zh: "❌ 无网络连接。",
	},
	"error.password_required": {
		fr: "❌ Saisissez le mot de passe de chiffrement actuel pour confirmer la suppression.",
		en: "❌ Enter the current encryption password to confirm removal.",
		zh: "❌ 请输入当前加密密码以确认移除。",
	},
	"error.pull_verification_failed": {
		fr: "❌ Vérification du pull échouée. Le dépôt distant a peut-être été modifié en dehors de ce plugin. Veuillez vérifier les erreurs dans la console ou le dépôt.",
		en: "❌ Pull verification failed. The remote repository may have been modified outside of this plugin. Please check errors in the console or the repository",
		zh: "❌ 拉取验证失败。远程仓库可能已被外部修改。请检查控制台或仓库中的错误。",
	},
	"error.rate_limit": {
		fr: "❌ Limite d'appels API GitHub atteinte. Réessaie dans 1 minute.",
		en: "❌ GitHub API rate limit reached. Try again in 1 minute.",
		zh: "❌ 达到 GitHub API 速率限制。请稍后重试。",
	},
	"error.repo_not_found": {
		fr: "❌ Dépôt GitHub introuvable. Vérifie le nom du dépôt dans Paramètres.",
		en: "❌ GitHub repository not found. Check the repository name in Settings.",
		zh: "❌ 未找到 GitHub 仓库。",
	},
	"error.request_aborted": {
		fr: "❌ Requête annulée (timeout). Réessaie.",
		en: "❌ Request aborted (timeout). Try again.",
		zh: "❌ 请求被中止 (超时)。",
	},
	"error.token_invalid": {
		fr: "❌ Token GitHub invalide ou expiré. Va dans Paramètres -> générer un nouveau token.",
		en: "❌ GitHub token invalid or expired. Go to Settings -> generate a new token.",
		zh: "❌ GitHub token 无效或已过期。",
	},

	"hint.encryption_password": {
		fr: "Entrez un mot de passe pour activer le chiffrement côté client. NE le perdez PAS : sans lui les données ne pourront pas être déchiffrées.",
		en: "Enter a password to enable client-side encryption. Do NOT lose it : without it data cannot be decrypted.",
		zh: "输入密码以启用客户端加密。请勿丢失，否则数据将无法解密。",
	},
	"hint.remove_encryption": {
		fr: "⚠️ Action irréversible : une fois les anciennes données chiffrées supprimées, elles ne pourront plus être récupérées.",
		en: "⚠️ Irreversible: once the old encrypted data is deleted it cannot be recovered.",
		zh: "⚠️ 不可逆操作：旧加密数据一旦被删除将无法恢复。",
	},

	"history.loading": {
		fr: "Chargement...",
		en: "Loading...",
		zh: "加载中...",
	},
	"history.no_commits": {
		fr: "Aucun commit trouvé.",
		en: "No commits found.",
		zh: "未找到提交记录。",
	},
	"history.restore_failed": {
		fr: "❌ Restauration échouée :",
		en: "❌ Restore failed:",
		zh: "❌ 恢复失败：",
	},

	"install.plugin_prefix": {
		fr: "Installation plugin :",
		en: "Installing plugin :",
		zh: "安装插件：",
	},
	"install.theme_prefix": {
		fr: "Installation thème :",
		en: "Installing theme :",
		zh: "安装主题：",
	},
	"install.widget_prefix": {
		fr: "Installation widget :",
		en: "Installing widget :",
		zh: "安装挂件：",
	},

	"merge.compare": {
		fr: "Comparaison local / distant / dernière sync...",
		en: "Compare local / remote / last sync...",
		zh: "对比本地/远程/上次同步...",
	},
	"merge.status": {
		fr: "Merge...",
		en: "Merge...",
		zh: "合并中...",
	},

	"msg.config_exported": {
		fr: "✅ Config exportée",
		en: "✅ Config exported",
		zh: "✅ 配置已导出",
	},
	"msg.config_loaded": {
		fr: "✅ Config chargée. Appuie sur Enregistrer.",
		en: "✅ Config loaded. Press Save.",
		zh: "✅ 配置已加载，请点击保存。",
	},
	"msg.configure_plugin": {
		fr: "⚠️ Configurez le plugin.",
		en: "⚠️ Configure the plugin.",
		zh: "⚠️ 请先配置插件。",
	},
	"msg.conflicts_unresolved": {
		fr: "conflit(s) non résolu(s) (modifié des 2 côtés)",
		en: "conflict(s) unresolved (modified on both sides)",
		zh: "个冲突未解决（双向修改）",
	},
	"msg.encryption_removed": {
		fr: "✅ Chiffrement supprimé : le dépôt a été ré-uploadé en clair.",
		en: "✅ Encryption removed: the repository has been re-uploaded in cleartext.",
		zh: "✅ 已移除加密：远程仓库已重新以明文上传。",
	},
	"msg.errors": {
		fr: "⚠️ {n} erreur(s): Ouvrez les outils de développement pour afficher les détails (ctrl+shift+i).",
		en: "⚠️ {n} error(s): Open dev tools to see details (ctrl+shift+i).",
		zh: "⚠️ 发生 {n} 个错误：打开开发者工具查看详情 (Ctrl+Shift+I)。",
	},
	"msg.errors_occurred": {
		fr: " ⚠️ {n} erreur(s). Ouvrez les outils de développement pour le détail (ctrl+shift+i).",
		en: " ⚠️ {n} error(s). Open developer tools for details (ctrl+shift+i).",
		zh: " ⚠️ 发生 {n} 个错误：打开开发者工具查看详情 (Ctrl+Shift+I)。",
	},
	"msg.export_warning": {
		fr: "⚠️ Attention : le fichier exporté contient des données sensibles telles que votre mot de passe, votre jeton d'accès personnel (PAT) et votre clé API groq. Ne partagez pas ce fichier.",
		en: "⚠️ Warning: exported file will contain sensitive data such as your password, PAT and groq API key. Do not share this file.",
		zh: "⚠️警告：导出的文件将包含敏感数据，例如您的密码、PAT 和 groq API 密钥。请勿共享此文件。",
	},
	"msg.export_warning_prefix": {
		fr: "⚠️ Attention : le fichier exporté contiendra",
		en: "⚠️ Warning: exported file will contain",
		zh: "⚠️ 警告：导出的文件将包含",
	},
	"msg.file_deleted": {
		fr: "(fichier supprimé)",
		en: "(file deleted)",
		zh: "(文件已删除)",
	},
	"msg.language_changed": {
		fr: "Langue (requiert un redémarrage)",
		en: "Language set, please restart",
		zh: "语言 (需要重启)",
	},
	"msg.no_changes_conflicts": {
		fr: "Aucun changement à envoyer. ⚠️ {n} conflit(s) ignoré(s).",
		en: "No changes to send. ⚠️ {n} conflict(s) ignored.",
		zh: "没有需要发送的更改。⚠️ 已忽略 {n} 个冲突。",
	},
	"msg.no_changes_none": {
		fr: "Tout est à jour ! Aucun envoi nécessaire.",
		en: "Everything is already up to date! Nothing to send.",
		zh: "一切都是最新的！",
	},
	"msg.notebooks_processed": {
		fr: "📖 {n} carnet(s) ouvert(s).",
		en: "📖 {n} notebook(s) opened.",
		zh: "📖 打开了 {n} 个笔记本。",
	},
	"msg.password_forgot": {
		fr: "Mot de passe de chiffrement effacé de la mémoire ; vous ne pourrez plus déchiffrer les données précédemment envoyées sans lui.",
		en: "Encryption password cleared from memory; you will not be able to decrypt previously uploaded data without it.",
		zh: "加密密码已从内存中清除。在不重新输入密码的情况下，将无法解密之前上传的数据。",
	},
	"msg.plugins_installed": {
		fr: "🧩 {n} plugin(s) installé(s).",
		en: "🧩 {n} plugin(s) installed.",
		zh: "🧩 安装了 {n} 个插件。",
	},
	"msg.pull_done": {
		fr: "Pull terminé : {updated} fichiers mis à jour, {skipped} à jour ou protégés, {deleted} supprimé(s).",
		en: "Pull completed : {updated} files updated, {skipped} skipped, {deleted} deleted.",
		zh: "拉取完成：更新 {updated} 个，跳过 {skipped} 个，删除 {deleted} 个。",
	},
	"msg.push_done_prefix": {
		fr: "Push terminé :",
		en: "Push completed :",
		zh: "推送完成：",
	},
	"msg.push_initial_done": {
		fr: "Push initial terminé : {n} fichiers envoyés.",
		en: "Initial push completed : {n} files sent.",
		zh: "初始推送完成，共发送 {n} 个文件。",
	},
	"msg.repo_cleared": {
		fr: "undefined",
		en: `✅ Repository successfully emptied.\n
			You can now push your workplace anew.

			Change or remove password as desired before pushing.`,
		zh: "undefined",
	},
	"msg.repo_empty": {
		fr: "Le dépôt est vide. Faites un Push d'abord.",
		en: "Repository is empty. Do a Push first.",
		zh: "仓库为空。请先进行推送。",
	},
	"msg.restored": {
		fr: "✅ Restauré : {n} fichiers (commit: {sha} - {message})",
		en: "✅ Restored: {n} files (commit: {sha} - {message})",
		zh: "✅ 已恢复：{n} 个文件 (commit: {sha} - {message})",
	},
	"msg.saved": {
		fr: "✅ Enregistré",
		en: "✅ Saved",
		zh: "✅ 已保存",
	},
	"msg.skipped_files": {
		fr: "fichier(s) ignoré(s) (>25 Mo)",
		en: "file(s) skipped (>25 MB)",
		zh: "个文件已跳过 (>25 MB)",
	},
	"msg.themes_installed": {
		fr: "🎨 {n} thème(s) installé(s).",
		en: "🎨 {n} theme(s) installed.",
		zh: "🎨 安装了 {n} 个主题。",
	},
	"msg.widgets_installed": {
		fr: "📦 {n} widget(s) installé(s).",
		en: "📦 {n} widget(s) installed.",
		zh: "📦 安装了 {n} 个挂件。",
	},

	"notebook.prefix": {
		fr: "Carnet :",
		en: "Notebook :",
		zh: "笔记本：",
	},

	"part.and": {
		fr: " et ",
		en: " and ",
		zh: " 和 ",
	},
	"part.export_warning_suffix": {
		fr: ` en clair.\nNe partagez pas ce fichier.`,
		en: ` in cleartext.\nDo not share this file.`,
		zh: ` 的明文。\n请勿分享此文件。`,
	},
	"part.other": {
		fr: "autre",
		en: "other",
		zh: "其他",
	},
	"part.the": {
		fr: "le ",
		en: "the ",
		zh: "",
	},

	"placeholder.current_password": {
		fr: "Mot de passe actuel",
		en: "Current password",
		zh: "当前密码",
	},

	"progress.analysis": {
		fr: "Analyse...",
		en: "Analysis...",
		zh: "分析中...",
	},
	"progress.cleaning_enc": {
		fr: "Suppression des anciens fichiers chiffrés...",
		en: "Deleting remote files...",
		zh: "正在删除旧加密文件...",
	},
	"progress.creating_tree": {
		fr: "Création de l'arbre...",
		en: "Creating tree...",
		zh: "创建文件树...",
	},
	"progress.finalizing": {
		fr: "Finalisation...",
		en: "Finalizing...",
		zh: "完成中...",
	},
	"progress.reading_remote": {
		fr: "Lecture du dépôt distant...",
		en: "Reading remote repository...",
		zh: "读取远程仓库...",
	},
	"progress.removing_encryption": {
		fr: "Suppression du chiffrement...",
		en: "Removing encryption...",
		zh: "正在移除加密...",
	},
	"progress.upload_plugin_manifest": {
		fr: "Upload manifeste plugins...",
		en: "Upload plugin manifest...",
		zh: "上传插件清单...",
	},
	"progress.upload_theme_manifest": {
		fr: "Upload manifeste thèmes...",
		en: "Upload theme manifest...",
		zh: "上传主题清单...",
	},
	"progress.upload_widget_manifest": {
		fr: "Upload manifeste widgets...",
		en: "Upload widget manifest...",
		zh: "上传挂件清单...",
	},
	"progress.uploading_plaintext": {
		fr: "Ré-upload en clair ({n})...",
		en: "Re-uploading in cleartext ({n})...",
		zh: "正在以明文重新上传 ({n})...",
	},
	"progress.verifying_password": {
		fr: "Vérification de l'ancien mot de passe...",
		en: "Verifying old password...",
		zh: "正在验证旧密码...",
	},
	"progress.cleanup": {
		fr: "Nettoyage en cours...",
		en: "Cleaning up...",
		zh: "正在清理...",
	},
	"progress.cleaning_local": {
		fr: "Suppression des fichiers locaux obsolètes...",
		en: "Deleting stale local files...",
		zh: "正在删除过期的本地文件……",
	},
	"progress.pull_calculation": {
		fr: "Calcul du plan de pull...",
		en: "Calculating pull plan...",
		zh: "正在计算拉取计划...",
	},
	"progress.restore_environment": {
		fr: "Restauration de l'environnement",
		en: "Restoring environment",
		zh: "正在恢复环境",
	},
	"progress.process_manifests": {
		fr: "Traitement des manifestes...",
		en: "Processing manifests...",
		zh: "正在处理清单文件...",
	},
	"progress.update_state": {
		fr: "Mise à jour de l'état...",
		en: "Updating state...",
		zh: "正在更新状态...",
	},
	"progress.checking_remote_files": {
		fr: "Vérification des fichiers distants :",
		en: "Checking remote files:",
		zh: "正在检查远程文件：",
	},

	"setting.actions": {
		fr: "Actions",
		en: "Actions",
		zh: "操作",
	},
	"setting.encryption_password": {
		fr: "Mot de passe de chiffrement",
		en: "Encryption password",
		zh: "加密密码",
	},
	"setting.encryption_salt": {
		fr: "Sel de chiffrement",
		en: "Encryption salt",
		zh: "加密盐值",
	},
	"setting.github_repo": {
		fr: "GitHub Dépôt",
		en: "GitHub Repo",
		zh: "GitHub 仓库名",
	},
	"setting.github_token": {
		fr: "GitHub Token PAT",
		en: "GitHub Token PAT",
		zh: "GitHub Token (PAT)",
	},
	"setting.github_user": {
		fr: "GitHub Utilisateur",
		en: "GitHub User",
		zh: "GitHub 用户名",
	},
	"setting.groq_key": {
		fr: "Clé API Groq (optionnel)",
		en: "Groq API Key (optional)",
		zh: "Groq API Key (可选)",
	},
	"setting.language": {
		fr: "Langue (requiert un redémarrage)",
		en: "Language (requires restart)",
		zh: "语言 (需要重启)",
	},
	"setting.show_diff": {
		fr: "Afficher le diff avant push",
		en: "Show diff before push",
		zh: "推送前显示差异",
	},

	"stat.deleted": {
		fr: "supprimé(s)",
		en: "deleted",
		zh: "已删除",
	},
	"stat.pulled": {
		fr: "récupéré(s)",
		en: "pulled",
		zh: "已拉取",
	},
	"stat.sent": {
		fr: "envoyé(s)",
		en: "sent",
		zh: "已发送",
	},
	"stat.unchanged": {
		fr: "inchangé(s)",
		en: "unchanged",
		zh: "未修改",
	},

	"status.error": {
		fr: "❌ Erreur",
		en: "❌ Error",
		zh: "❌ 错误",
	},
	"status.initializing": {
		fr: "Initialisation...",
		en: "Initializing...",
		zh: "初始化...",
	},
	"status.ok": {
		fr: "✅ OK",
		en: "✅ OK",
		zh: "✅ 正常",
	},

	"top.history_title": {
		fr: "🕒 Historique des commits",
		en: "🕒 Commit history",
		zh: "🕒 历史记录",
	},
	"top.pull_title": {
		fr: "⬇️ Smart Pull (Incrémental)",
		en: "⬇️ Smart Pull (Incremental)",
		zh: "⬇️ 智能拉取 (增量)",
	},
	"top.push_title": {
		fr: "⬆️ Smart Push (Incrémental)",
		en: "⬆️ Smart Push (Incremental)",
		zh: "⬆️ 智能上传 (增量)",
	},

	"ui.done": {
		fr: "✅ Terminé",
		en: "✅ Done",
		zh: "✅ 完成",
	},
	"ui.error": {
		fr: "❌ Erreur",
		en: "❌ Error",
		zh: "❌ 错误",
	},
};

/** Locale currently in use. Defaults to English. */
let current = "en";

/**
 * Translate a dotted key (e.g. `"status.ok"`) into the current locale.
 *
 * Returns the key itself when no translation exists, so missing strings are
 * visible instead of silently disappearing.
 */
export function t(key: string): string {
	// return key of selected language
	// if it doesn't exist, return english key
	// if it doesn't exist, return key
	return locales[key]?.[current] ?? locales[key]?.["en"] ?? key;
}

/** Return the currently active locale code. */
export function getLocale(): string {
	return current;
}

/** Switch the active locale (ignored silently if the locale is unknown). */
export function setLocale(l: string) {
	if (langs[l]) {
		current = l;
		return;
	}

	const localeCode = Object.entries(langs).find(([, label]) => label === l)?.[0];
	if (localeCode) current = localeCode;
}

/** List of every supported locale code. */
export function availableLocales(): string[] {
	return Object.keys(langs);
}
