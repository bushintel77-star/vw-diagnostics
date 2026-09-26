import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Activity,
  ChevronDown,
  GripVertical,
  HelpCircle,
  Minus,
  X,
} from "lucide-react";

/**
 * WorkflowGuide — a draggable sticky note shown on launch.
 *
 * The getting-started journey lives in the app so nobody has to leave it to
 * find the next step or the common fix for a stage. Persists position and
 * collapsed state in localStorage. Pure renderer: works in Electron and the
 * web demo alike.
 */

interface Stage {
  id: string;
  title: string;
  status: "now" | "later";
  how: string;
  fixes: string[];
}

const STAGES: Stage[] = [
  {
    id: "explore",
    title: "1 · Check the connection setup",
    status: "now",
    how:
      "Start Session attempts a real connection to the adapter and vehicle. Check the existing driver and Python interpreter first. There is no simulation mode in the app.",
    fixes: [
      "The read-only preflight in HARDWARE.md checks the registry and DLL file without opening the adapter.",
      "Live values appear only after the vehicle answers; missing channels show no data.",
    ],
  },
  {
    id: "driver",
    title: "2 · Keep the compatible J2534 driver",
    status: "later",
    how:
      "Use the driver package confirmed for your adapter. If it is already installed, keep it. The Cable setup wizard (header) checks it for you; a private build can launch the pinned 1.01.4341 installer behind a passkey. The app never runs firmware updaters.",
    fixes: [
      "For a clone using a legacy driver, avoid newer Tactrix/EcuFlash installers and firmware updates.",
      "A 32-bit op20pt32.dll needs 32-bit Python even on 64-bit Windows 11. Set VWD_PYTHON if automatic selection fails.",
    ],
  },
  {
    id: "cable",
    title: "3 · Plug the adapter in",
    status: "later",
    how:
      "USB into the laptop first, then check the LED — a colour-cycling pulse means the adapter is powered and running. Then look in Device Manager (Win+R → devmgmt.msc): the adapter should be listed.",
    fixes: [
      "LED cycles but nothing in Device Manager → the shipped USB cable is probably charge-only (power wires, no data). Swap any known-good mini-USB data cable — old camera / PS3-controller cables fit.",
      "Entries like 'AAP Client' or 'Wireless iAP' under Other devices are phone/Bluetooth leftovers, not the adapter.",
    ],
  },
  {
    id: "smoke",
    title: "4 · Verify setup before connecting",
    status: "later",
    how:
      "Run the read-only preflight from HARDWARE.md. A ready result means the Python architecture and driver file match; it does not prove the USB connection. Start Session subsequently opens the adapter and expects a vehicle response.",
    fixes: [
      "No J2534 registration → check whether your existing driver package registered its DLL.",
      "Wrong architecture → select 32-bit Python for the 32-bit driver; preserve the known compatible driver.",
    ],
  },
  {
    id: "truck",
    title: "5 · Connect to the truck",
    status: "later",
    how:
      "Ignition ON (engine off is fine), adapter into the OBD port under the dash, then Start Session live. The app probes which DIDs your ECU answers, reads ECU identity, and streams live channels.",
    fixes: [
      "No response → check ignition is fully on; some trucks need headlights-door-ignition cycles to wake the CAN bus.",
      "A channel showing 'no data' means the ECU didn't answer that DID — the probe will have tried alternates; see the Live DID map in the ECU card.",
    ],
  },
  {
    id: "read",
    title: "6 · Read fault codes & watch live data",
    status: "later",
    how:
      "The app reads fault codes and their status bytes, then adds known code descriptions. Freeze frames are not yet read. Live channels use exact response widths; baselines are learned per session.",
    fixes: [
      "Clearing codes only clears what the ECU reports — pending codes may return if the fault is still present.",
      "Boost may show less than expected: some PIDs saturate; the probe notes say which DID was adopted.",
    ],
  },
  {
    id: "flash",
    title: "7 · Tuning & flash (gated)",
    status: "later",
    how:
      "The mods catalog describes calibrations but writes nothing — the flash path stays locked until ECU security access (seed/key) and the calibration layout exist. The stock backup honestly refuses on live hardware until then.",
    fixes: [
      "This gate is deliberate: a fake backup is worse than none.",
      "The hardware plan for the flash stage (bench read, checksum, tools) is documented in HARDWARE.md in the repo.",
    ],
  },
];

const STORAGE_KEY = "vwd.guide";

interface GuideState {
  open: boolean;
  x: number;
  y: number;
  stage: string | null;
}

function loadState(): GuideState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return { open: true, x: 24, y: 90, stage: null, ...JSON.parse(raw) };
  } catch {
    /* private mode etc. */
  }
  return { open: true, x: 24, y: 90, stage: null };
}

export default function WorkflowGuide(): React.JSX.Element {
  const [state, setState] = useState<GuideState>(loadState);
  const [expanded, setExpanded] = useState<string | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state]);

  // Keep the sticky inside the viewport after resize/drag.
  useEffect(() => {
    const clamp = (): void => {
      setState((s) => ({
        ...s,
        x: Math.max(8, Math.min(s.x, window.innerWidth - 340)),
        y: Math.max(8, Math.min(s.y, window.innerHeight - 120)),
      }));
    };
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);

  const onPointerDown = (e: React.PointerEvent): void => {
    if ((e.target as HTMLElement).closest("button")) return;
    dragRef.current = { dx: e.clientX - state.x, dy: e.clientY - state.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!dragRef.current) return;
    setState((s) => ({
      ...s,
      x: e.clientX - dragRef.current!.dx,
      y: e.clientY - dragRef.current!.dy,
    }));
  };
  const onPointerUp = (): void => {
    dragRef.current = null;
  };

  if (!state.open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="fixed bottom-4 right-4 z-50 gap-2 shadow-lg"
        onClick={() => setState((s) => ({ ...s, open: true }))}
        aria-label="Open workflow guide"
      >
        <HelpCircle className="size-4" />
        Guide
      </Button>
    );
  }

  return (
    <div
      ref={cardRef}
      className="fixed z-50 w-80 select-none"
      style={{ left: state.x, top: state.y }}
    >
      <Card className="border-border/80 bg-card/95 shadow-2xl backdrop-blur">
        <div
          className="flex cursor-grab items-center gap-1.5 border-b px-2 py-1.5 active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <GripVertical className="size-3.5 text-muted-foreground" />
          <Activity className="size-4 text-chart-1" />
          <span className="font-serif text-sm font-bold">Workflow guide</span>
          <Badge variant="outline" className="ml-1 text-[10px] text-muted-foreground">
            sticky
          </Badge>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Hide guide"
            onClick={() => setState((s) => ({ ...s, open: false }))}
          >
            <Minus className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Close guide"
            onClick={() => setState((s) => ({ ...s, open: false }))}
          >
            <X className="size-3.5" />
          </Button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {STAGES.map((stage) => {
            const isOpen = expanded === stage.id;
            return (
              <div key={stage.id} className="mb-1">
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : stage.id)}
                >
                  <ChevronDown
                    className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
                      isOpen ? "" : "-rotate-90"
                    }`}
                  />
                  <span className="text-xs font-medium">{stage.title}</span>
                  {stage.status === "now" && (
                    <Badge className="ml-auto border-chart-1/50 bg-chart-1/10 text-[9px] text-chart-1" variant="outline">
                      start here
                    </Badge>
                  )}
                </button>
                {isOpen && (
                  <div className="ml-6 space-y-2 border-l pl-3 pb-2 pt-1">
                    <p className="text-xs leading-relaxed text-foreground/90">
                      {stage.how}
                    </p>
                    {stage.fixes.map((fix) => (
                      <p key={fix} className="text-[11px] leading-relaxed text-muted-foreground">
                        <span className="font-semibold text-foreground/70">Fix:</span>{" "}
                        {fix}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <p className="px-2 pb-1 pt-2 text-[10px] text-muted-foreground">
            Drag by the title bar · position remembered · reopen from the Guide
            button
          </p>
        </div>
      </Card>
    </div>
  );
}
