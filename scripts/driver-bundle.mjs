// The one OpenPort 2.0 driver package this app will ever bundle or launch.
// Clone cables brick on newer Tactrix software and firmware updaters, so the
// installer is pinned by exact SHA-256 — shared by the private-build script
// (scripts/set-driver-passkey.mjs) and the main process (cableSetup.ts).

export const DRIVER_FILE = 'openport2_setup_1004341.exe';
export const DRIVER_SHA256 = '0516379fae4a1d68b0523ec5757539ff0d67312457868b4fb4fb6867c8aec1c0';
export const PASSKEY_FILE = 'passkey.json';

// scrypt cost for the passkey hash (~100 ms per check). maxmem must exceed
// 128 * N * r, which Node's 32 MiB default only just equals at these values.
export const SCRYPT = { N: 32768, r: 8, p: 1, keyLength: 32 };
export const scryptMaxmem = (N, r) => 256 * N * r;
