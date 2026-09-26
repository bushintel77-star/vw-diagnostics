// Locks the OpenPort driver into the app with a passkey.
//
//   npm run driver:encrypt [-- path\to\openport2_setup_1004341.exe]
//   node scripts/encrypt-driver.mjs --check
//
// Verifies the installer against the pinned SHA-256, asks for a passkey
// (hidden, typed twice) and writes resources/driver/openport-driver.enc +
// openport-driver.json. Only ciphertext is written; the plain installer and
// the passkey never land in the repo. Every build — including the public
// installer on the website — then carries the locked driver. `--check`
// guards release:win so a website release never ships without it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DRIVER_FILE,
  DRIVER_SHA256,
  ENCRYPTED_FILE,
  META_FILE,
  MIN_PASSKEY_LENGTH,
  encryptDriver,
  isValidMeta,
  sha256,
} from './driver-bundle.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundleDir = path.join(root, 'resources', 'driver');

const fail = (message) => {
  console.error(`encrypt-driver: ${message}`);
  process.exit(1);
};

function check() {
  const blob = path.join(bundleDir, ENCRYPTED_FILE);
  let meta;
  try {
    meta = JSON.parse(readFileSync(path.join(bundleDir, META_FILE), 'utf8'));
  } catch {
    fail(`missing ${META_FILE} — run: npm run driver:encrypt`);
  }
  if (!isValidMeta(meta) || !existsSync(blob)) fail('locked driver is missing or invalid — run: npm run driver:encrypt');
  if (readFileSync(blob).length !== meta.size) fail(`${ENCRYPTED_FILE} does not match its metadata — run: npm run driver:encrypt`);
  console.log('encrypt-driver: locked driver present (pinned 1.01.4341, AES-256-GCM).');
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
  const plain = readFileSync(source);
  if (sha256(plain) !== DRIVER_SHA256) {
    fail(`${source} is not the pinned ${DRIVER_FILE} (SHA-256 mismatch). ` +
      'Only that exact version is allowed — never a newer Tactrix/EcuFlash package.');
  }

  console.log(`Verified ${DRIVER_FILE} (version 1.01.4341).`);
  console.log(`Choose the passkey people type in the app to install the driver.`);
  console.log(`At least ${MIN_PASSKEY_LENGTH} characters — a short phrase is easiest (typing is hidden).`);
  const passkey = await askHidden('Passkey: ');
  if (passkey.length < MIN_PASSKEY_LENGTH) fail(`passkey must be at least ${MIN_PASSKEY_LENGTH} characters — nothing was changed.`);
  if ((await askHidden('Type it again: ')) !== passkey) fail('the two entries did not match — nothing was changed.');

  console.log('Locking the driver…');
  const { meta, ciphertext } = encryptDriver(plain, passkey);
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(path.join(bundleDir, ENCRYPTED_FILE), ciphertext);
  writeFileSync(path.join(bundleDir, META_FILE), JSON.stringify(meta, null, 2) + '\n');
  console.log(`Done: ${path.relative(root, bundleDir)}${path.sep}${ENCRYPTED_FILE} (locked; safe to commit and publish).`);
}

await main();
