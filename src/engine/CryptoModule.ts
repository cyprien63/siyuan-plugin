import * as argon2 from "argon2-wasm";
import { scrypt } from "scrypt-js";
import {
	Argon2Response,
	GitPluginConfig,
	SYNC_ROOT,
	PLUGIN_MANIFEST_PATH,
	WIDGET_MANIFEST_PATH,
	THEME_MANIFEST_PATH,
	NOTEBOOK_MANIFEST_FILE,
} from "../shared-utils/types";

/**
 * Client-side encryption module.
 * Handles path obfuscation, multi-algorithm key derivation (Argon2id, scrypt, PBKDF2),
 * and AES-GCM encryption/decryption for secure remote blob storage.
 */
export class CryptoModule {
	private keysCache: {
		password?: string;
		promise: Promise<CryptoKey[] | null>;
	} | null = null;
	private readonly MAGIC = new TextEncoder().encode("GSE1");
	private readonly VERSION = 1;

	constructor(private config: GitPluginConfig) {}

	public obfuscateRemotePath(originalPath: string): string {
		if (!this.config.encryptionPassword) return originalPath;
		if (
			originalPath === PLUGIN_MANIFEST_PATH ||
			originalPath === WIDGET_MANIFEST_PATH ||
			originalPath === THEME_MANIFEST_PATH ||
			originalPath.endsWith("/" + NOTEBOOK_MANIFEST_FILE) ||
			originalPath.startsWith(SYNC_ROOT + "/manifests")
		) {
			return originalPath;
		}
		const encoded = btoa(encodeURIComponent(originalPath));
		return `${SYNC_ROOT}/enc/${encoded}`;
	}

	public deobfuscateRemotePath(remotePath: string): string {
		const prefix = `${SYNC_ROOT}/enc/`;
		if (remotePath.startsWith(prefix)) {
			const b64 = remotePath.slice(prefix.length);
			try {
				return decodeURIComponent(atob(b64));
			} catch {
				return remotePath;
			}
		}
		return remotePath;
	}

	public isEncryptedBuffer(content: ArrayBuffer | Uint8Array): boolean {
		const data =
			content instanceof Uint8Array ? content : new Uint8Array(content);
		if (data.length < this.MAGIC.length + 1) return false;
		for (let i = 0; i < this.MAGIC.length; i++) {
			if (data[i] !== this.MAGIC[i]) return false;
		}
		return true;
	}

	public async encrypt(content: ArrayBuffer): Promise<ArrayBuffer> {
		const keys = await this.deriveRepoKeys();
		if (!keys || keys.length === 0) return content;

		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ciphertext = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			keys[0],
			content,
		);
		const cBytes = new Uint8Array(ciphertext);

		const out = new Uint8Array(
			this.MAGIC.length + 1 + iv.length + cBytes.length,
		);
		out.set(this.MAGIC, 0);
		out[this.MAGIC.length] = this.VERSION;
		out.set(iv, this.MAGIC.length + 1);
		out.set(cBytes, this.MAGIC.length + 1 + iv.length);

		return out.buffer;
	}

	public async decrypt(encryptedContent: ArrayBuffer): Promise<ArrayBuffer> {
		const keys = await this.deriveRepoKeys();
		if (!keys || keys.length === 0) return encryptedContent;
		if (!this.isEncryptedBuffer(encryptedContent)) return encryptedContent;

		const data = new Uint8Array(encryptedContent);
		const snippet = Array.from(data.slice(0, Math.min(24, data.length)))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join(" ");

		const version = data[this.MAGIC.length];
		if (version !== this.VERSION) {
			throw new Error(
				`Unsupported crypto version: ${version}. Expected ${this.VERSION}. First bytes: ${snippet}`,
			);
		}

		const ivStart = this.MAGIC.length + 1;
		const iv = data.slice(ivStart, ivStart + 12);
		const ciphertext = data.slice(ivStart + 12);

		let lastError = "";
		for (let k = 0; k < keys.length; k++) {
			try {
				return await crypto.subtle.decrypt(
					{ name: "AES-GCM", iv },
					keys[k],
					ciphertext,
				);
			} catch (e: unknown) {
				const errName = (e as Error)?.name || "UnknownError";
				const errMsg = (e as Error)?.message || "";
				lastError = `${errName}${errMsg ? ": " + errMsg : " (Authentication tag mismatch)"}`;
			}
		}
		throw new Error(
			`Decryption failed across all generated keys. Last error: ${lastError}. Header snippet: ${snippet}`,
		);
	}

	private async deriveRepoKeys(): Promise<CryptoKey[] | null> {
		if (!this.config.encryptionPassword) return null;

		if (this.keysCache?.password === this.config.encryptionPassword) {
			return this.keysCache.promise;
		}

		const promise = (async () => {
			try {
				const username = this.config.username.trim();
				const repo = this.config.repo.trim();
				if (!username || !repo) return null;

				const saltBase64 = await this.getDeterministicSalt(username, repo);
				const enc = new TextEncoder();
				const saltBytes = this.base64ToBytes(saltBase64);
				const keys: CryptoKey[] = [];

				// 1. Argon2id (WASM)
				try {
					const ares: Argon2Response = await argon2.hash({
						pass: this.config.encryptionPassword!,
						salt: Array.from(saltBytes),
						time: 3,
						mem: 65536,
						hashLen: 32,
						parallelism: 1,
						type: argon2.types ? argon2.types.Argon2id : 2,
					});
					const derived = new Uint8Array(ares.hash);
					const key = await crypto.subtle.importKey(
						"raw",
						derived,
						{ name: "AES-GCM" },
						true,
						["encrypt", "decrypt"],
					);
					keys.push(key);
				} catch (e) {
					console.warn("[GitHub Sync] argon2-wasm not available or failed:", e);
				}

				// 2. scrypt-js
				try {
					const pwBytes = enc.encode(this.config.encryptionPassword!);
					const derived = await scrypt(pwBytes, saltBytes, 16384, 8, 1, 32);
					const key = await crypto.subtle.importKey(
						"raw",
						new Uint8Array(derived),
						{ name: "AES-GCM" },
						true,
						["encrypt", "decrypt"],
					);
					keys.push(key);
				} catch (e) {
					console.warn("[GitHub Sync] scrypt not available or failed:", e);
				}

				// 3. PBKDF2 (Native WebCrypto)
				try {
					const keyMaterial = await crypto.subtle.importKey(
						"raw",
						enc.encode(this.config.encryptionPassword!),
						{ name: "PBKDF2" },
						false,
						["deriveBits", "deriveKey"],
					);
					const key = await crypto.subtle.deriveKey(
						{
							name: "PBKDF2",
							salt: saltBytes as BufferSource,
							iterations: 200_000,
							hash: "SHA-256",
						},
						keyMaterial,
						{ name: "AES-GCM", length: 256 },
						true,
						["encrypt", "decrypt"],
					);
					keys.push(key);
				} catch (e) {
					console.warn("[GitHub Sync] PBKDF2 failed:", e);
				}

				return keys;
			} catch (e) {
				console.error("[GitHub Sync] Key derivation failed:", e);
				return null;
			}
		})();

		this.keysCache = { password: this.config.encryptionPassword, promise };
		return promise;
	}

	private async getDeterministicSalt(
		username: string,
		repo: string,
	): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(`siyuan-github-sync:${username}/${repo}`);
		const hashBuffer = await crypto.subtle.digest("SHA-256", data);
		const saltBytes = new Uint8Array(hashBuffer).slice(0, 16);
		return this.bytesToBase64(saltBytes);
	}

	private base64ToBytes(b64: string): Uint8Array {
		const bin = atob(b64);
		const u = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
		return u;
	}

	private bytesToBase64(bytes: Uint8Array): string {
		let s = "";
		const chunk = 8192;
		for (let i = 0; i < bytes.length; i += chunk) {
			s += String.fromCharCode(
				...(bytes.subarray(i, i + chunk) as unknown as number[]),
			);
		}
		return btoa(s);
	}
}
