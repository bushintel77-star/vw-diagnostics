import { Gauge as GaugeIcon, Play } from "lucide-react";
import { DiagnosticPullEvent, PullSample } from "@shared/types";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/utils";

const WIDTH = 600;
const HEIGHT = 240;
const PAD_L = 8;
const PAD_R = 8;

const hp = (kw: number): number => kw * 1.341;

const linePoints = (
  samples: PullSample[],
  revMin: number,
  revMax: number,
  valueMin: number,
  valueMax: number,
  pick: (s: PullSample) => number
): string =>
  samples
    .map((s) => {
      const x = PAD_L + ((s.rpm - revMin) / (revMax - revMin)) * (WIDTH - PAD_L - PAD_R);
      const y =
        HEIGHT - 24 - ((pick(s) - valueMin) / (valueMax - valueMin)) * (HEIGHT - 48);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

interface PullChartProps {
  pulls: DiagnosticPullEvent[];
  running: boolean;
  onRunPull: () => void;
}

const PullChart = ({ pulls, running, onRunPull }: PullChartProps) => {
  const latest = pulls[pulls.length - 1];
  const previous = pulls[pulls.length - 2];

  const revMin = latest ? 1400 : 1000;
  const revMax = Math.max(6500, latest?.revLimit ?? 6500);
  const powerMax = latest
    ? Math.max(220, Math.ceil(latest.peakPowerKw * 1.15))
    : 220;
  const torqueMax = latest
    ? Math.max(420, Math.ceil(latest.peakTorqueNm * 1.1))
    : 420;

  const powerDelta =
    previous && latest ? latest.peakPowerKw - previous.peakPowerKw : null;
  const torqueDelta =
    previous && latest ? latest.peakTorqueNm - previous.peakTorqueNm : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <GaugeIcon className="size-4 text-chart-1" />
          Performance Graphs — Dyno Pull
          {pulls.length > 0 && (
            <Badge variant="secondary">{pulls.length} pull{pulls.length === 1 ? "" : "s"}</Badge>
          )}
          <Button
            size="sm"
            className="ml-auto h-7 text-xs"
            disabled={!running}
            onClick={onRunPull}
          >
            <Play className="size-3.5 fill-current" />
            Run Dyno Pull
          </Button>
        </CardTitle>
        <CardDescription>
          Full-throttle sweep reference curves — apply a mod and pull again to
          compare before/after
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!latest ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {running
              ? 'Click "Run Dyno Pull" to sweep the engine and plot power/torque curves.'
              : "Start a session to run dyno pulls."}
          </p>
        ) : (
          <>
            {/* curve chart */}
            <svg
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              className="h-60 w-full"
              preserveAspectRatio="none"
            >
              {[2000, 3000, 4000, 5000, 6000].map(
                (rpm) =>
                  rpm < revMax && (
                    <g key={rpm}>
                      <line
                        x1={PAD_L + ((rpm - revMin) / (revMax - revMin)) * (WIDTH - PAD_L - PAD_R)}
                        x2={PAD_L + ((rpm - revMin) / (revMax - revMin)) * (WIDTH - PAD_L - PAD_R)}
                        y1={12}
                        y2={HEIGHT - 24}
                        className="stroke-border"
                        strokeDasharray="3 4"
                        strokeWidth="1"
                      />
                      <text
                        x={PAD_L + ((rpm - revMin) / (revMax - revMin)) * (WIDTH - PAD_L - PAD_R)}
                        y={HEIGHT - 8}
                        textAnchor="middle"
                        className="fill-muted-foreground text-[9px]"
                      >
                        {rpm / 1000}k
                      </text>
                    </g>
                  )
              )}
              {previous && (
                <polyline
                  points={linePoints(
                    previous.samples, revMin, revMax, 0, powerMax, (s) => s.powerKw
                  )}
                  fill="none"
                  className="stroke-muted-foreground"
                  strokeWidth="1.5"
                  strokeDasharray="5 4"
                  opacity="0.6"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <polyline
                points={linePoints(latest.samples, revMin, revMax, 0, powerMax, (s) => s.powerKw)}
                fill="none"
                className="stroke-chart-1"
                strokeWidth="2.5"
                vectorEffect="non-scaling-stroke"
              />
              <polyline
                points={linePoints(latest.samples, revMin, revMax, 0, torqueMax, (s) => s.torqueNm)}
                fill="none"
                className="stroke-chart-2"
                strokeWidth="2.5"
                vectorEffect="non-scaling-stroke"
              />
              {latest.modsActive.includes("stage1") && (
                <g>
                  {(() => {
                    const y = HEIGHT - 24 - (710 / torqueMax) * (HEIGHT - 48);
                    const x1 = PAD_L + ((1500 - revMin) / (revMax - revMin)) * (WIDTH - PAD_L - PAD_R);
                    const x2 = PAD_L + ((3000 - revMin) / (revMax - revMin)) * (WIDTH - PAD_L - PAD_R);
                    return (
                      <>
                        <line
                          x1={x1} x2={x2} y1={y} y2={y}
                          className="stroke-chart-4"
                          strokeDasharray="6 4"
                          strokeWidth="2"
                          vectorEffect="non-scaling-stroke"
                        />
                        <text x={x1 + 4} y={y - 4} className="fill-chart-4 text-[9px]">
                          10-s overboost 710 Nm
                        </text>
                      </>
                    );
                  })()}
                </g>
              )}
            </svg>

            {/* legend + peaks */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-5 rounded bg-chart-1" />
                Power — peak{" "}
                <span className="font-semibold tabular-nums">
                  {latest.peakPowerKw.toFixed(0)} kW ({hp(latest.peakPowerKw).toFixed(0)} hp){" "}
                  @ {latest.peakPowerRpm.toLocaleString()} rpm
                </span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-5 rounded bg-chart-2" />
                Torque — peak{" "}
                <span className="font-semibold tabular-nums">
                  {latest.peakTorqueNm.toFixed(0)} Nm @ {latest.peakTorqueRpm.toLocaleString()} rpm
                </span>
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="inline-block h-0.5 w-5 rounded bg-muted-foreground/60" />
                Previous pull (dashed)
              </span>
            </div>

            {/* delta vs previous */}
            {(powerDelta !== null || torqueDelta !== null) && (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg bg-muted/50 p-2.5 text-xs">
                <span className="text-muted-foreground">
                  #{latest.index} ({latest.label}) vs #{previous.index} ({previous.label}):
                </span>
                {powerDelta !== null && (
                  <span
                    className={cn(
                      "font-semibold tabular-nums",
                      powerDelta > 0.5
                        ? "text-chart-2"
                        : powerDelta < -0.5
                          ? "text-destructive"
                          : "text-muted-foreground"
                    )}
                  >
                    {powerDelta > 0 ? "+" : ""}
                    {powerDelta.toFixed(1)} kW power
                  </span>
                )}
                {torqueDelta !== null && (
                  <span
                    className={cn(
                      "font-semibold tabular-nums",
                      torqueDelta > 0.5
                        ? "text-chart-2"
                        : torqueDelta < -0.5
                          ? "text-destructive"
                          : "text-muted-foreground"
                    )}
                  >
                    {torqueDelta > 0 ? "+" : ""}
                    {torqueDelta.toFixed(0)} Nm torque
                  </span>
                )}
              </div>
            )}

            {/* pull history */}
            <div className="flex flex-wrap gap-1.5">
              {pulls.map((pull) => (
                <Badge
                  key={pull.index}
                  variant={pull.index === latest.index ? "default" : "outline"}
                  className="text-[10px] font-normal"
                >
                  #{pull.index} · {pull.label} · {pull.peakPowerKw.toFixed(0)} kW
                </Badge>
              ))}
            </div>
          </>
        )}
        <p className="text-[10px] leading-snug text-muted-foreground">
          Simulated reference curves (2.0 TSI profile scaled by active mods),
          not measured wheel output — real pulls arrive with the live J2534
          transport. Peak values move with Stage 1 and rev-limiter mods.
        </p>
      </CardContent>
    </Card>
  );
};

export default PullChart;
