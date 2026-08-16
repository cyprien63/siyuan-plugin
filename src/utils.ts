import { getLocale, t } from "./i18n";

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let bin = "";
	const CHUNK = 8192;
	for (let i = 0; i < bytes.byteLength; i += CHUNK) {
		bin += String.fromCharCode(
			...(bytes.subarray(i, i + CHUNK) as unknown as number[]),
		);
	}
	return btoa(bin);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
	// Fortified regex to strip all whitespace, newlines, and carriage returns
	const bin = atob(b64.replace(/[\r\n\s]+/g, ""));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes.buffer;
}

export async function calculateGitSha(content: ArrayBuffer): Promise<string> {
	const header = new TextEncoder().encode(`blob ${content.byteLength}\0`);
	const combined = new Uint8Array(header.length + content.byteLength);
	combined.set(header);
	combined.set(new Uint8Array(content), header.length);
	const hashBuffer = await crypto.subtle.digest("SHA-1", combined);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

export function sanitizeForDisplay(s: string): string {
	return s.replace(
		/[<>&"']/g,
		(c) =>
			({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[
				c as keyof typeof c
			] || c,
	);
}

export function friendlyError(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	const msg = raw.toLowerCase();
	const locale = getLocale();
	if (
		msg.includes("bad credentials") ||
		msg.includes("401") ||
		msg.includes("token")
	)
		return locale === "en"
			? t("error.token_invalid")
			: t("error.token_invalid");
	if (msg.includes("not found") || msg.includes("404"))
		return t("error.repo_not_found");
	if (
		msg.includes("networkerror") ||
		msg.includes("failed to fetch") ||
		msg.includes("network")
	)
		return t("error.no_internet");
	if (msg.includes("rate limit") || msg.includes("403"))
		return t("error.rate_limit");
	if (msg.includes("aborted") || msg.includes("timeout"))
		return t("error.request_aborted");
	//if (msg.includes("size") || msg.includes("large"))
	//	return t("error.file_too_large");
	return `  ${sanitizeForDisplay(raw)}`;
}

export function extractTextFromSyFile(content: ArrayBuffer): string {
	try {
		const text = new TextDecoder().decode(content);
		const json = JSON.parse(text);
		const texts: string[] = [];
		const walk = (obj: unknown, depth = 0) => {
			if (!obj || typeof obj !== "object" || depth > 8) return;
			if (Array.isArray(obj)) {
				obj.forEach((v) => walk(v, depth + 1));
				return;
			}
			const o = obj as Record<string, unknown>;
			if (o.content && typeof o.content === "string" && o.content.length > 5)
				texts.push(o.content);
			if (o.markdown && typeof o.markdown === "string" && o.markdown.length > 5)
				texts.push(o.markdown);
			if (o.text && typeof o.text === "string" && o.text.length > 5)
				texts.push(o.text);
			if (o.name && typeof o.name === "string" && o.name.length > 5)
				texts.push(o.name);
			if (o.title && typeof o.title === "string" && o.title.length > 5)
				texts.push(o.title);
			for (const val of Object.values(o)) {
				if (typeof val === "object") walk(val, depth + 1);
			}
		};
		walk(json);
		return texts.join("\n").replace(/\s+/g, " ").trim().slice(0, 800);
	} catch {
		const text = new TextDecoder().decode(content);
		return text
			.replace(/[^\w\s\u00C0-\u00FF-]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 600);
	}
}

export async function generateCommitMessage(
	groqKey: string,
	summaries: { path: string; content: string }[],
): Promise<string> {
	if (!groqKey) return "";
	try {
		let fileDesc = summaries
			.map((s) => {
				const title = s.content
					.split("\n")[0]
					.replace(/#{1,6}\s*/, "")
					.trim();
				const extra = s.content.length > 80 ? s.content.slice(0, 200) : "";
				return `- ${s.path}: ${title}   ${extra}`;
			})
			.join("\n");
		if (fileDesc.length > 6000) fileDesc = fileDesc.slice(0, 6000) + "\n...";

		const locale = getLocale();
		const prompt =
			locale === "en"
				? `You are a Git expert. Generate a very precise commit message in English (max 72 characters) describing the actual changes below. Be specific about the modified content, not generic.\n\nChanged files:\n${fileDesc}`
				: `Tu es un expert Git. Génère un message de commit très précis en français (max 72 caractères) décrivant les changements réels ci-dessous. Sois spécifique sur le contenu modifié, pas générique.\n\nFichiers modifiés :\n${fileDesc}`;

		const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${groqKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "llama-3.3-70b-versatile",
				messages: [{ role: "user", content: prompt }],
				max_tokens: 120,
			}),
		});
		if (!res.ok) return "";
		const data = await res.json();
		const msg = data.choices?.[0]?.message?.content?.trim();
		return msg ? msg.replace(/["']/g, "").split("\n")[0].slice(0, 72) : "";
	} catch {
		return "";
	}
}
