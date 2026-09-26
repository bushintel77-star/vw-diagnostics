// Prepares the passkey-gated driver bundle for a PRIVATE build.
//
//   node scripts/set-driver-passkey.mjs [path-to-openport2_setup_1004341.exe]
//   node scripts/set-driver-passkey.mjs --check
//
// Copies the pinned OpenPort installer into resources/driver/ (gitignored)
// after verifying its SHA-256, then asks for a passkey (hidden input) and
// stores only its scrypt hash in resources/driver/passkey.json. The passkey
// itself is never written anywhere. `--check` verifies an existing bundle
// and is run by `npm run release:win:private` before packaging.
//
// Never publish a private build: it carries Tactrix's installer.

import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DRIVER_FILE, DRIVER_SHA256, PASSKEY_FILE, SCRYPT, scryptMaxmem } from './driver-bundle.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundleDir = path.join(root, 'resources', 'driver');
const MIN_LENGTH = 6;

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const fail = (message) => {
  console.error(`set-driver-passkey: ${message}`);
  process.exit(1);
};

function check() {
  const installer = path.join(bundleDir, DRIVER_FILE);
  const record = path.join(bundleDir, PASSKEY_FILE);
  if (!existsSync(installer)) fail(`missing ${installer} — run: node scripts/set-driver-passkey.mjs`);
  if (sha256(installer) !== DRIVER_SHA256) fail(`${DRIVER_FILE} does not match the pinned SHA-256 — refusing to package it.`);
  try {
    const { salt, hash, N, r, p } = JSON.parse(readFileSync(record, 'utf8'));
    if (typeof salt !== 'string' || typeof hash !== 'string' || ![N, r, p].every(Number.isInteger)) throw new Error('bad record');
  } catch {
    fail(`missing or invalid ${record} — run: node scripts/set-driver-passkey.mjs`);
  }
  console.log('set-driver-passkey: driver bundle OK (pinned installer + passkey hash).');
}

/** Reads a line without echoing it. Needs an interactive terminal. */
function askHidden(prompt) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) fail('run this in an interactive terminal (the passkey is typed, never passed as an argument).');
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--check')) return check();

  const source = path.resolve(args[0] || path.join(homedir(), 'Downloads', DRIVER_FILE));
  if (!existsSync(source)) fail(`installer not found: ${source}`);
  if (sha256(source) !== DRIVER_SHA256) {
    fail(`${source} is not the pinned ${DRIVER_FILE} (SHA-256 mismatch). ` +
      'Only that exact version is allowed — never a newer Tactrix/EcuFlash package.');
  }

  console.log(`Verified ${DRIVER_FILE} (pinned SHA-256).`);
  console.log(`Choose the passkey that unlocks the driver install in the app (at least ${MIN_LENGTH} characters; typing is hidden).`);
  const passkey = await askHidden('Passkey: ');
  if (passkey.length < MIN_LENGTH) fail(`passkey must be at least ${MIN_LENGTH} characters.`);
  if ((await askHidden('Repeat passkey: ')) !== passkey) fail('the two entries did not match — nothing was changed.');

  const salt = randomBytes(16);
  const hash = scryptSync(passkey, salt, SCRYPT.keyLength, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: scryptMaxmem(SCRYPT.N, SCRYPT.r),
  });

  mkdirSync(bundleDir, { recursive: true });
  copyFileSync(source, path.join(bundleDir, DRIVER_FILE));
  writeFileSync(
    path.join(bundleDir, PASSKEY_FILE),
    JSON.stringify({ version: 1, salt: salt.toString('hex'), hash: hash.toString('hex'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, null, 2) + '\n'
  );
  console.log(`Driver bundle ready in ${path.relative(root, bundleDir)} (gitignored).`);
  console.log('Build the private installer with: npm run release:win:private');
}

await main();
