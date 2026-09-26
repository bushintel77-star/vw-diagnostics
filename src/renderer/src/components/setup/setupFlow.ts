import { CableSetupStatus } from "@shared/types";

/**
 * Pure decision logic for the cable setup wizard: which step you're on,
 * what each self-check shows, and what (if anything) is blocking you. The
 * wizard renders this; it never decides flow on its own. Plug-and-play: the
 * step is always derived from live status, so plugging the cable in or
 * finishing the installer advances the flow without a click.
 */

export type StepId = "check" | "driver" | "plug" | "ready";
export type StepState = "done" | "current" | "todo" | "blocked";
// "waiting" = actively watching (cable); "pending" = check in flight;
// "later" = not applicable until an earlier step is done.
export type CheckState = "pass" | "warn" | "fail" | "waiting" | "pending" | "later";
export type CheckId = "windows" | "driver" | "cable" | "python";

export const STEPS: { id: StepId; label: string }[] = [
  { id: "check", label: "Check" },
  { id: "driver", label: "Driver" },
  { id: "plug", label: "Plug in" },
  { id: "ready", label: "Ready" },
];

export interface CheckItem {
  id: CheckId;
  label: string;
  state: CheckState;
  detail: string;
}

export interface Blocker {
  kind:
    | "unsupported"
    | "windows_block"
    | "driver_failed"
    | "device_problem"
    | "python";
  title: string;
  body: string;
  steps: string[];
  caution?: string;
}

export const isWindows11 = (build: number | null): boolean =>
  build !== null && build >= 22000;

export function currentStep(status: CableSetupStatus | null): StepId {
  if (!status || !status.platformSupported) return "check";
  if (!status.driverInstalled || status.cable === "no_driver") return "driver";
  if (status.cable !== "ready") return "plug";
  return "ready";
}

export function findBlocker(status: CableSetupStatus | null): Blocker | null {
  if (!status) return null;
  if (!status.platformSupported) {
    return {
      kind: "unsupported",
      title: "Cable setup runs in the Windows app",
      body: "Open VW Diagnostics on the Windows computer your cable plugs into.",
      steps: [],
    };
  }
  const code = status.cableProblemCode;
  if (status.cable === "blocked" && isWindows11(status.windowsBuild)) {
    return {
      kind: "windows_block",
      title: "Windows 11 is blocking this cable's driver",
      body:
        `Your cable is plugged in, but Windows refused to load its driver (Code ${code ?? 39}). ` +
        "Windows 11's driver rules block older drivers like this one, and nothing in this app can safely get around that.",
      steps: [
        "Use a Windows 10 computer: install the driver there, then plug the cable in.",
        "Or run Windows 10 in a virtual machine on this PC and pass the cable through to it.",
      ],
      caution:
        "Don't turn off Windows security features (Memory integrity, the driver blocklist or test signing) to force it. That puts this PC at risk.",
    };
  }
  if (status.cable === "blocked") {
    return {
      kind: "driver_failed",
      title: "Windows couldn't load the cable's driver",
      body: `Device Manager reports Code ${code ?? 39} for your cable.`,
      steps: [
        "Unplug the cable.",
        "Install the driver again, keeping version 1.01.4341.",
        "Plug the cable back in. This screen updates by itself.",
      ],
    };
  }
  if (status.cable === "problem") {
    return code === 22
      ? {
          kind: "device_problem",
          title: "The cable is turned off in Device Manager",
          body: "Windows has the cable disabled (Code 22).",
          steps: [
            "Press Win + X, then choose Device Manager.",
            "Right-click the OpenPort entry and choose Enable device.",
          ],
        }
      : {
          kind: "device_problem",
          title: `Windows reports a problem with the cable${code ? ` (Code ${code})` : ""}`,
          body: "The cable is plugged in, but Windows stopped it.",
          steps: [
            "Unplug the cable and wait five seconds.",
            "Plug it straight into the computer, not through a hub or dock.",
            "If its light doesn't cycle through colours, try another USB lead. Many are charge-only.",
          ],
        };
  }
  if (status.cable === "ready" && status.preflight && !status.preflight.ready) {
    return {
      kind: "python",
      title: "Python can't use the cable driver yet",
      body: firstLine(status.preflight.message) || "The Python check didn't pass.",
      steps: [
        "The cable's driver is 32-bit, so the app needs 32-bit Python 3.",
        "Install 32-bit Python 3 from python.org, or set VWD_PYTHON to a 32-bit python.exe.",
        "Then choose Check again.",
      ],
    };
  }
  return null;
}

/** Which step the blocker belongs to, so the stepper can mark it. */
const blockerStep = (blocker: Blocker): StepId =>
  blocker.kind === "unsupported" ? "check" : blocker.kind === "python" ? "ready" : "plug";

export function stepStates(status: CableSetupStatus | null): Record<StepId, StepState> {
  const current = currentStep(status);
  const blocker = findBlocker(status);
  const index = STEPS.findIndex((step) => step.id === current);
  const complete = status !== null && current === "ready" && blocker === null;
  return Object.fromEntries(
    STEPS.map((step, i) => {
      let state: StepState = i < index ? "done" : i === index ? "current" : "todo";
      if (complete) state = "done";
      else if (i === index && blocker && blockerStep(blocker) === step.id) state = "blocked";
      return [step.id, state];
    })
  ) as Record<StepId, StepState>;
}

export function deriveChecks(status: CableSetupStatus | null): CheckItem[] {
  if (!status) {
    return [
      { id: "windows", label: "Windows", state: "pending", detail: "Checking…" },
      { id: "driver", label: "Cable driver", state: "pending", detail: "Checking…" },
      { id: "cable", label: "Cable", state: "pending", detail: "Checking…" },
      { id: "python", label: "Python link", state: "pending", detail: "Checking…" },
    ];
  }

  const win11 = isWindows11(status.windowsBuild);
  const windowsName = status.windowsBuild
    ? `Windows ${win11 ? "11" : "10"} · build ${status.windowsBuild}`
    : "Windows";
  const windows: CheckItem = !status.platformSupported
    ? { id: "windows", label: "Windows", state: "fail", detail: "Needs the Windows desktop app" }
    : win11 && status.cable !== "ready"
      ? { id: "windows", label: "Windows", state: "warn", detail: `${windowsName}. Older cable drivers can be blocked` }
      : { id: "windows", label: "Windows", state: "pass", detail: windowsName };

  const driver: CheckItem = status.driverInstalled
    ? { id: "driver", label: "Cable driver", state: "pass", detail: "OpenPort J2534 driver installed" }
    : { id: "driver", label: "Cable driver", state: "fail", detail: "Not installed yet" };

  const cableDetail: Record<CableSetupStatus["cable"], [CheckState, string]> = {
    absent: ["waiting", "Not plugged in"],
    ready: ["pass", "Connected and working"],
    blocked: ["fail", `Windows blocked its driver (Code ${status.cableProblemCode ?? 39})`],
    no_driver: ["fail", "Plugged in, but no driver attached (Code 28)"],
    problem: ["fail", `Windows reports a problem${status.cableProblemCode ? ` (Code ${status.cableProblemCode})` : ""}`],
    unknown: ["warn", "Couldn't read Device Manager"],
  };
  const [cableState, cableText] = cableDetail[status.cable];

  const pre = status.preflight;
  const python: CheckItem = !status.driverInstalled
    ? { id: "python", label: "Python link", state: "later", detail: "Checked after the driver is installed" }
    : pre === null
      ? { id: "python", label: "Python link", state: "pending", detail: "Not checked yet" }
      : pre.ready
        ? { id: "python", label: "Python link", state: "pass", detail: `${pre.bitness ?? 32}-bit Python matches the driver` }
        : { id: "python", label: "Python link", state: "fail", detail: "Python can't load the driver" };

  return [
    windows,
    driver,
    { id: "cable", label: "Cable", state: cableState, detail: cableText },
    python,
  ];
}

/** Auto-open key: the wizard opens by itself once per distinct problem. */
export function attentionKey(status: CableSetupStatus | null): string | null {
  if (!status || !status.platformSupported) return null;
  if (!status.driverInstalled) return "driver-missing";
  if (["blocked", "no_driver", "problem"].includes(status.cable)) {
    return `cable-${status.cable}-${status.cableProblemCode ?? ""}`;
  }
  if (status.cable === "ready" && status.preflight && !status.preflight.ready) {
    return "python";
  }
  return null;
}

const firstLine = (text: string): string => text.split("\n").find((line) => line.trim())?.trim() ?? "";
