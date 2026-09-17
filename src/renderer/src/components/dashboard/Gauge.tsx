import { cn } from "@/utils";

interface GaugeProps {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  decimals?: number;
  /** Draw in warning/danger colors at/above these thresholds. */
  warnAt?: number;
  dangerAt?: number;
  /** Rolling samples for the sparkline and min/max readout. */
  history?: number[];
}

const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const pointsTo = (values: number[], width: number, height: number): string => {
  if (values.length < 2) return "";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - 2 - ((v - lo) / span) * (height - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
};

const Gauge = ({
  label,
  value,
  unit,
  min,
  max,
  decimals = 0,
  warnAt,
  dangerAt,
  history,
}: GaugeProps) => {
  const fraction = Math.min(Math.max((value - min) / (max - min), 0), 1);
  const strokeColor =
    dangerAt !== undefined && value >= dangerAt
      ? "stroke-destructive"
      : warnAt !== undefined && value >= warnAt
        ? "stroke-chart-4"
        : "stroke-chart-1";
  const display = value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const stats =
    history && history.length > 1
      ? { lo: Math.min(...history), hi: Math.max(...history) }
      : null;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative w-full max-w-24">
        <svg viewBox="0 0 100 100" className="w-full -rotate-90">
          <circle
            cx="50"
            cy="50"
            r={RADIUS}
            fill="none"
            strokeWidth="9"
            className="stroke-muted"
          />
          <circle
            cx="50"
            cy="50"
            r={RADIUS}
            fill="none"
            strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray={`${fraction * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            className={cn(strokeColor, "transition-all duration-300")}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-bold tabular-nums">{display}</span>
          <span className="text-[10px] text-muted-foreground">{unit}</span>
        </div>
      </div>
      <span className="text-xs font-medium">{label}</span>
      {history && history.length > 1 && (
        <>
          <svg viewBox="0 0 64 14" className="h-3.5 w-16" preserveAspectRatio="none">
            <polyline
              points={pointsTo(history, 64, 14)}
              fill="none"
              strokeWidth="1.5"
              className="stroke-chart-2"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {stats && (
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {stats.lo.toFixed(decimals)} – {stats.hi.toFixed(decimals)}
            </span>
          )}
        </>
      )}
    </div>
  );
};

export default Gauge;
