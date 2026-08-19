/**
 * Client-side encryption for files uploaded to GitHub.
 *
 * When an encryption password is configured, every pushed blob is encrypted
 * with AES-GCM before leaving the machine, so the remote repository only ever
 * stores ciphertext (and obfuscated paths).
 *
 * Implementation notes:
 * - Three key-derivation algorithms are tried in order of strength, and every
 *   successfully derived key is kept. This provides a graceful fallback when
 *   a device lacks a WASM crypto library:
 *     1. Argon2id (via `argon2-wasm`)
 *     2. scrypt (via `scrypt-js`)
 *     3. PBKDF2 (native WebCrypto — guaranteed fallback)
 * - Encrypted blob format:
 *     ["GSE1" (4 bytes)] [version (1 byte)] [IV (12 bytes)] [ciphertext...]
 * - The IV is randomly generated for every encryption to guarantee nonce
 *   uniqueness, which AES-GCM strictly requires (IND-CPA).
 */
import * as argon2 from "argon2-wasm";
import * as scryptModule from "scrypt-js";

/** Decode a base64 string into a Uint8Array. */
function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const u = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
	return u;
}

/** Encode a Uint8Array into a base64 string (chunked to avoid stack overflow). */
function bytesToBase64(bytes: Uint8Array): string {
	let s = "";
	const chunk = 8192;
	for (let i = 0; i < bytes.length; i += chunk) {
		s += String.fromCharCode(
			...(bytes.subarray(i, i + chunk) as unknown as number[]),
		);
	}
	return btoa(s);
}

/**
 * Log the first 4 bytes of a derived key (hex) for debugging.
 *
 * Only a tiny fingerprint is exposed, never the full key material.
 */
async function logKeyFingerprint(key: CryptoKey, name: string) {
	try {
		const raw = await crypto.subtle.exportKey("raw", key);
		const hex = Array.from(new Uint8Array(raw))
			.slice(0, 4)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		console.debug(`[GitHub Sync] Key Fingerprint [${name}]: ${hex}`);
	} catch (e) {
		console.debug(`[GitHub Sync] Could not export fingerprint for ${name}`);
	}
}

/**
 * Derive AES-GCM keys from a password using every available KDF.
 *
 * Returns an array ordered from strongest to weakest algorithm. Callers try
 * each key until one decrypts successfully, which makes the whole setup
 * portable across devices with different crypto-library availability.
 */
export async function deriveKeys(
	password: string,
	saltBase64: string,
): Promise<CryptoKey[]> {
	const enc = new TextEncoder();
	const saltBytes = base64ToBytes(saltBase64);
	const keys: CryptoKey[] = [];

	console.debug(
		`[GitHub Sync] Deriving keys. Password length: ${password.length}. Salt Bytes: ${Array.from(saltBytes).slice(0, 4).join(",")}...`,
	);

	// 1. Try Argon2id (WASM) — memory-hard, strongest of the three.
	try {
		const ares: any = await argon2.hash({
			pass: password,
			salt: Array.from(saltBytes),
			time: 3,
			mem: 65536, // 64 MiB
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
		await logKeyFingerprint(key, "Argon2id");
		keys.push(key);
	} catch (e) {
		console.warn("[GitHub Sync] argon2-wasm not available or failed:", e);
	}

	// 2. Try scrypt-js — moderate memory-hardness, still very resistant.
	try {
		const scrypt = (scryptModule as any).scrypt || (scryptModule as any);
		const pwBytes = enc.encode(password);
		const derived = await scrypt(pwBytes, saltBytes, 16384, 8, 1, 32);
		const key = await crypto.subtle.importKey(
			"raw",
			new Uint8Array(derived),
			{ name: "AES-GCM" },
			true,
			["encrypt", "decrypt"],
		);
		await logKeyFingerprint(key, "scrypt");
		keys.push(key);
	} catch (e) {
		console.warn("[GitHub Sync] scrypt not available or failed:", e);
	}

	// 3. Try PBKDF2 (Native WebCrypto - guaranteed fallback on any modern browser).
	try {
		const keyMaterial = await crypto.subtle.importKey(
			"raw",
			enc.encode(password),
			{ name: "PBKDF2" },
			false,
			["deriveBits", "deriveKey"],
		);
		const key = await crypto.subtle.deriveKey(
			{ name: "PBKDF2", salt: saltBytes as BufferSource, iterations: 200_000, hash: "SHA-256" },
			keyMaterial,
			{ name: "AES-GCM", length: 256 },
			true,
			["encrypt", "decrypt"],
		);
		await logKeyFingerprint(key, "PBKDF2");
		keys.push(key);
	} catch (e) {
		console.warn("[GitHub Sync] PBKDF2 failed:", e);
	}

	return keys;
}

/** Magic bytes (`"GSE1"`) that mark a buffer as an encrypted blob. */
const MAGIC = new TextEncoder().encode("GSE1");
/** Current serialization version of the encrypted blob format. */
const VERSION = 1;

/**
 * Check whether a buffer starts with the encrypted-blob magic header.
 */
export function isEncryptedBuffer(content: ArrayBuffer | Uint8Array): boolean {
	const data =
		content instanceof Uint8Array ? content : new Uint8Array(content);
	if (data.length < MAGIC.length + 1) return false;
	for (let i = 0; i < MAGIC.length; i++) {
		if (data[i] !== MAGIC[i]) return false;
	}
	return true;
}

/**
 * Generate a deterministic salt from the username/repo pair.
 *
 * Deriving the salt from the repo identity (instead of a random salt stored
 * alongside the data) means any device can decrypt with ONLY the password —
 * there is no extra salt to transfer. This is weaker than a random salt, but
 * it is a deliberate trade-off so remote devices can connect without state.
 */
export async function getDeterministicSalt(username: string, repo: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(`siyuan-github-sync:${username}/${repo}`);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    // Take the first 16 bytes for a standard salt length and convert to base64
    const saltBytes = new Uint8Array(hashBuffer).slice(0, 16);
    return bytesToBase64(saltBytes);
}

/**
 * Encrypt a plaintext buffer into the versioned `GSE1` blob format.
 *
 * Layout: `GSE1` | version | random 12-byte IV | AES-GCM ciphertext.
 */
export async function encryptFile(
	content: ArrayBuffer,
	key: CryptoKey,
): Promise<ArrayBuffer> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		content,
	);
	const cBytes = new Uint8Array(ciphertext);
	const out = new Uint8Array(MAGIC.length + 1 + iv.length + cBytes.length);
	out.set(MAGIC, 0);
	out[MAGIC.length] = VERSION;
	out.set(iv, MAGIC.length + 1);
	out.set(cBytes, MAGIC.length + 1 + iv.length);
	return out.buffer;
}

/**
 * Decrypt a `GSE1` blob, trying every provided key in order.
 *
 * Because `deriveKeys()` can return several keys (one per available KDF), each
 * key is attempted until one produces valid plaintext. AES-GCM's
 * authentication tag ensures a wrong key always fails to decrypt.
 */
export async function decryptFile(
	encryptedContent: ArrayBuffer,
	keys: CryptoKey[],
): Promise<ArrayBuffer> {
	const data = new Uint8Array(encryptedContent);
	// Hex snippet of the first bytes, kept for error reporting.
	const snippet = Array.from(data.slice(0, Math.min(24, data.length)))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join(" ");

	if (data.length < MAGIC.length + 1 + 12) {
		throw new Error(
			`Invalid encrypted data (too short). First bytes: ${snippet}`,
		);
	}

	// Validate the magic header so non-encrypted content is never misread.
	for (let i = 0; i < MAGIC.length; i++) {
		if (data[i] !== MAGIC[i])
			throw new Error(`Invalid magic header. First bytes: ${snippet}`);
	}

	const version = data[MAGIC.length];
	if (version !== VERSION) {
		throw new Error(
			`Unsupported crypto version: ${version}. Expected ${VERSION}. First bytes: ${snippet}`,
		);
	}

	const ivStart = MAGIC.length + 1;
	const iv = data.slice(ivStart, ivStart + 12);
	const ciphertext = data.slice(ivStart + 12);

	console.debug(
		`[GitHub Sync] Decrypting payload. Total size: ${data.length} bytes, IV size: ${iv.length} bytes, Ciphertext size: ${ciphertext.length} bytes`,
	);

	let lastError = "";

	// Try decrypting with all available derived keys until one succeeds
	for (let k = 0; k < keys.length; k++) {
		try {
			return await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv },
				keys[k],
				ciphertext,
			);
		} catch (e: any) {
			const errName = e?.name || "UnknownError";
			const errMsg = e?.message || "";
			lastError = `${errName}${errMsg ? ": " + errMsg : " (Authentication tag mismatch)"}`;
			console.debug(
				`[GitHub Sync] Decryption fallback attempt #${k + 1} failed: ${lastError}`,
			);
		}
	}

	throw new Error(
		`Decryption failed across all generated keys. Last error: ${lastError}. Header snippet: ${snippet}`,
	);
}
