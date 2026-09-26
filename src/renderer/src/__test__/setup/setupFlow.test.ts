import { describe, expect, test } from "vitest";
import { CableSetupStatus } from "@shared/types";
import {
  attentionKey,
  currentStep,
  deriveChecks,
  findBlocker,
  stepStates,
} from "@/components/setup/setupFlow";

const base: CableSetupStatus = {
  platformSupported: true,
  windowsBuild: 19045,
  driverInstalled: true,
  driverBundled: false,
  cable: "absent",
  cableProblemCode: null,
  preflight: null,
  lockedForSeconds: 0,
  unlocked: false,
  checkedAt: "2026-09-26T00:00:00.000Z",
};
const status = (patch: Partial<CableSetupStatus>): CableSetupStatus => ({ ...base, ...patch });
const WIN11 = 26200;
const pythonOk = { ready: true, message: "ok", bitness: 32, python: "py32" };
const pythonBad = { ready: false, message: "32-bit DLL cannot load in 64-bit Python.\nmore", bitness: 64, python: "py64" };

describe("the step always follows live status", () => {
  test.each([
    ["no status yet", null, "check"],
    ["browser session", status({ platformSupported: false }), "check"],
    ["driver missing", status({ driverInstalled: false }), "driver"],
    ["cable has no driver (Code 28)", status({ cable: "no_driver", cableProblemCode: 28 }), "driver"],
    ["cable unplugged", status({}), "plug"],
    ["cable blocked", status({ cable: "blocked", cableProblemCode: 39 }), "plug"],
    ["cable ready", status({ cable: "ready" }), "ready"],
  ] as const)("%s", (_, input, expected) => {
    expect(currentStep(input)).toBe(expected);
  });
});

describe("blockers", () => {
  test("Windows 11 Code 39 explains the policy block and warns off security workarounds", () => {
    const blocker = findBlocker(status({ windowsBuild: WIN11, cable: "blocked", cableProblemCode: 39 }));
    expect(blocker?.kind).toBe("windows_block");
    expect(blocker?.body).toMatch(/Code 39/);
    expect(blocker?.steps.join(" ")).toMatch(/Windows 10/);
    expect(blocker?.caution).toMatch(/Don't turn off Windows security features/);
  });

  test("Code 39 on Windows 10 is a reinstall, not a policy block", () => {
    expect(findBlocker(status({ cable: "blocked", cableProblemCode: 39 }))?.kind).toBe("driver_failed");
  });

  test("a disabled cable (Code 22) says how to enable it", () => {
    const blocker = findBlocker(status({ cable: "problem", cableProblemCode: 22 }));
    expect(blocker?.title).toMatch(/turned off/);
    expect(blocker?.steps.join(" ")).toMatch(/Enable device/);
  });

  test("a Python mismatch blocks the ready step with the first line of the reason", () => {
    const blocker = findBlocker(status({ cable: "ready", preflight: pythonBad }));
    expect(blocker?.kind).toBe("python");
    expect(blocker?.body).toBe("32-bit DLL cannot load in 64-bit Python.");
  });

  test("a healthy setup has no blocker", () => {
    expect(findBlocker(status({ cable: "ready", preflight: pythonOk }))).toBeNull();
    expect(findBlocker(status({}))).toBeNull();
  });
});

describe("progress", () => {
  test("a complete setup marks every step done", () => {
    expect(Object.values(stepStates(status({ cable: "ready", preflight: pythonOk })))).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
  });

  test("a blocked cable marks the plug step, not the whole flow", () => {
    expect(stepStates(status({ windowsBuild: WIN11, cable: "blocked", cableProblemCode: 39 }))).toEqual({
      check: "done",
      driver: "done",
      plug: "blocked",
      ready: "todo",
    });
  });
});

describe("self-checks", () => {
  test("Windows 11 is only a warning until the cable proves it works", () => {
    const checks = (s: CableSetupStatus) => Object.fromEntries(deriveChecks(s).map((c) => [c.id, c.state]));
    expect(checks(status({ windowsBuild: WIN11 })).windows).toBe("warn");
    expect(checks(status({ windowsBuild: WIN11, cable: "ready" })).windows).toBe("pass");
  });

  test("the Python link waits for the driver", () => {
    const python = deriveChecks(status({ driverInstalled: false })).find((c) => c.id === "python");
    // Static "later", not a spinner: nothing is running for it yet.
    expect(python).toMatchObject({ state: "later", detail: "Checked after the driver is installed" });
  });

  test("an unplugged cable is waiting, not failing", () => {
    expect(deriveChecks(status({})).find((c) => c.id === "cable")?.state).toBe("waiting");
  });
});

describe("auto-open", () => {
  test("opens for problems, never for a healthy or merely unplugged setup", () => {
    expect(attentionKey(status({}))).toBeNull();
    expect(attentionKey(status({ cable: "ready", preflight: pythonOk }))).toBeNull();
    expect(attentionKey(status({ platformSupported: false }))).toBeNull();
    expect(attentionKey(status({ driverInstalled: false }))).toBe("driver-missing");
    expect(attentionKey(status({ cable: "blocked", cableProblemCode: 39 }))).toBe("cable-blocked-39");
    expect(attentionKey(status({ cable: "ready", preflight: pythonBad }))).toBe("python");
  });
});
