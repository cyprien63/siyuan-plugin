/**
 * E2E helper: fetch an encrypted blob from GitHub and decrypt it.
 *
 * Used to verify that a blob uploaded by the plugin (or by
 * `e2e_upload_and_verify.js`) can be decrypted back with the same password.
 *
 * Arguments:
 *   1. path to the JSON payload produced by `e2e_encrypt.js`
 *   2. the blob SHA to download from GitHub
 *
 * Environment:
 *   OWNER / REPO   repository coordinates (defaults to LuigiBrosNin/siyuan-workplace)
 *   TOKEN          GitHub token (required)
 *   E2E_PASSWORD   decryption password (default "e2e-test-password")
 */
const { webcrypto } = require('crypto');
const scrypt = require('scrypt-js').scrypt;
const fs = require('fs');

function base64ToBytes(b64){ return Buffer.from(b64, 'base64'); }

/** Derive the 32-byte AES key using the same scrypt parameters as the plugin. */
async function deriveKeyScrypt(password, saltBytes){
  const pw = Buffer.from(password, 'utf8');
  const N = 16384, r = 8, p = 1, dkLen = 32;
  const key = await scrypt(pw, saltBytes, N, r, p, dkLen);
  return Buffer.from(key);
}

/**
 * Parse a `GSE1` blob and decrypt it.
 *
 * Layout: `GSE1` | version(1) | IV(12) | ciphertext.
 */
async function decrypt(encryptedBuf, password, saltBuf){
  const MAGIC = Buffer.from('GSE1');
  if (encryptedBuf.length < MAGIC.length + 1 + 12) throw new Error('invalid');
  if (!encryptedBuf.slice(0,4).equals(MAGIC)) throw new Error('bad magic');
  const version = encryptedBuf[4];
  const iv = encryptedBuf.slice(5, 5+12);
  const ciphertext = encryptedBuf.slice(5+12);
  const derived = await deriveKeyScrypt(password, saltBuf);
  const keyBuf = derived.buffer.slice(derived.byteOffset, derived.byteOffset + derived.byteLength);
  const key = await webcrypto.subtle.importKey('raw', keyBuf, { name: 'AES-GCM' }, false, ['decrypt']);
  try{
    const plain = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, ciphertext);
    return Buffer.from(plain);
  } catch(e){ throw e; }
}

(async ()=>{
  try{
    const payloadFile = process.argv[2] || '/tmp/e2e_payload2.json';
    const payload = JSON.parse(fs.readFileSync(payloadFile,'utf8'));
    const blobSha = process.argv[3];
    const OWNER=process.env.OWNER || 'LuigiBrosNin';
    const REPO=process.env.REPO || 'siyuan-workplace';
    const TOKEN=process.env.TOKEN || '';
    if(!TOKEN){
      console.error('TOKEN env required'); process.exit(2);
    }
    // fetch blob from GitHub
    const https = require('https');
    const opts = {
      headers: { 'User-Agent': 'e2e-test', Authorization: 'token '+TOKEN }
    };
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/git/blobs/${blobSha}`;
    const fetch = (u)=> new Promise((res,rej)=>{
      https.get(u, opts, r=>{
        let s=''; r.on('data',c=>s+=c); r.on('end',()=>res(s)); r.on('error',rej);
      }).on('error',rej);
    });

    const blobJson = JSON.parse(await fetch(url));
    const contentB64 = blobJson.content.replace(/\n/g,'');
    const encrypted = base64ToBytes(contentB64);
    const saltBuf = Buffer.from(payload.salt_b64,'base64');
    const password = process.env.E2E_PASSWORD || 'e2e-test-password';
    const decrypted = await decrypt(encrypted, password, saltBuf);
    console.log('Decrypted plaintext:', decrypted.toString('utf8'));
  }catch(e){
    console.error('Error:', e);
    process.exit(2);
  }
})();
