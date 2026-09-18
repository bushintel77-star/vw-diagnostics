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

  const stored = codeList.filter((c) => c.status !== "Pending");
  const pending = codeList.filter((c) => c.status === "Pending");
  const glowFault = hasCode(["P067"]);
  const dpfStored = hasCode(["P2002", "P2463"], "Stored");
  const dpfPending = hasCode(["P2002", "P2463"], "Pending");
  const scrFault = hasCode(["P204F", "P20E8", "P3057"]);

  const lamps: Lamp[] = [
    {
      id: "mil",
      label: "Check engine",
      hint:
        stored.length > 0
          ? `Stored fault codes (${stored.map((c) => c.code).join(", ")})`
          : pending.length > 0
            ? `Pending fault codes (${pending.map((c) => c.code).join(", ")})`
            : codes === null
              ? "No fault-code data"
              : "No fault codes stored",
      on: codeList.length > 0,
      severity: "amber",
      blinking: pending.length > 0 && stored.length === 0,
      icon: EngineIcon,
    },
    {
      id: "glow",
      label: "Glow plugs",
      hint: glowFault
        ? "Glow plug circuit fault stored"
        : live && live.coolantTempC < 20
          ? "Preheat — engine cold"
          : codes === null && live === null
            ? "No data"
            : "Glow plugs ready",
      on: glowFault || (live !== null && live.coolantTempC < 20),
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
        live && live.batteryV < 12.5
          ? `Charging voltage low (${live.batteryV.toFixed(1)} V)`
          : live === null
            ? "No live data"
            : "Charging system OK",
      on: live !== null && live.batteryV < 12.5,
      severity: "red",
      icon: BatteryIcon,
    },
    {
      id: "coolant",
      label: "Coolant",
      hint:
        live && live.coolantTempC > 105
          ? `Overheating (${live.coolantTempC} °C) — stop safely`
          : live && live.coolantTempC < 50
            ? `Engine cold (${live.coolantTempC} °C)`
            : live === null
              ? "No live data"
              : "Coolant temperature normal",
      on: live !== null && (live.coolantTempC > 105 || live.coolantTempC < 50),
      severity: live && live.coolantTempC > 105 ? "red" : "blue",
      blinking: live !== null && live.coolantTempC > 105,
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
                lamp.on && lamp.blinking && "animate-lamp-blink"
              )}
            >
              {lamp.icon}
              <span className="text-center text-[9px] font-medium leading-tight">
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
              : "All tell-tales off — no active warnings"}
        </p>
      </CardContent>
    </Card>
  );
};

export default WarningLights;
