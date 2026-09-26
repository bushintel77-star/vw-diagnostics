import { describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";

// cableSetup.ts runs in the Electron main process; vitest mocks the module.
vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/no-such-app" },
}));

import {
  PasskeyGate,
  SAFE_DRIVER_VERSION,
  cableStateFromCode,
  driverVersionState,
  isTactrixRegistration,
  parseProbeQuery,
  parseWindowsBuild,
} from "../../../../main/lib/cableSetup";
import {
  DRIVER_SHA256,
  decryptDriver,
  encryptDriver,
  isValidMeta,
} from "../../../../../scripts/driver-bundle.mjs";

describe("device and system parsing", () => {
  test("reads the Windows build from os.release()", () => {
    expect(parseWindowsBuild("10.0.26200")).toBe(26200);
    expect(parseWindowsBuild("10.0.19045")).toBe(19045);
    expect(parseWindowsBuild("10.0")).toBeNull();
  });

  test("maps Device Manager problem codes to wizard states", () => {
    expect(cableStateFromCode(0)).toBe("ready");
    expect(cableStateFromCode(39)).toBe("blocked");
    expect(cableStateFromCode(52)).toBe("blocked");
    expect(cableStateFromCode(28)).toBe("no_driver");
    expect(cableStateFromCode(45)).toBe("absent");
    expect(cableStateFromCode(43)).toBe("problem");
  });

  test("no device rows means the cable is not plugged in", () => {
    expect(parseProbeQuery('{"devices":[],"driverVersion":"1.01.0.4341"}')).toEqual({
      cable: "absent",
      code: null,
      driverVersion: "1.01.0.4341",
    });
  });

  test("a single unwrapped device row is still read", () => {
    const out = JSON.stringify({ devices: { ConfigManagerErrorCode: 39 }, driverVersion: null });
    expect(parseProbeQuery(out)).toEqual({ cable: "blocked", code: 39, driverVersion: null });
  });

  test("any healthy cable wins over a faulty second one", () => {
    const out = JSON.stringify({ devices: [{ ConfigManagerErrorCode: 39 }, { ConfigManagerErrorCode: 0 }] });
    expect(parseProbeQuery(out)).toMatchObject({ cable: "ready", code: null });
  });

  test("unreadable output is 'unknown', never a false 'absent'", () => {
    expect(parseProbeQuery("#< CLIXML garbage")).toEqual({ cable: "unknown", code: null, driverVersion: null });
  });

  test("recognises the Tactrix J2534 registration", () => {
    const reg = [
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\PassThruSupport.04.04\\Tactrix Inc. - OpenPort 2.0 J2534 ISO/CAN/VPW/PWM",
      "    Vendor    REG_SZ    Tactrix Inc.",
      "    FunctionLibrary    REG_SZ    C:\\WINDOWS\\SysWOW64\\op20pt32.dll",
    ].join("\r\n");
    expect(isTactrixRegistration(reg)).toBe(true);
    expect(isTactrixRegistration("    Vendor    REG_SZ    Other Corp")).toBe(false);
  });
});

describe("driver version guard", () => {
  test("only 1.01.0.4341 is the safe version", () => {
    expect(SAFE_DRIVER_VERSION).toBe("1.01.0.4341");
    expect(driverVersionState("1.01.0.4341")).toBe("match");
  });

  test("anything newer is flagged, compared numerically", () => {
    expect(driverVersionState("1.02.0.4820")).toBe("newer");
    expect(driverVersionState("1.01.0.4342")).toBe("newer");
    expect(driverVersionState("1.10.0.1")).toBe("newer");
    expect(driverVersionState("2.0.0.0")).toBe("newer");
  });

  test("older and unreadable versions are not mistaken for the dangerous case", () => {
    expect(driverVersionState("1.01.0.4227")).toBe("older");
    expect(driverVersionState("1.0.0.4227")).toBe("older");
    expect(driverVersionState(null)).toBe("unknown");
    expect(driverVersionState("garbage")).toBe("unknown");
  });
});

// Encryption round-trips need the real pinned installer, which is never in
// the repo; this fake stands in by spoofing only the hash check's input.
describe("locked driver (AES-256-GCM, passkey-derived key)", () => {
  const FAST = { N: 1024, r: 8, p: 1 };
  const plain = Buffer.from("pretend installer bytes");
  const hashOf = (data: Buffer) => createHash("sha256").update(data).digest("hex");

  test("refuses to lock anything but the pinned installer", () => {
    expect(hashOf(plain)).not.toBe(DRIVER_SHA256);
    expect(() => encryptDriver(plain, "a long passkey", FAST)).toThrow(/pinned/);
  });

  test("rejects metadata for any other installer", () => {
    const meta = {
      version: 1,
      cipher: "aes-256-gcm",
      kdf: "scrypt",
      N: 1024,
      r: 8,
      p: 1,
      salt: "00",
      iv: "00",
      tag: "00",
      sha256: "f".repeat(64),
      size: 1,
    };
    expect(isValidMeta(meta)).toBe(false);
    expect(isValidMeta({ ...meta, sha256: DRIVER_SHA256 })).toBe(true);
  });

  test("an empty or wrong passkey never decrypts", async () => {
    const meta = {
      version: 1,
      cipher: "aes-256-gcm",
      kdf: "scrypt",
      N: 1024,
      r: 8,
      p: 1,
      salt: "00112233445566778899aabbccddeeff",
      iv: "00112233445566778899aabb",
      tag: "00112233445566778899aabbccddeeff",
      sha256: DRIVER_SHA256,
      size: 4,
    };
    expect(await decryptDriver(Buffer.from("abcd"), meta, "")).toBeNull();
    expect(await decryptDriver(Buffer.from("abcd"), meta, "wrong passkey")).toBeNull();
    expect(await decryptDriver(Buffer.from("abcd"), { ...meta, cipher: "none" }, "x")).toBeNull();
  });
});

describe("passkey gate", () => {
  test("counts down attempts, then locks for a minute", () => {
    let now = 0;
    const gate = new PasskeyGate(() => now);
    for (const left of [4, 3, 2, 1]) {
      expect(gate.record(false)).toEqual({ ok: false, locked: false, attemptsLeft: left, lockedForSeconds: 0 });
    }
    expect(gate.record(false)).toMatchObject({ ok: false, locked: true, lockedForSeconds: 60 });
    // Locked: even the right passkey is refused until the timer ends.
    now = 30_000;
    expect(gate.record(true)).toMatchObject({ ok: false, locked: true, lockedForSeconds: 30 });
    now = 61_000;
    expect(gate.record(true)).toEqual({ ok: true });
    expect(gate.isUnlocked()).toBe(true);
  });

  test("an unlock lasts ten minutes, then the passkey is needed again", () => {
    let now = 0;
    const gate = new PasskeyGate(() => now);
    gate.record(true);
    now = 9 * 60_000;
    expect(gate.isUnlocked()).toBe(true);
    now = 10 * 60_000 + 1;
    expect(gate.isUnlocked()).toBe(false);
  });

  test("a correct entry resets the failure count", () => {
    const gate = new PasskeyGate(() => 0);
    gate.record(false);
    gate.record(false);
    gate.record(true);
    expect(gate.record(false)).toMatchObject({ attemptsLeft: 4 });
  });
});
