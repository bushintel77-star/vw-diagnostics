import { Sparkles, TrendingUp } from "lucide-react";
import {
  ChannelState,
  DiagnosticAnalysisEvent,
  LiveValues,
} from "@shared/types";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import Gauge from "@/components/dashboard/Gauge";

const severityColor = (severity: string) =>
  severity === "high"
    ? "bg-destructive"
    : severity === "medium"
      ? "bg-chart-4"
      : "bg-chart-2";

const labelColor = (label: string) =>
  label === "Good"
    ? "text-chart-2"
    : label === "Fair"
      ? "text-chart-4"
      : "text-destructive";

const CHANNEL_NAMES: Partial<Record<keyof LiveValues, string>> = {
  rpm: "RPM",
  coolantTempC: "Coolant",
  boostPressureKpa: "Boost",
  batteryV: "Battery",
  engineLoadPct: "Load",
  pedalPct: "Pedal",
  railPressureBar: "Rail",
  intakeTempC: "Intake",
  speedKph: "Speed",
};

const stateDot = (state: ChannelState["state"]) =>
  state === "abnormal"
    ? "bg-destructive"
    : state === "elevated"
      ? "bg-chart-4"
      : state === "normal"
        ? "bg-chart-2"
        : "bg-muted-foreground/40";

const PROVENANCE_LABELS: Record<string, string> = {
  "static-fallback": "Static thresholds — baselines still learning",
  "session-learned": "Session-learned baselines",
  "cross-session": "Cross-session baselines",
};

const AssistantCard = ({
  analysis,
}: {
  analysis: DiagnosticAnalysisEvent | null;
}) => (
  <Card className="flex flex-col">
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        <Sparkles className="size-4 text-chart-1" />
        AI Diagnostic Assistant
      </CardTitle>
      <CardDescription>
        Streaming statistical analysis on-device — learns this vehicle's
        baselines and predicts trends
      </CardDescription>
    </CardHeader>
    {analysis === null ? (
      <CardContent className="space-y-3">
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </CardContent>
    ) : (
      <CardContent className="flex-1 space-y-4">
        <div className="flex flex-wrap items-center gap-6">
          <Gauge
            label="Vehicle health"
            value={analysis.healthScore}
            unit="/ 100"
            min={0}
            max={100}
          />
          <div className="min-w-56 flex-1 space-y-2">
            <div className="flex items-center gap-2">
              <span
                className={`text-lg font-bold ${labelColor(analysis.healthLabel)}`}
              >
                {analysis.healthLabel}
              </span>
              <Badge variant="outline" className="font-mono text-[10px]">
                {new Date(analysis.generatedAt).toLocaleTimeString()}
              </Badge>
            </div>
            <p className="text-sm">{analysis.summary}</p>
          </div>
        </div>

        {/* tier-1 statistical layer */}
        {analysis.provenance && (
          <p className="text-xs text-muted-foreground">
            {PROVENANCE_LABELS[analysis.provenance.mode] ??
              analysis.provenance.mode}
            {" · "}
            {analysis.provenance.baselineSamples.toLocaleString()} samples ·{" "}
            {analysis.provenance.sessions} session
            {analysis.provenance.sessions === 1 ? "" : "s"}
            {analysis.provenance.mode === "static-fallback" &&
              " · static thresholds active until warm-up"}
          </p>
        )}

        {analysis.stream && analysis.stream.predictions.length > 0 && (
          <div className="space-y-2 rounded-lg border border-chart-4/40 bg-chart-4/10 p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-chart-4">
              <TrendingUp className="size-3.5" />
              Predictive alerts
            </p>
            {analysis.stream.predictions.map((prediction) => (
              <div key={prediction.channel} className="text-xs">
                <p>{prediction.message}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {prediction.etaSeconds !== null &&
                    `ETA ~${Math.max(1, Math.round(prediction.etaSeconds / 60))} min · `}
                  {Math.round(prediction.confidence * 100)}% confidence —
                  extrapolation, not a certainty
                </p>
              </div>
            ))}
          </div>
        )}

        {analysis.findings.length > 0 && (
          <ul className="space-y-3">
            {analysis.findings.map((finding) => (
              <li
                key={finding.code}
                className="rounded-lg border bg-background/50 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`size-2 rounded-full ${severityColor(finding.severity)}`}
                    aria-label={`${finding.severity} severity`}
                  />
                  <span className="font-mono text-xs font-bold">
                    {finding.code}
                  </span>
                  <span className="text-sm font-semibold">{finding.title}</span>
                  <Badge variant="secondary" className="ml-auto text-[10px]">
                    {Math.round(finding.confidence * 100)}% confidence
                  </Badge>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {finding.detail}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {finding.likelyCauses.map((cause) => (
                    <Badge key={cause} variant="outline" className="text-[10px] font-normal">
                      {cause}
                    </Badge>
                  ))}
                </div>
                <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-xs">
                  {finding.actions.map((action) => (
                    <li key={action}>{action}</li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        )}

        {analysis.stream && Object.keys(analysis.stream.channels).length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Learned baselines vs. live
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
              {(Object.entries(analysis.stream.channels) as Array<
                [keyof LiveValues, ChannelState]
              >).map(([key, channel]) => (
                <div key={key} className="flex items-center gap-1.5 text-xs">
                  <span className={`size-1.5 rounded-full ${stateDot(channel.state)}`} />
                  <span className="text-muted-foreground">
                    {CHANNEL_NAMES[key] ?? key}
                  </span>
                  <span className="ml-auto tabular-nums">
                    {channel.baseline.toFixed(1)} ±{channel.stddev.toFixed(1)}
                  </span>
                  <span
                    className={`w-9 text-right tabular-nums ${
                      channel.state === "learning"
                        ? "text-muted-foreground/50"
                        : channel.zScore >= 0
                          ? "text-chart-4"
                          : "text-chart-3"
                    }`}
                  >
                    {channel.state === "learning" ? "—" : `${channel.zScore > 0 ? "+" : ""}${channel.zScore}σ`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {analysis.advisories.length > 0 && (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {analysis.advisories.map((advisory) => (
              <li key={advisory}>• {advisory}</li>
            ))}
          </ul>
        )}

        <p className="text-[10px] leading-snug text-muted-foreground">
          Statistical analysis generated on-device from this session's stream:
          EWMA baselines with deviation bands and confidence-gated trend
          extrapolation. Assists diagnosis but is not a substitute for a
          qualified technician or the factory repair manual.
        </p>
      </CardContent>
    )}
  </Card>
);

export default AssistantCard;
