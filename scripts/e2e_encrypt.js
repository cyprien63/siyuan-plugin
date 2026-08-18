/**
 * E2E helper: encrypt a payload for a remote upload test.
 *
 * Reproduces the plugin's encryption format (scrypt KDF + AES-GCM, `GSE1`
 * header) in Node so the browser-side crypto can be validated against an
 * independent implementation.
 *
 * Environment:
 *   E2E_PASSWORD   password used for key derivation (default "e2e-test-password")
 *   E2E_PATH       original SiYuan path to obfuscate (default "data/e2e/test.txt")
 *   E2E_PLAINTEXT  plaintext payload to encrypt (default "SiYuan E2E test payload")
 *
 * Output (JSON): `blob_b64`, `salt_b64`, `remotePath` (obfuscated) and
 * `originalPath`. Consumed by `e2e_upload_and_verify.js`.
 */
const { webcrypto } = require('crypto');
const scrypt = require('scrypt-js').scrypt;

function base64FromBytes(bytes) { return Buffer.from(bytes).toString('base64'); }

/** Derive a 32-byte AES key from a password + salt using scrypt (N=16384,r=8,p=1). */
async function deriveKeyScrypt(password, saltBytes) {
  const pw = Buffer.from(password, 'utf8');
  const N = 16384, r = 8, p = 1, dkLen = 32;
  // scrypt-js returns a Promise when called without a progress callback
  const key = await scrypt(pw, saltBytes, N, r, p, dkLen);
  return Buffer.from(key);
}

/**
 * Encrypt content with the plugin's format:
 * `GSE1` | version(1) | IV(12) | AES-GCM ciphertext.
 */
async function encrypt(contentBuf, password) {
  const saltArr = webcrypto.getRandomValues(new Uint8Array(16));
  const saltBuf = Buffer.from(saltArr);
  const derived = await deriveKeyScrypt(password, saltBuf);
  const keyBuf = derived.buffer.slice(derived.byteOffset, derived.byteOffset + derived.byteLength);
  const key = await webcrypto.subtle.importKey('raw', keyBuf, { name: 'AES-GCM' }, false, ['encrypt']);
  const ivArr = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: ivArr }, key, contentBuf);
  const MAGIC = Buffer.from('GSE1');
  const VERSION = Buffer.from([1]);
  const out = Buffer.concat([MAGIC, VERSION, Buffer.from(ivArr), Buffer.from(new Uint8Array(ct))]);
  return { out, salt: saltBuf };
}

(async () => {
  try {
    const PASSWORD = process.env.E2E_PASSWORD || 'e2e-test-password';
    const originalPath = process.env.E2E_PATH || 'data/e2e/test.txt';
    const plaintext = process.env.E2E_PLAINTEXT || 'SiYuan E2E test payload';
    const contentBuf = Buffer.from(plaintext, 'utf8');
    const { out, salt } = await encrypt(contentBuf, PASSWORD);
    const b64 = base64FromBytes(out);
    const saltB64 = base64FromBytes(salt);
    // Obfuscate the path exactly like the plugin does (base64(encodeURIComponent(path))).
    const encoded = Buffer.from(encodeURIComponent(originalPath)).toString('base64');
    const remotePath = `data/enc/${encoded}`;
    const result = { blob_b64: b64, salt_b64: saltB64, remotePath, originalPath };
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error('ERR', e);
    process.exit(2);
  }
})();
