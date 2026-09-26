import { cn } from "@/utils";
import { LiveValues } from "@shared/types";

/**
 * The numbers that matter, first and biggest — motorsport-telemetry
 * hierarchy: large tabular value, unit, where it sits in its range, and the
 * session min / max (peak hold). Colour only at real limits. A channel the
 * ECU didn't answer shows "—", never a stale or substitute number.
 */

export interface KeyChannel {
  key: keyof LiveValues;
  label: string;
  unit: string;
  min: number;
  max: number;
  decimals?: number;
  warnAt?: number;
  dangerAt?: number;
}

export type SessionStats = Partial<Record<keyof LiveValues, { min: number; max: number }>>;

const fmt = (value: number, decimals = 0): string =>
  value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

export default function KeyNumbers({
  channels,
  live,
  stats,
  stale,
}: {
  channels: KeyChannel[];
  live: LiveValues | null;
  stats: SessionStats;
  stale: boolean;
}): React.JSX.Element {
  return (
    <section
      aria-label="Key numbers"
      className={cn(
        "grid grid-cols-3 gap-2 transition-opacity lg:grid-cols-6",
        stale && "opacity-40 grayscale"
      )}
    >
      {channels.map((channel) => {
        const raw = live?.[channel.key];
        const value = raw != null && Number.isFinite(raw) ? raw : null;
        const level =
          value === null
            ? "none"
            : channel.dangerAt !== undefined && value >= channel.dangerAt
              ? "danger"
              : channel.warnAt !== undefined && value >= channel.warnAt
                ? "warn"
                : "ok";
        const fraction =
          value === null ? 0 : Math.min(Math.max((value - channel.min) / (channel.max - channel.min), 0), 1);
        const range = stats[channel.key];
        return (
          <div
            key={channel.key}
            className={cn(
              "rounded-xl border bg-card px-3 pb-2.5 pt-2 transition-colors duration-300",
              level === "danger" && "border-destructive/70 shadow-[0_0_14px_-4px_hsl(var(--destructive))]",
              level === "warn" && "border-chart-4/70",
              level === "none" && "border-border/60"
            )}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {channel.label}
              </span>
              <span className="text-[10px] text-muted-foreground">{channel.unit}</span>
            </div>
            <div
              className={cn(
                "mt-0.5 text-3xl font-bold leading-none tabular-nums tracking-tight",
                value === null && "text-muted-foreground/50",
                level === "warn" && "text-chart-4",
                level === "danger" && "text-destructive"
              )}
            >
              {value === null ? "—" : fmt(value, channel.decimals)}
            </div>
            {/* position within the channel's range */}
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-300",
                  level === "danger" ? "bg-destructive" : level === "warn" ? "bg-chart-4" : "bg-chart-1"
                )}
                style={{ width: `${fraction * 100}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground">
              <span title="Session minimum">min {range ? fmt(range.min, channel.decimals) : "—"}</span>
              <span title="Session peak">max {range ? fmt(range.max, channel.decimals) : "—"}</span>
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** Folds one live sample into the session min/max. */
export function foldStats(stats: SessionStats, live: LiveValues, keys: (keyof LiveValues)[]): SessionStats {
  const next: SessionStats = { ...stats };
  for (const key of keys) {
    const value = live[key];
    if (value == null || !Number.isFinite(value)) continue;
    const prev = next[key];
    next[key] = prev ? { min: Math.min(prev.min, value), max: Math.max(prev.max, value) } : { min: value, max: value };
  }
  return next;
}
