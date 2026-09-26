import { LiveValues } from "@shared/types";

import { cn } from "@/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export interface ChannelConfig {
  key: keyof LiveValues;
  label: string;
  unit: string;
  decimals: number;
}

interface StripChartProps {
  channels: ChannelConfig[];
  selected: keyof LiveValues;
  onSelect: (key: keyof LiveValues) => void;
  history: Partial<Record<keyof LiveValues, number[]>>;
  running: boolean;
}

const WIDTH = 600;
const HEIGHT = 160;

const linePoints = (values: number[]): string => {
  if (values.length < 2) return "";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * WIDTH;
      const y = HEIGHT - 12 - ((v - lo) / span) * (HEIGHT - 36);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
};

const StripChart = ({
  channels,
  selected,
  onSelect,
  history,
  running,
}: StripChartProps) => {
  const channel = channels.find((c) => c.key === selected) ?? channels[0];
  const values = history[selected] ?? [];
  const stats =
    values.length > 0
      ? {
          lo: Math.min(...values),
          hi: Math.max(...values),
          avg: values.reduce((a, b) => a + b, 0) / values.length,
        }
      : null;
  const fmt = (n: number) =>
    n.toLocaleString(undefined, {
      minimumFractionDigits: channel.decimals,
      maximumFractionDigits: channel.decimals,
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trend — {channel.label}</CardTitle>
        <CardDescription>
          Rolling session history (last {Math.round(values.length * 0.5)}s at
          2 samples/s) — essential for catching intermittent faults
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {channels.map((c) => (
            <Button
              key={c.key}
              size="sm"
              variant={c.key === selected ? "default" : "outline"}
              className={cn("h-7 px-2.5 text-xs", c.key === selected && "font-semibold")}
              onClick={() => onSelect(c.key)}
            >
              {c.label}
            </Button>
          ))}
        </div>

        <div className="relative">
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="h-40 w-full"
            preserveAspectRatio="none"
          >
            {[0.25, 0.5, 0.75].map((frac) => (
              <line
                key={frac}
                x1="0"
                x2={WIDTH}
                y1={HEIGHT * frac}
                y2={HEIGHT * frac}
                className="stroke-border"
                strokeDasharray="4 4"
                strokeWidth="1"
              />
            ))}
            {values.length > 1 && (
              <>
                <polyline
                  points={`${linePoints(values)} ${WIDTH},${HEIGHT} 0,${HEIGHT}`}
                  className="fill-signal"
                  opacity="0.12"
                />
                <polyline
                  points={linePoints(values)}
                  fill="none"
                  className="stroke-signal"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              </>
            )}
          </svg>
          {values.length < 2 && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              {running
                ? "Collecting samples…"
                : "Start a session to record trends"}
            </div>
          )}
        </div>

        {stats && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs tabular-nums text-muted-foreground">
            <span>
              min <span className="font-semibold text-foreground">{fmt(stats.lo)}</span>{" "}
              {channel.unit}
            </span>
            <span>
              avg <span className="font-semibold text-foreground">{fmt(stats.avg)}</span>{" "}
              {channel.unit}
            </span>
            <span>
              max <span className="font-semibold text-foreground">{fmt(stats.hi)}</span>{" "}
              {channel.unit}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default StripChart;
