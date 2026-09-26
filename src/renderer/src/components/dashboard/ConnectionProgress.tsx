import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/utils";
import { DiagnosticPhase } from "@shared/types";

/**
 * Animated "connecting to the truck" progress. Every step is driven by a
 * real event from the monitor (status phase, ECU identity, the DID map, the
 * first live sample) — nothing advances on a timer, so a stalled step stays
 * visibly stalled instead of pretending to progress.
 */

export interface ConnectionSignals {
  phase: DiagnosticPhase | null;
  hasInfo: boolean;
  hasDids: boolean;
  hasLive: boolean;
}

const STEPS = [
  "Checking Python and the cable driver",
  "Opening the cable",
  "Reading the ECU's identity",
  "Mapping live data channels",
  "Streaming live data",
];

/** Index of the step in progress (STEPS.length when all are done). */
export function connectionStep({ phase, hasInfo, hasDids, hasLive }: ConnectionSignals): number {
  if (hasLive) return 5;
  if (hasDids) return 4;
  if (hasInfo) return 3;
  if (phase === "connected") return 2;
  if (phase === "connecting") return 1;
  return 0;
}

export default function ConnectionProgress(signals: ConnectionSignals): React.JSX.Element {
  const current = connectionStep(signals);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    // Neon frame: a 1px single-hue signal gradient flowing while connecting.
    // Decoration never borrows a status colour (amber/red/green mean state).
    <div className="rounded-xl bg-[linear-gradient(90deg,hsl(var(--signal)),hsl(var(--signal)/0.2),hsl(var(--signal)))] bg-[length:300%_100%] p-px shadow-[0_0_24px_-6px_hsl(var(--signal)/0.6)] animate-border-flow motion-reduce:animate-none">
    <Card className="overflow-hidden rounded-[11px] border-0">
      {/* indeterminate sweep: something is happening, without a fake % */}
      <div className="relative h-1 overflow-hidden bg-muted">
        <div className="absolute inset-y-0 w-1/4 animate-sweep rounded-full bg-gradient-to-r from-transparent via-signal to-transparent shadow-[0_0_12px_2px_hsl(var(--signal)/0.8)] motion-reduce:animate-none" />
      </div>
      <CardContent className="flex flex-wrap items-start gap-x-8 gap-y-3 p-4">
        <div className="min-w-44">
          <p className="text-sm font-semibold">Connecting to the truck…</p>
          <p className="text-xs tabular-nums text-muted-foreground" aria-live="off">
            {seconds}s · step {Math.min(current + 1, STEPS.length)} of {STEPS.length}
          </p>
        </div>
        <ol aria-label="Connection progress" className="flex flex-1 flex-wrap gap-x-5 gap-y-2">
          {STEPS.map((label, index) => {
            const done = index < current;
            const active = index === current;
            return (
              <li
                key={label}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "flex items-center gap-1.5 text-xs transition-colors duration-300",
                  done ? "text-foreground" : active ? "font-medium text-foreground" : "text-muted-foreground/70"
                )}
              >
                <span
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded-full",
                    done &&
                      "bg-chart-2 text-background shadow-[0_0_8px_hsl(var(--chart-2)/0.9)] animate-cell-pop motion-reduce:animate-none",
                    active && "text-signal drop-shadow-[0_0_6px_hsl(var(--signal))]",
                    !done && !active && "border border-border"
                  )}
                >
                  {done ? (
                    <Check className="size-2.5" strokeWidth={3} />
                  ) : active ? (
                    <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                  ) : null}
                </span>
                {label}
                <span className="sr-only">{done ? ", done" : active ? ", in progress" : ""}</span>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
    </div>
  );
}
