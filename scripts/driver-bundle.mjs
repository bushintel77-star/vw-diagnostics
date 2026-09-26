// The one OpenPort 2.0 driver package this app will ever carry or launch.
// Clone cables brick on newer Tactrix software and firmware updaters, so the
// installer is pinned by exact SHA-256.
//
// It ships in the PUBLIC app (and so on the website download) only as
// AES-256-GCM ciphertext, keyed by scrypt from a passkey chosen at build
// time. Without the passkey the download holds no usable driver. The same
// helpers serve scripts/encrypt-driver.mjs and the main process.

import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, scryptSync } from 'node:crypto';

export const DRIVER_FILE = 'openport2_setup_1004341.exe';
export const DRIVER_SHA256 = '0516379fae4a1d68b0523ec5757539ff0d67312457868b4fb4fb6867c8aec1c0';
export const ENCRYPTED_FILE = 'openport-driver.enc';
export const META_FILE = 'openport-driver.json';

// The ciphertext is public, so the passkey is the only thing standing
// between anyone and the file: long passkeys, and a deliberately slow KDF.
export const MIN_PASSKEY_LENGTH = 10;
export const SCRYPT = { N: 131072, r: 8, p: 1 };
export const scryptMaxmem = (N, r) => 256 * N * r;

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// Binds the ciphertext to the pinned installer: a blob for anything else
// fails authentication instead of decrypting.
const aad = (hash) => Buffer.from(`vwd-openport-driver:v1:${hash}`);

const deriveKey = (passkey, salt, { N, r, p }) =>
  scryptSync(passkey, salt, 32, { N, r, p, maxmem: scryptMaxmem(N, r) });

/** Encrypts the pinned installer. `kdf` is overridable for fast tests. */
export function encryptDriver(plain, passkey, kdf = SCRYPT) {
  const hash = sha256(plain);
  if (hash !== DRIVER_SHA256) throw new Error(`not the pinned ${DRIVER_FILE}`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passkey, salt, kdf), iv);
  cipher.setAAD(aad(hash));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const meta = {
    version: 1,
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    sha256: hash,
    size: plain.length,
  };
  return { meta, ciphertext };
}

export function isValidMeta(meta) {
  return (
    meta?.version === 1 &&
    meta.cipher === 'aes-256-gcm' &&
    meta.kdf === 'scrypt' &&
    [meta.N, meta.r, meta.p, meta.size].every(Number.isInteger) &&
    [meta.salt, meta.iv, meta.tag].every((v) => typeof v === 'string' && /^[0-9a-f]+$/.test(v)) &&
    meta.sha256 === DRIVER_SHA256
  );
}

// Async so the ~0.5 s key derivation never freezes the app's main process.
const deriveKeyAsync = (passkey, salt, { N, r, p }) =>
  new Promise((resolve, reject) =>
    scrypt(passkey, salt, 32, { N, r, p, maxmem: scryptMaxmem(N, r) }, (error, key) =>
      error ? reject(error) : resolve(key)
    )
  );

/** The installer bytes, or null for a wrong passkey or a tampered blob. */
export async function decryptDriver(ciphertext, meta, passkey) {
  if (!isValidMeta(meta) || typeof passkey !== 'string' || passkey.length === 0) return null;
  try {
    const key = await deriveKeyAsync(passkey, Buffer.from(meta.salt, 'hex'), meta);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(meta.iv, 'hex'));
    decipher.setAAD(aad(meta.sha256));
    decipher.setAuthTag(Buffer.from(meta.tag, 'hex'));
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return sha256(plain) === DRIVER_SHA256 ? plain : null;
  } catch {
    return null;
  }
}
