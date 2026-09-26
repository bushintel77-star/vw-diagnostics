import { ReactNode } from "react";
import { cn } from "@/utils";
import { DiagnosticStatusEvent, EcuInfo } from "@shared/types";

/**
 * Always-visible session strip: link state, ECU, protocol, sample rate,
 * session clock and data age — the context a telemetry engineer glances at
 * before trusting any number on screen.
 */

const clock = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
};

function Item({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="font-mono text-xs tabular-nums">{children}</span>
    </div>
  );
}

export default function StatusBar({
  status,
  info,
  sampleHz,
  sessionSeconds,
  dataAgeSeconds,
  stale,
}: {
  status: DiagnosticStatusEvent | null;
  info: EcuInfo | null;
  sampleHz: number | null;
  sessionSeconds: number | null;
  dataAgeSeconds: number | null;
  stale: boolean;
}): React.JSX.Element {
  const phase = status?.phase ?? "disconnected";
  const link =
    phase === "connected"
      ? stale
        ? { text: "STALE", dot: "bg-chart-4" }
        : { text: "LIVE", dot: "bg-chart-2 shadow-[0_0_8px_hsl(var(--chart-2))]" }
      : phase === "starting" || phase === "connecting"
        ? { text: "LINKING", dot: "bg-chart-1 animate-pulse motion-reduce:animate-none" }
        : phase === "error"
          ? { text: "ERROR", dot: "bg-destructive" }
          : { text: "OFFLINE", dot: "bg-muted-foreground/50" };

  return (
    // A labelled group, not role="status": a live region here would make
    // screen readers announce the session clock every second.
    <div
      role="group"
      aria-label="Session status"
      className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border bg-card/70 px-4 py-2 backdrop-blur"
    >
      <div className="flex items-center gap-2">
        <span className={cn("size-2 rounded-full", link.dot)} />
        <span className="font-mono text-xs font-semibold tracking-wider">{link.text}</span>
      </div>
      <Item label="ECU">{info?.ecuName ?? "—"}</Item>
      <Item label="Bus">{info?.protocol ?? "—"}</Item>
      <Item label="Rate">{sampleHz !== null ? `${sampleHz.toFixed(1)} Hz` : "—"}</Item>
      <Item label="Session">{sessionSeconds !== null ? clock(sessionSeconds) : "—"}</Item>
      <Item label="Data age">{dataAgeSeconds !== null ? `${dataAgeSeconds}s` : "—"}</Item>
    </div>
  );
}
