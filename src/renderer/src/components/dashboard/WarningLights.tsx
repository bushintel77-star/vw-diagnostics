import { DtcCode, LiveValues } from "@shared/types";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/utils";

/**
 * Instrument-cluster tell-tales. Symbols are hand-drawn SVGs of the standard
 * ISO 2575 road-vehicle tell-tales (the same standardized glyphs every
 * cluster uses) — not any brand's trademarked artwork. Lamp states are
 * derived from live session data and stored fault codes.
 */

type Severity = "amber" | "red" | "blue";

interface Lamp {
  id: string;
  label: string;
  hint: string;
  on: boolean;
  severity: Severity;
  blinking?: boolean;
  icon: React.ReactNode;
}

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const EngineIcon = (
  <svg viewBox="0 0 48 48" className="size-9">
    <path
      {...STROKE}
      d="M13 28v-10h6v-3h10l4 4h4a3 3 0 0 1 3 3v2h3a2 2 0 0 1 2 2v6h-4v4a2 2 0 0 1-2 2H22l-3-3h-6v-7z"
    />
    <path {...STROKE} d="M40 22v-4M44 24l2-2" />
  </svg>
);

const GlowIcon = (
  <svg viewBox="0 0 48 48" className="size-9">
    <polyline
      {...STROKE}
      points="24,6 24,10 29,13 19,17 29,21 19,25 29,29 19,33 24,36 24,42"
    />
  </svg>
);

const DpfIcon = (
  <svg viewBox="0 0 48 48" className="size-9">
    <rect {...STROKE} x="8" y="14" width="26" height="20" rx="2" />
    {[
      [14, 20], [20, 20], [26, 20],
      [14, 26], [20, 26], [26, 26],
    ].map(([cx, cy]) => (
      <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.8" fill="currentColor" />
    ))}
    <path {...STROKE} d="M38 19c2.5 2.5 2.5 5 0 7.5M38 29.5c2.5 2.5 2.5 5 0 7.5" />
  </svg>
);

const ScrIcon = (
  <svg viewBox="0 0 48 48" className="size-9">
    <path
      {...STROKE}
      d="M24 6c7 9 10 13.5 10 19a10 10 0 1 1-20 0c0-5.5 3-10 10-19z"
    />
    <circle cx="24" cy="26" r="2.6" fill="currentColor" />
  </svg>
);

const BatteryIcon = (
  <svg viewBox="0 0 48 48" className="size-9">
    <rect {...STROKE} x="8" y="17" width="32" height="18" rx="2" />
    <path {...STROKE} d="M14 17v-4h6v4M28 17v-4h6v4" />
    <path {...STROKE} d="M15 26h6M18 23v6M27 26h6" />
  </svg>
);

const CoolantIcon = (
  <svg viewBox="0 0 48 48" className="size-9">
    <path {...STROKE} d="M24 6v22" />
    <circle {...STROKE} cx="24" cy="33" r="5.5" />
    <circle cx="24" cy="33" r="2.4" fill="currentColor" />
    <path {...STROKE} d="M8 44c3-3 6-3 9 0s6 3 9 0 6-3 9 0 5 3 7 0" />
  </svg>
);

const SEVERITY_STYLES: Record<Severity, string> = {
  amber: "text-amber-500 border-amber-500/40 bg-amber-500/10",
  red: "text-red-500 border-red-500/40 bg-red-500/10",
  blue: "text-sky-500 border-sky-500/40 bg-sky-500/10",
};

interface WarningLightsProps {
  /** null = never read this session; [] = ECU read, zero faults reported. */
  codes: DtcCode[] | null;
  live: LiveValues | null;
}

const WarningLights = ({ codes, live }: WarningLightsProps) => {
  const codeList = codes ?? [];
  const hasCode = (prefixes: string[], status?: DtcCode["status"]) =>
    codeList.some(
      (c) =>
        prefixes.some((p) => c.code.startsWith(p)) &&
        (status === undefined || c.status === status)
    );

  const stored = codeList.filter((c) => c.status === "Stored");
  const pending = codeList.filter((c) => c.status === "Pending");
  const active = codeList.filter((c) => c.status === "Active");
  // Stored or currently-failing codes — the ones that describe a real fault.
  const flagged = [...stored, ...active];

  // statusOfDTC bit 7 is the ECU actually requesting the MIL. When a real
  // DTC read supplies it, the lamp keys on it — presence of a code alone
  // is not an illuminated tell-tale. Sources that don't decode the byte
  // fall back to code presence.
  const anyMilBit = codeList.some((c) => c.warningIndicator !== undefined);
  const milOn = anyMilBit
    ? codeList.some((c) => c.warningIndicator === true)
    : codeList.length > 0;

  const glowFault = hasCode(["P067"]);
  const dpfStored = hasCode(["P2002", "P2463"], "Stored");
  const dpfPending = hasCode(["P2002", "P2463"], "Pending");
  const scrFault = hasCode(["P204F", "P20E8", "P3057"]);

  // null channel = the read failed this sample — a tell-tale must never
  // assert a threshold on a value that isn't there.
  const coolant = live?.coolantTempC ?? null;
  const battery = live?.batteryV ?? null;

  const lamps: Lamp[] = [
    {
      id: "mil",
      label: "Check engine",
      hint:
        stored.length > 0
          ? `Stored fault codes (${stored.map((c) => c.code).join(", ")})`
          : active.length > 0
            ? `Active fault codes (${active.map((c) => c.code).join(", ")})`
            : pending.length > 0
              ? `Pending fault codes (${pending.map((c) => c.code).join(", ")})`
              : codes === null
                ? "No fault-code data"
                : "No fault codes stored",
      on: milOn,
      severity: "amber",
      blinking: pending.length > 0 && flagged.length === 0,
      icon: EngineIcon,
    },
    {
      id: "glow",
      label: "Glow plugs",
      hint: glowFault
        ? "Glow plug circuit fault stored"
        : coolant !== null && coolant < 20
          ? "Preheat — engine cold"
          : coolant === null
            ? live === null
              ? "No live data"
              : "No coolant reading"
            : "Glow plugs ready",
      on: glowFault || (coolant !== null && coolant < 20),
      severity: "amber",
      icon: GlowIcon,
    },
    {
      id: "dpf",
      label: "DPF",
      hint: dpfPending
        ? "Particulate filter: regeneration needed (pending code)"
        : dpfStored
          ? "Particulate filter efficiency fault stored"
          : codes === null
            ? "No fault-code data"
            : "Particulate filter OK",
      on: dpfStored || dpfPending,
      severity: "amber",
      blinking: dpfPending && !dpfStored,
      icon: DpfIcon,
    },
    {
      id: "scr",
      label: "AdBlue / SCR",
      hint: scrFault
        ? "NOx aftertreatment fault stored"
        : codes === null
          ? "No fault-code data"
          : "NOx aftertreatment OK",
      on: scrFault,
      severity: "amber",
      icon: ScrIcon,
    },
    {
      id: "battery",
      label: "Battery",
      hint:
        battery !== null && battery < 12.5
          ? `Charging voltage low (${battery.toFixed(1)} V)`
          : battery === null
            ? live === null
              ? "No live data"
              : "No battery reading"
            : "Charging system OK",
      on: battery !== null && battery < 12.5,
      severity: "red",
      icon: BatteryIcon,
    },
    {
      id: "coolant",
      label: "Coolant",
      hint:
        coolant !== null && coolant > 105
          ? `Overheating (${coolant} °C) — stop safely`
          : coolant !== null && coolant < 50
            ? `Engine cold (${coolant} °C)`
            : coolant === null
              ? live === null
                ? "No live data"
                : "No coolant reading"
              : "Coolant temperature normal",
      on: coolant !== null && (coolant > 105 || coolant < 50),
      severity: coolant !== null && coolant > 105 ? "red" : "blue",
      blinking: coolant !== null && coolant > 105,
      icon: CoolantIcon,
    },
  ];

  const anyOn = lamps.some((l) => l.on);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Warning Lights</CardTitle>
        <CardDescription>
          Cluster tell-tales (ISO 2575 symbols) driven by fault codes and live
          data
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap justify-center gap-3">
          {lamps.map((lamp) => (
            <div
              key={lamp.id}
              role="img"
              aria-label={`${lamp.label}: ${lamp.on ? lamp.hint : "off"}`}
              data-state={lamp.on ? "on" : "off"}
              title={lamp.hint}
              className={cn(
                "flex w-[5.5rem] flex-col items-center gap-1 rounded-lg border p-2 transition-colors",
                lamp.on ? SEVERITY_STYLES[lamp.severity] : "border-transparent text-muted-foreground/25",
                lamp.on && lamp.blinking && "animate-lamp-blink motion-reduce:animate-none"
              )}
            >
              {lamp.icon}
              {/* The lamp glyph dims when off, like a real cluster; its label
                  stays readable (WCAG 1.4.3) in both states. */}
              <span
                className={cn(
                  "text-center text-[10px] font-medium leading-tight",
                  lamp.on ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {lamp.label}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-center text-[10px] text-muted-foreground">
          {anyOn
            ? "Red = stop safely · amber = caution / service · blue = engine cold"
            : codes === null || live === null
              ? "No data — connect an interface and start a session"
              : codes.length > 0
                /* Lamps off is not all-clear while the ECU reports codes —
                   it only means none are requesting a tell-tale. */
                ? `No tell-tales lit — ${codes.length} fault code${codes.length === 1 ? "" : "s"} below`
                : "All tell-tales off — no active warnings"}
        </p>
      </CardContent>
    </Card>
  );
};

export default WarningLights;
