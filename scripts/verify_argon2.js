/**
 * Standalone verification of the Argon2id WASM implementation.
 *
 * Confirms that:
 *   1. deriving the same password+salt twice yields identical keys, and
 *   2. a payload encrypted with the first derivation decrypts with the second.
 *
 * This guards the `argon2-wasm` dependency (params: time=3, mem=65536 KiB,
 * hashLen=32, parallelism=1, Argon2id) used by `src/crypto.ts`.
 *
 * Environment:
 *   VERIFY_PW   password to test with (default "e2e-argon2-password")
 */
const { webcrypto } = require('crypto');
(async () => {
  try {
    const argon2 = require('argon2-wasm');
    const password = process.env.VERIFY_PW || 'e2e-argon2-password';
    const salt = webcrypto.getRandomValues(new Uint8Array(16));

    console.log('Using Argon2 params: time=3, mem=65536 KiB, hashLen=32');

    const a1 = await argon2.hash({
      pass: password,
      salt: Array.from(salt),
      time: 3,
      mem: 65536,
      hashLen: 32,
      parallelism: 1,
      // prefer named enum if provided
      type: argon2.types ? argon2.types.Argon2id : 2,
    });
    const derived1 = new Uint8Array(a1.hash);

    // Import key and encrypt
    const keyBuf1 = derived1.buffer.slice(derived1.byteOffset, derived1.byteOffset + derived1.byteLength);
    const key1 = await webcrypto.subtle.importKey('raw', keyBuf1, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode('Argon2 E2E verification payload');
    const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key1, plaintext);

    // Derive again with same params
    const a2 = await argon2.hash({
      pass: password,
      salt: Array.from(salt),
      time: 3,
      mem: 65536,
      hashLen: 32,
      parallelism: 1,
      type: argon2.types ? argon2.types.Argon2id : 2,
    });
    const derived2 = new Uint8Array(a2.hash);

    // Compare derived keys
    const equal = derived1.length === derived2.length && derived1.every((v, i) => v === derived2[i]);
    console.log('Argon2 derived keys equal across runs:', equal);
    if (!equal) process.exit(2);

    // Import second key and decrypt
    const keyBuf2 = derived2.buffer.slice(derived2.byteOffset, derived2.byteOffset + derived2.byteLength);
    const key2 = await webcrypto.subtle.importKey('raw', keyBuf2, { name: 'AES-GCM' }, false, ['decrypt']);
    const plain = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key2, ct);
    const decoded = new TextDecoder().decode(plain);
    console.log('Decrypted plaintext matches:', decoded === 'Argon2 E2E verification payload');
    if (decoded !== 'Argon2 E2E verification payload') process.exit(2);

    console.log('Argon2 E2E verification succeeded.');
  } catch (e) {
    console.error('Error during verification:', e);
    process.exit(2);
  }
})();
