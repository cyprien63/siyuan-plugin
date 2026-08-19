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
	// ------------------------------------------------------------------------
	// FRENCH
	// ------------------------------------------------------------------------
	fr: {
		"status.initializing": "Initialisation...",
		"status.ok": "✅ OK",
		"status.error": "❌ Erreur",

		"top.push_title": "⬆️ Smart Push (Incrémental)",
		"top.pull_title": "⬇️ Smart Pull (Incrémental)",
		"top.history_title": "🕒 Historique des commits",

		"setting.github_user": "GitHub Utilisateur",
		"setting.github_repo": "GitHub Dépôt",
		"setting.github_token": "GitHub Token PAT",
		"setting.groq_key": "Clé API Groq (optionnel)",
		"setting.show_diff": "Afficher le diff avant push",
		"setting.actions": "Actions",
		"setting.language": "Langue (requiert un redémarrage)",
		"setting.encryption_password": "Mot de passe de chiffrement",
		"setting.encryption_salt": "Sel de chiffrement",

		"hint.encryption_password":
			"Entrez un mot de passe pour activer le chiffrement côté client. NE le perdez PAS : sans lui les données ne pourront pas être déchiffrées.",
		"msg.password_forgot":
			"Mot de passe de chiffrement effacé de la mémoire ; vous ne pourrez plus déchiffrer les données précédemment envoyées sans lui.",

		"dialog.remove_encryption_title": "🔓 Supprimer le chiffrement",
		"dialog.remove_encryption_body":
			"Le dépôt distant va être ré-uploadé SANS chiffrement :\n• tout le contenu sera ré-uploadé en clair (les NOMS des carnets seront aussi restaurés)\n• tous les anciens fichiers chiffrés seront supprimés du dépôt pour que personne ne puisse les récupérer.\n\nPour continuer, saisissez votre mot de passe de chiffrement ACTUEL. S'il est incorrect, la suppression sera refusée.",
		"placeholder.current_password": "Mot de passe actuel",
		"button.confirm": "✔️ Confirmer et ré-uploader",
		"hint.remove_encryption":
			"⚠️ Action irréversible : une fois les anciennes données chiffrées supprimées, elles ne pourront plus être récupérées.",
		"error.password_required":
			"❌ Saisissez le mot de passe de chiffrement actuel pour confirmer la suppression.",
		"msg.encryption_removed":
			"✅ Chiffrement supprimé : le dépôt a été ré-uploadé en clair.",
		"progress.removing_encryption": "Suppression du chiffrement...",
		"progress.verifying_password": "Vérification de l'ancien mot de passe...",
		"progress.cleaning_enc": "Suppression des anciens fichiers chiffrés...",
		"progress.uploading_plaintext": "Ré-upload en clair ({n})...",


		"button.test_github": "🧪 Tester GitHub",
		"button.export": "📥 Exporter",
		"button.import": "📤 Importer",
		"button.close": "Fermer",
		"button.refresh": "🔄 Rafraîchir",
		"button.restore": "Restaurer",
		"button.forget_password": "🗑️ Oublier le mot de passe",
		"button.show": "Afficher",
		"button.hide": "Masquer",

		"msg.export_warning_prefix": "⚠️ Attention : le fichier exporté contiendra",
		"msg.config_exported": "✅ Config exportée",
		"msg.config_loaded": "✅ Config chargée. Appuie sur Enregistrer.",
		"msg.saved": "✅ Enregistré",
		"msg.configure_plugin": "⚠️ Configurez le plugin.",

		"part.the": "le ",
		"part.and": " et ",
		"part.export_warning_suffix": " en clair.\nNe partagez pas ce fichier.",
		"part.other": "autre",

		"progress.analysis": "Analyse...",
		"progress.reading_remote": "Lecture du dépôt distant...",

		"diff.title": "📊 Résumé avant envoi",
		"diff.send": "🚀 Envoyer",
		"diff.cancel": "❌ Annuler",
		"diff.no_changes": "Aucun changement détecté",
		'diff.files_to_upload': 'fichier(s) à envoyer',
		'diff.files_to_delete': 'fichier(s) à supprimer',
		'diff.files_unchanged': 'fichier(s) inchangé(s)',
		'diff.conflicts': 'conflit(s)',
		'diff.skipped_large': 'fichier(s) ignoré(s) (>25 Mo)',
		'diff.other': 'autre(s) fichier(s)',

		"ui.done": "✅ Terminé",
		"ui.error": "❌ Erreur",

		"history.no_commits": "Aucun commit trouvé.",
		"history.loading": "Chargement...",
		"history.restore_failed": "❌ Restauration échouée :",

		"error.token_invalid":
			"❌ Token GitHub invalide ou expiré. Va dans Paramètres -> générer un nouveau token.",
		"error.repo_not_found":
			"❌ Dépôt GitHub introuvable. Vérifie le nom du dépôt dans Paramètres.",
		"error.no_internet": "❌ Pas de connexion internet. Vérifie ta connexion.",
		"error.rate_limit":
			"❌ Limite d'appels API GitHub atteinte. Réessaie dans 1 minute.",
		"error.request_aborted": "❌ Requête annulée (timeout). Réessaie.",
		"error.bad_password": "❌ Mot de passe de chiffrement invalide pour le dépôt distant.",
		"error.file_too_large": "⚠️ Fichier trop volumineux (>25 Mo). Ignoré.",
		"error.invalid_file": "❌ Fichier invalide.",
		"error.pull_verification_failed":
			"❌ Vérification du pull échouée. Le dépôt distant a peut-être été modifié en dehors de ce plugin. Veuillez vérifier les erreurs dans la console ou le dépôt.",

		"merge.status": "Merge...",
		"merge.compare": "Comparaison local / distant / dernière sync...",

		"msg.no_changes_conflicts":
			"Aucun changement à envoyer. ⚠️ {n} conflit(s) ignoré(s).",
		"msg.no_changes_none": "Tout est à jour ! Aucun envoi nécessaire.",
		"msg.file_deleted": "(fichier supprimé)",

		"progress.upload_plugin_manifest": "Upload manifeste plugins...",
		"progress.upload_widget_manifest": "Upload manifeste widgets...",
		"progress.upload_theme_manifest": "Upload manifeste thèmes...",
		"progress.finalizing": "Finalisation...",
		"progress.creating_tree": "Création de l'arbre...",

		"stat.sent": "envoyé(s)",
		"stat.pulled": "récupéré(s)",
		"stat.deleted": "supprimé(s)",
		"stat.unchanged": "inchangé(s)",

		"msg.push_done_prefix": "Push terminé :",
		"msg.push_initial_done": "Push initial terminé : {n} fichiers envoyés.",
		"msg.repo_empty": "Le dépôt est vide. Faites un Push d'abord.",
		"msg.skipped_files": "fichier(s) ignoré(s) (>25 Mo)",
		"msg.conflicts_unresolved":
			"conflit(s) non résolu(s) (modifié des 2 côtés)",

		"install.plugin_prefix": "Installation plugin :",
		"install.widget_prefix": "Installation widget :",
		"install.theme_prefix": "Installation thème :",

		"notebook.prefix": "Carnet :",

		"msg.pull_done":
			"Pull terminé : {updated} fichiers mis à jour, {skipped} à jour ou protégés, {deleted} supprimé(s).",
		"msg.plugins_installed": "🧩 {n} plugin(s) installé(s).",
		"msg.widgets_installed": "📦 {n} widget(s) installé(s).",
		"msg.themes_installed": "🎨 {n} thème(s) installé(s).",
		"msg.notebooks_processed": "📖 {n} carnet(s) ouvert(s).",
		"msg.errors":
			"⚠️ {n} erreur(s): Ouvrez les outils de développement pour afficher les détails (ctrl+shift+i).",
		"msg.errors_occurred":
			" ⚠️ {n} erreur(s). Ouvrez les outils de développement pour le détail (ctrl+shift+i).",
		"msg.restored": "✅ Restauré : {n} fichiers (commit: {sha} - {message})",

		"action.push": "⏳ Push en cours...",
		"action.pull": "⏳ Pull en cours...",
	},
	// ------------------------------------------------------------------------
	// ENGLISH
	// ------------------------------------------------------------------------
	en: {
		"status.initializing": "Initializing...",
		"status.ok": "✅ OK",
		"status.error": "❌ Error",

		"top.push_title": "⬆️ Smart Push (Incremental)",
		"top.pull_title": "⬇️ Smart Pull (Incremental)",
		"top.history_title": "🕒 Commit history",

		"setting.github_user": "GitHub User",
		"setting.github_repo": "GitHub Repo",
		"setting.github_token": "GitHub Token PAT",
		"setting.groq_key": "Groq API Key (optional)",
		"setting.show_diff": "Show diff before push",
		"setting.actions": "Actions",
		"setting.language": "Language (requires restart)",

		"button.test_github": "🧪 Test GitHub",
		"button.export": "📥 Export",
		"button.import": "📤 Import",
		"button.close": "Close",
		"button.refresh": "🔄 Refresh",
		"button.restore": "Restore",
		"button.forget_password": "🗑️ Forget password",
		"button.show": "Show",
		"button.hide": "Hide",

		"msg.export_warning_prefix": "⚠️ Warning: exported file will contain",
		"msg.config_exported": "✅ Config exported",
		"msg.config_loaded": "✅ Config loaded. Press Save.",
		"msg.saved": "✅ Saved",
		"msg.configure_plugin": "⚠️ Configure the plugin.",

		"setting.encryption_password": "Encryption password",
		"setting.encryption_salt": "Encryption salt",
		"hint.encryption_password":
			"Enter a password to enable client-side encryption. Do NOT lose it : without it data cannot be decrypted.",
		"msg.password_forgot":
			"Encryption password cleared from memory; you will not be able to decrypt previously uploaded data without it.",

		"dialog.remove_encryption_title": "🔓 Remove encryption",
		"dialog.remove_encryption_body":
			"The remote repository will be re-pushed WITHOUT encryption:\n• all content will be re-uploaded in cleartext (notebook NAMES will be restored too)\n• every old encrypted file will be deleted from the remote so nobody can recover it.\n\nTo continue, enter your CURRENT encryption password. If it is wrong, the operation is refused.",
		"placeholder.current_password": "Current password",
		"button.confirm": "✔️ Confirm and re-upload",
		"hint.remove_encryption":
			"⚠️ Irreversible: once the old encrypted data is deleted it cannot be recovered.",
		"error.password_required":
			"❌ Enter the current encryption password to confirm removal.",
		"msg.encryption_removed":
			"✅ Encryption removed: the repository has been re-uploaded in cleartext.",
		"progress.removing_encryption": "Removing encryption...",
		"progress.verifying_password": "Verifying old password...",
		"progress.cleaning_enc": "Deleting old encrypted files...",
		"progress.uploading_plaintext": "Re-uploading in cleartext ({n})...",

		"part.the": "the ",
		"part.and": " and ",
		"part.export_warning_suffix": " in cleartext.\nDo not share this file.",
		"part.other": "other",

		"progress.analysis": "Analysis...",
		"progress.reading_remote": "Reading remote repository...",

		"diff.title": "📊 Summary before push",
		"diff.send": "🚀 Send",
		"diff.cancel": "❌ Cancel",
		"diff.no_changes": "No changes detected",
		'diff.files_to_upload': 'file(s) to send',
		'diff.files_to_delete': 'file(s) to remove',
		'diff.files_unchanged': 'file(s) unchanged',
		'diff.conflicts': 'conflict(s)',
		'diff.skipped_large': 'file(s) skipped (>25 MB)',
		'diff.other': 'other file(s)',

		"ui.done": "✅ Done",
		"ui.error": "❌ Error",
		"history.no_commits": "No commits found.",
		"history.loading": "Loading...",
		"history.restore_failed": "❌ Restore failed:",

		"error.token_invalid":
			"❌ GitHub token invalid or expired. Go to Settings -> generate a new token.",
		"error.repo_not_found":
			"❌ GitHub repository not found. Check the repository name in Settings.",
		"error.no_internet": "❌ No internet connection. Check your network.",
		"error.rate_limit":
			"❌ GitHub API rate limit reached. Try again in 1 minute.",
		"error.request_aborted": "❌ Request aborted (timeout). Try again.",
		"error.bad_password": "❌ Invalid encryption password for remote repository.",
		"error.file_too_large": "⚠️ File too large (>25 MB). Ignored.",
		"error.invalid_file": "❌ Invalid file.",
		"error.pull_verification_failed": "❌ Pull verification failed. The remote repository may have been modified outside of this plugin. Please check errors in the console or the repository",

		"merge.status": "Merge...",
		"merge.compare": "Compare local / remote / last sync...",
		"msg.no_changes_conflicts":
			"No changes to send. ⚠️ {n} conflict(s) ignored.",
		"msg.no_changes_none": "Everything is already up to date! Nothing to send.",
		"msg.file_deleted": "(file deleted)",
		"progress.upload_plugin_manifest": "Upload plugin manifest...",
		"progress.upload_widget_manifest": "Upload widget manifest...",
		"progress.upload_theme_manifest": "Upload theme manifest...",
		"progress.finalizing": "Finalizing...",
		"progress.creating_tree": "Creating tree...",
		"stat.sent": "sent",
		"stat.pulled": "pulled",
		"stat.deleted": "deleted",
		"stat.unchanged": "unchanged",
		"msg.push_done_prefix": "Push completed :",
		"msg.push_initial_done": "Initial push completed : {n} files sent.",
		"msg.repo_empty": "Repository is empty. Do a Push first.",
		"msg.skipped_files": "file(s) skipped (>25 MB)",
		"msg.conflicts_unresolved":
			"conflict(s) unresolved (modified on both sides)",
		"install.plugin_prefix": "Installing plugin :",
		"install.widget_prefix": "Installing widget :",
		"install.theme_prefix": "Installing theme :",
		"notebook.prefix": "Notebook :",
		"msg.pull_done":
			"Pull completed : {updated} files updated, {skipped} skipped, {deleted} deleted.",
		"msg.plugins_installed": "🧩 {n} plugin(s) installed.",
		"msg.widgets_installed": "📦 {n} widget(s) installed.",
		"msg.themes_installed": "🎨 {n} theme(s) installed.",
		"msg.notebooks_processed": "📖 {n} notebook(s) opened.",
		"msg.errors":
			"⚠️ {n} error(s): Open dev tools to see details (ctrl+shift+i).",
		"msg.errors_occurred":
			" ⚠️ {n} error(s). Open developer tools for details (ctrl+shift+i).",
		"msg.restored": "✅ Restored: {n} files (commit: {sha} - {message})",
		"action.push": "⏳ Push in progress...",
		"action.pull": "⏳ Pull in progress...",
	},
	// ------------------------------------------------------------------------
	// CHINESE
	// ------------------------------------------------------------------------
	zh: {
		"status.initializing": "初始化...",
		"status.ok": "✅ 正常",
		"status.error": "❌ 错误",
		"top.push_title": "⬆️ 智能上传 (增量)",
		"top.pull_title": "⬇️ 智能拉取 (增量)",
		"top.history_title": "🕒 历史记录",
		"setting.github_user": "GitHub 用户名",
		"setting.github_repo": "GitHub 仓库名",
		"setting.github_token": "GitHub Token (PAT)",
		"setting.groq_key": "Groq API Key (可选)",
		"setting.show_diff": "推送前显示差异",
		"setting.actions": "操作",
		"setting.language": "语言 (需要重启)",
		"button.test_github": "🧪 测试连接",
		"button.export": "📥 导出配置",
		"button.import": "📤 导入配置",
		"button.close": "关闭",
		"button.refresh": "🔄 刷新",
		"button.restore": "恢复",
		"button.forget_password": "🗑️ 忘记密码",
		"button.show": "显示",
		"button.hide": "隐藏",
		"msg.export_warning_prefix": "⚠️ 警告：导出的文件将包含",
		"msg.config_exported": "✅ 配置已导出",
		"msg.config_loaded": "✅ 配置已加载，请点击保存。",
		"msg.saved": "✅ 已保存",
		"msg.configure_plugin": "⚠️ 请先配置插件。",
		"setting.encryption_password": "加密密码",
		"setting.encryption_salt": "加密盐值",
		"hint.encryption_password":
			"输入密码以启用客户端加密。请勿丢失，否则数据将无法解密。",
		"msg.password_forgot":
			"加密密码已从内存中清除。在不重新输入密码的情况下，将无法解密之前上传的数据。",

		"dialog.remove_encryption_title": "🔓 移除加密",
		"dialog.remove_encryption_body":
			"远程仓库将以无加密方式重新上传：\n• 所有内容将以明文重新上传（笔记本名称也会恢复）\n• 所有旧加密文件都会从远程仓库删除，任何人都无法恢复它们。\n\n请先输入您当前的加密密码。如果密码错误，本次操作将被拒绝。",
		"placeholder.current_password": "当前密码",
		"button.confirm": "✔️ 确认并重新上传",
		"hint.remove_encryption":
			"⚠️ 不可逆操作：旧加密数据一旦被删除将无法恢复。",
		"error.password_required": "❌ 请输入当前加密密码以确认移除。",
		"msg.encryption_removed": "✅ 已移除加密：远程仓库已重新以明文上传。",
		"progress.removing_encryption": "正在移除加密...",
		"progress.verifying_password": "正在验证旧密码...",
		"progress.cleaning_enc": "正在删除旧加密文件...",
		"progress.uploading_plaintext": "正在以明文重新上传 ({n})...",

		"part.the": "",
		"part.and": " 和 ",
		"part.export_warning_suffix": " 的明文。\n请勿分享此文件。",
		"part.other": "其他",
		"progress.analysis": "分析中...",
		"progress.reading_remote": "读取远程仓库...",

		"diff.title": "📊 推送前确认",
		"diff.send": "🚀 发送",
		"diff.cancel": "❌ 取消",
		"diff.no_changes": "未检测到更改",
		"diff.files_to_upload": "待发送文件",
		"diff.files_to_delete": "待删除文件",
		"diff.files_unchanged": "未修改文件",
		"diff.conflicts": "冲突文件",
		"diff.skipped_large": "跳过文件 (>25 MB)",
		'diff.other': '其他文件',

		"ui.done": "✅ 完成",
		"ui.error": "❌ 错误",
		"history.no_commits": "未找到提交记录。",
		"history.loading": "加载中...",
		"history.restore_failed": "❌ 恢复失败：",
		"error.token_invalid": "❌ GitHub token 无效或已过期。",
		"error.repo_not_found": "❌ 未找到 GitHub 仓库。",
		"error.no_internet": "❌ 无网络连接。",
		"error.rate_limit": "❌ 达到 GitHub API 速率限制。请稍后重试。",
		"error.request_aborted": "❌ 请求被中止 (超时)。",
		"error.bad_password": "❌ 远程仓库的加密密码无效。",
		"error.file_too_large": "⚠️ 文件过大 (>25 MB)，已跳过。",
		"error.invalid_file": "❌ 无效文件。",
		"error.pull_verification_failed":
			"❌ 拉取验证失败。远程仓库可能已被外部修改。请检查控制台或仓库中的错误。",

		"merge.status": "合并中...",
		"merge.compare": "对比本地/远程/上次同步...",
		"msg.no_changes_conflicts": "没有需要发送的更改。⚠️ 已忽略 {n} 个冲突。",
		"msg.no_changes_none": "一切都是最新的！",
		"msg.file_deleted": "(文件已删除)",
		"progress.upload_plugin_manifest": "上传插件清单...",
		"progress.upload_widget_manifest": "上传挂件清单...",
		"progress.upload_theme_manifest": "上传主题清单...",
		"progress.finalizing": "完成中...",
		"progress.creating_tree": "创建文件树...",
		"stat.sent": "已发送",
		"stat.pulled": "已拉取",
		"stat.deleted": "已删除",
		"stat.unchanged": "未修改",
		"msg.push_done_prefix": "推送完成：",
		"msg.push_initial_done": "初始推送完成，共发送 {n} 个文件。",
		"msg.repo_empty": "仓库为空。请先进行推送。",
		"msg.skipped_files": "个文件已跳过 (>25 MB)",
		"msg.conflicts_unresolved": "个冲突未解决（双向修改）",
		"install.plugin_prefix": "安装插件：",
		"install.widget_prefix": "安装挂件：",
		"install.theme_prefix": "安装主题：",
		"notebook.prefix": "笔记本：",
		"msg.pull_done":
			"拉取完成：更新 {updated} 个，跳过 {skipped} 个，删除 {deleted} 个。",
		"msg.plugins_installed": "🧩 安装了 {n} 个插件。",
		"msg.widgets_installed": "📦 安装了 {n} 个挂件。",
		"msg.themes_installed": "🎨 安装了 {n} 个主题。",
		"msg.notebooks_processed": "📖 打开了 {n} 个笔记本。",
		"msg.errors": "⚠️ 发生 {n} 个错误：打开开发者工具查看详情 (Ctrl+Shift+I)。",
		"msg.errors_occurred": " ⚠️ 发生 {n} 个错误：打开开发者工具查看详情 (Ctrl+Shift+I)。",
		"msg.restored": "✅ 已恢复：{n} 个文件 (commit: {sha} - {message})",
		"action.push": "⏳ 正在推送...",
		"action.pull": "⏳ 正在拉取...",
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
	const map = locales[current] || {};
	return map[key] ?? key;
}

/** Return the currently active locale code. */
export function getLocale(): string {
	return current;
}

/** Switch the active locale (ignored silently if the locale is unknown). */
export function setLocale(l: string) {
	if (locales[l]) current = l;
}

/** List of every supported locale code. */
export function availableLocales(): string[] {
	return Object.keys(locales);
}
