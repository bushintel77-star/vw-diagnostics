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
      // Stale = frozen, not current: grey + dashed + labelled, but still
      // readable (fading the text out would fail contrast).
      // The first channel is the one hero figure; the rest share a row. At the
      // app's default width (md) the hero gets its own row above five tiles.
      className={cn("grid grid-cols-2 gap-2 md:grid-cols-5 lg:grid-cols-7", stale && "grayscale")}
    >
      {channels.map((channel, index) => {
        const hero = index === 0;
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
              hero && "col-span-2 px-4 md:col-span-5 lg:col-span-2",
              level === "danger" && "border-destructive/70 shadow-[0_0_14px_-4px_hsl(var(--destructive))]",
              level === "warn" && "border-warning/70",
              level === "none" && "border-border/60",
              stale && "border-dashed"
            )}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {channel.label}
              </span>
              {/* Limits are stated in words too, never by colour alone (WCAG 1.4.1). */}
              {stale ? (
                <span className="rounded border border-border px-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  Stale
                </span>
              ) : level === "danger" || level === "warn" ? (
                <span
                  className={cn(
                    "rounded px-1 text-[11px] font-bold uppercase tracking-wider",
                    level === "danger" ? "bg-destructive text-destructive-foreground" : "bg-warning text-warning-foreground"
                  )}
                >
                  {level === "danger" ? "Limit" : "High"}
                </span>
              ) : (
                <span className="text-[11px] text-muted-foreground">{channel.unit}</span>
              )}
            </div>
            {/* Live numbers keep tabular digits so they don't jitter as they change. */}
            <div
              className={cn(
                "mt-1 font-bold leading-none tabular-nums tracking-tight",
                hero ? "text-5xl" : "text-3xl",
                value === null && "text-muted-foreground",
                level === "warn" && "text-warning",
                level === "danger" && "text-destructive"
              )}
            >
              {value === null ? "—" : fmt(value, channel.decimals)}
            </div>
            {/* Meter: the fill carries severity; the track is a light step of
                the same colour, so the state reads across the whole bar. */}
            <div
              className={cn(
                "mt-2 overflow-hidden rounded-full",
                hero ? "h-1.5" : "h-1",
                level === "danger" ? "bg-destructive/20" : level === "warn" ? "bg-warning/20" : level === "ok" ? "bg-signal/15" : "bg-muted"
              )}
            >
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-300",
                  level === "danger" ? "bg-destructive" : level === "warn" ? "bg-warning" : "bg-signal"
                )}
                style={{ width: `${fraction * 100}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted-foreground">
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
