import { describe, expect, test, vi } from "vitest";
import { randomBytes, scryptSync } from "node:crypto";

// cableSetup.ts runs in the Electron main process; vitest mocks the module.
vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/no-such-app" },
}));

import {
  PasskeyGate,
  cableStateFromCode,
  isTactrixRegistration,
  parseCableQuery,
  parseWindowsBuild,
  verifyPasskey,
} from "../../../../main/lib/cableSetup";

// Cheap scrypt cost for tests; production records carry their own N/r/p.
const makeRecord = (passkey: string) => {
  const salt = randomBytes(16);
  const N = 1024;
  const r = 8;
  const p = 1;
  return {
    salt: salt.toString("hex"),
    hash: scryptSync(passkey, salt, 32, { N, r, p }).toString("hex"),
    N,
    r,
    p,
  };
};

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

  test("an empty PnP result means the cable is not plugged in", () => {
    expect(parseCableQuery("[]")).toEqual({ cable: "absent", code: null });
    expect(parseCableQuery("")).toEqual({ cable: "absent", code: null });
  });

  test("a single unwrapped PnP row is still read", () => {
    const row = JSON.stringify({ PNPDeviceID: "USB\\VID_0403&PID_CC4D\\X", ConfigManagerErrorCode: 39 });
    expect(parseCableQuery(row)).toEqual({ cable: "blocked", code: 39 });
  });

  test("any healthy cable wins over a faulty second one", () => {
    const rows = JSON.stringify([{ ConfigManagerErrorCode: 39 }, { ConfigManagerErrorCode: 0 }]);
    expect(parseCableQuery(rows)).toEqual({ cable: "ready", code: null });
  });

  test("unreadable output is 'unknown', never a false 'absent'", () => {
    expect(parseCableQuery("#< CLIXML garbage")).toEqual({ cable: "unknown", code: null });
  });

  test("recognises the Tactrix J2534 registration", () => {
    const reg = [
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\PassThruSupport.04.04\\Tactrix Inc. - OpenPort 2.0 J2534 ISO/CAN/VPW/PWM",
      "    Name    REG_SZ    OpenPort 2.0 J2534 ISO/CAN/VPW/PWM",
      "    Vendor    REG_SZ    Tactrix Inc.",
      "    FunctionLibrary    REG_SZ    C:\\WINDOWS\\SysWOW64\\op20pt32.dll",
    ].join("\r\n");
    expect(isTactrixRegistration(reg)).toBe(true);
    expect(isTactrixRegistration("    Vendor    REG_SZ    Other Corp")).toBe(false);
  });
});

describe("passkey", () => {
  test("verifies only the exact passkey", () => {
    const record = makeRecord("truck-5534");
    expect(verifyPasskey("truck-5534", record)).toBe(true);
    expect(verifyPasskey("truck-5535", record)).toBe(false);
    expect(verifyPasskey("", record)).toBe(false);
  });

  test("an empty stored hash never verifies", () => {
    expect(verifyPasskey("anything", { ...makeRecord("x"), hash: "" })).toBe(false);
  });

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
