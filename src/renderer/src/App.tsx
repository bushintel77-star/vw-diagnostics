import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Download,
  Play,
  RotateCcw,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import Gauge from "@/components/dashboard/Gauge";
import DtcTable from "@/components/dashboard/DtcTable";
import EcuInfoCard from "@/components/dashboard/EcuInfoCard";
import AssistantCard from "@/components/dashboard/AssistantCard";
import StripChart from "@/components/dashboard/StripChart";
import PullChart from "@/components/dashboard/PullChart";
import DeletionPanel from "@/components/dashboard/DeletionPanel";
import ModsPanel, { ScopeCard } from "@/components/dashboard/ModsPanel";
import UpdateBanner from "@/components/dashboard/UpdateBanner";
import VerificationCard from "@/components/dashboard/VerificationCard";
import WarningLights from "@/components/dashboard/WarningLights";
import { isDemoMode } from "@/web/demoBridge";
import { isBrowserLive } from "@/web/liveBridge";
import {
  DiagnosticAnalysisEvent,
  DiagnosticDeletionsEvent,
  DiagnosticFlashEvent,
  DiagnosticModsEvent,
  DiagnosticPhase,
  DiagnosticPullEvent,
  DiagnosticStatusEvent,
  DiagnosticVerificationEvent,
  DidMapEntry,
  DutyProfile,
  DtcCode,
  EcuInfo,
  LiveValues,
} from "@shared/types";

interface GaugeConfig {
  key: keyof LiveValues;
  label: string;
  unit: string;
  min: number;
  max: number;
  decimals?: number;
  warnAt?: number;
  dangerAt?: number;
}

const GAUGES: GaugeConfig[] = [
  { key: "rpm", label: "Engine RPM", unit: "rpm", min: 0, max: 5500 },
  {
    key: "coolantTempC",
    label: "Coolant",
    unit: "°C",
    min: 0,
    max: 120,
    warnAt: 105,
    dangerAt: 115,
  },
  { key: "boostPressureKpa", label: "Boost", unit: "kPa", min: 0, max: 300 },
  { key: "batteryV", label: "Battery", unit: "V", min: 8, max: 16, decimals: 1 },
  { key: "engineLoadPct", label: "Engine Load", unit: "%", min: 0, max: 100 },
  { key: "pedalPct", label: "Pedal", unit: "%", min: 0, max: 100, decimals: 1 },
  { key: "railPressureBar", label: "Rail Pressure", unit: "bar", min: 0, max: 2200 },
  { key: "intakeTempC", label: "Intake Air", unit: "°C", min: -10, max: 90 },
  { key: "speedKph", label: "Vehicle Speed", unit: "km/h", min: 0, max: 200 },
];

const HISTORY_LENGTH = 120; // ~60 s at 2 samples/s
const STALE_AFTER_MS = 4000; // no live event for this long while running = stale

const ACTIVE_PHASES: DiagnosticPhase[] = [
  "starting",
  "connecting",
  "connected",
  "simulated",
];

const StatusBadge = ({ status }: { status: DiagnosticStatusEvent | null }) => {
  if (!status) return <Badge variant="outline">Not connected</Badge>;
  switch (status.phase) {
    case "connected":
      return <Badge>Connected</Badge>;
    case "simulated":
      return <Badge variant="secondary">Simulation</Badge>;
    case "starting":
    case "connecting":
      return <Badge variant="secondary">Connecting…</Badge>;
    case "error":
      return <Badge variant="destructive">Error</Badge>;
    default:
      return <Badge variant="outline">Disconnected</Badge>;
  }
};

const App = () => {
  const [simulate, setSimulate] = useState<boolean>(true);
  const [status, setStatus] = useState<DiagnosticStatusEvent | null>(null);
  const [info, setInfo] = useState<EcuInfo | null>(null);
  const [dids, setDids] = useState<DidMapEntry[] | null>(null);
  const [flash, setFlash] = useState<DiagnosticFlashEvent | null>(null);
  const [codes, setCodes] = useState<DtcCode[]>([]);
  const [live, setLive] = useState<LiveValues | null>(null);
  const [analysis, setAnalysis] = useState<DiagnosticAnalysisEvent | null>(null);
  const [deletions, setDeletions] = useState<DiagnosticDeletionsEvent | null>(null);
  const [mods, setMods] = useState<DiagnosticModsEvent | null>(null);
  const [pulls, setPulls] = useState<DiagnosticPullEvent[]>([]);
  const [history, setHistory] = useState<Partial<Record<keyof LiveValues, number[]>>>({});
  const [selectedChannel, setSelectedChannel] = useState<keyof LiveValues>("rpm");
  const [updates, setUpdates] = useState<number>(0);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState<boolean>(false);
  const [verification, setVerification] = useState<DiagnosticVerificationEvent | null>(null);
  const [liveRequested, setLiveRequested] = useState<boolean>(false);
  const [fallbackDismissed, setFallbackDismissed] = useState<boolean>(false);
  const [lastLiveAt, setLastLiveAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState<number>(Date.now());
  const [dutyProfile, setDutyProfile] = useState<DutyProfile>("standard");

  const pushLog = (text: string): void => {
    const entry = `${new Date().toLocaleTimeString()}  ${text}`;
    setLog((prev) => [entry, ...prev].slice(0, 10));
  };

  useEffect(() => {
    // 1 Hz heartbeat so the stale-data watchdog re-renders.
    const ticker = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(ticker);
  }, []);

  useEffect(() => {
    const unsubscribe = window.context.onDiagnosticEvent((event) => {      switch (event.type) {
        case "status":
          setStatus(event);
          pushLog(event.message);
          break;
        case "info":
          setInfo(event.info);
          break;
        case "dids":
          setDids(event.entries);
          break;
        case "flash":
          setFlash(event);
          if (event.phase === "error") pushLog(`ECU backup failed: ${event.message}`);
          break;
        case "dtc":
          setCodes(event.codes);
          break;
        case "live":
          setLive(event.values);
          setLastLiveAt(Date.now());
          setUpdates((n) => n + 1);
          setHistory((prev) => {
            const next: Partial<Record<keyof LiveValues, number[]>> = {};
            for (const gauge of GAUGES) {
              const samples = prev[gauge.key] ?? [];
              next[gauge.key] = [...samples, event.values[gauge.key]].slice(
                -HISTORY_LENGTH
              );
            }
            return next;
          });
          break;
        case "analysis":
          setAnalysis(event);
          break;
        case "deletions":
          setDeletions(event);
          break;
        case "mods":
          setMods(event);
          break;
        case "pull":
          setPulls((prev) => [...prev.slice(-3), event]);
          pushLog(`Dyno pull #${event.index} (${event.label}): ${event.peakPowerKw.toFixed(0)} kW · ${event.peakTorqueNm.toFixed(0)} Nm.`);
          break;
        case "verification":
          setVerification(event);
          pushLog(`Sign-off verification ${event.passed ? "PASSED" : "FAILED"}.`);
          break;
        case "log":
          pushLog(event.message);
          break;
        case "error":
          setStatus({
            type: "status",
            phase: "error",
            message: event.message,
            mode: "live",
          });
          pushLog(`Error: ${event.message}`);
          break;
      }
    });
    return unsubscribe;
  }, []);

  const running =
    busy || (status !== null && ACTIVE_PHASES.includes(status.phase));

  const simulated = status?.mode !== "live";
  const stale =
    running &&
    !busy &&
    lastLiveAt !== null &&
    nowTick - lastLiveAt > STALE_AFTER_MS;
  const secondsSinceUpdate =
    lastLiveAt === null ? null : Math.max(0, Math.round((nowTick - lastLiveAt) / 1000));
  const showFallbackBanner =
    status?.phase === "simulated" && liveRequested && !fallbackDismissed;

  const handleStart = async () => {
    setBusy(true);
    setLiveRequested(!simulate);
    setFallbackDismissed(false);
    try {
      const result = await window.context.startDiagnostic({ simulate });
      if (!result.started) pushLog(result.message);
    } catch (error) {
      console.error("Failed to start the diagnostic session:", error);
    } finally {
      setBusy(false);
    }
  };

  const handleRetryLive = async () => {
    setBusy(true);
    setLiveRequested(true);
    setFallbackDismissed(false);
    setSimulate(false);
    try {
      await window.context.startDiagnostic({ simulate: false });
    } catch (error) {
      console.error("Failed to retry live connection:", error);
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    try {
      await window.context.stopDiagnostic();
    } catch (error) {
      console.error("Failed to stop the diagnostic session:", error);
    } finally {
      setBusy(false);
    }
  };

  const handleClearCodes = async () => {
    try {
      const result = await window.context.sendDiagnosticCommand({
        cmd: "clear_dtc",
      });
      if (!result.ok) pushLog(result.message);
    } catch (error) {
      console.error("Failed to clear fault codes:", error);
    }
  };

  const handleDeleteComponent = async (componentId: string) => {
    try {
      const result = await window.context.sendDiagnosticCommand({
        cmd: "delete_component",
        componentId,
      });
      if (!result.ok) pushLog(result.message);
    } catch (error) {
      console.error("Failed to delete component:", error);
    }
  };

  const handleRestoreComponent = async (componentId: string) => {
    try {
      const result = await window.context.sendDiagnosticCommand({
        cmd: "restore_component",
        componentId,
      });
      if (!result.ok) pushLog(result.message);
    } catch (error) {
      console.error("Failed to restore component:", error);
    }
  };

  const handleApplyMod = async (modId: string) => {
    try {
      const result = await window.context.sendDiagnosticCommand({
        cmd: "apply_mod",
        modId,
      });
      if (!result.ok) pushLog(result.message);
    } catch (error) {
      console.error("Failed to apply mod:", error);
    }
  };

  const handleRevertMod = async (modId: string) => {
    try {
      const result = await window.context.sendDiagnosticCommand({
        cmd: "revert_mod",
        modId,
      });
      if (!result.ok) pushLog(result.message);
    } catch (error) {
      console.error("Failed to revert mod:", error);
    }
  };

  const handleRunPull = async () => {
    try {
      const result = await window.context.sendDiagnosticCommand({ cmd: "run_pull" });
      if (!result.ok) pushLog(result.message);
    } catch (error) {
      console.error("Failed to run dyno pull:", error);
    }
  };

  const handleVerify = async () => {
    try {
      const result = await window.context.sendDiagnosticCommand({
        cmd: "verify_changes",
        dutyProfile,
      });
      if (!result.ok) pushLog(result.message);
    } catch (error) {
      console.error("Failed to run verification:", error);
    }
  };

  const handleBackup = async () => {
    try {
      const result = await window.context.sendDiagnosticCommand({
        cmd: "read_ecu_backup",
      });
      if (!result.ok) pushLog(result.message);
    } catch (error) {
      console.error("Failed to start ECU backup:", error);
    }
  };

  const handleExportReport = () => {
    // Best practice: workshops and customers get a shareable artifact.
    if (typeof URL.createObjectURL !== "function") return;
    const report = {
      generatedAt: new Date().toISOString(),
      ecu: info,
      liveDidMap: dids,
      ecuBackup: flash
        ? { phase: flash.phase, bytes: flash.bytes ?? null, path: flash.path ?? null, sha256: flash.sha256 ?? null }
        : null,
      analysis,
      faultCodes: codes,
      appliedMods: mods?.active ?? [],
      codedOutComponents: deletions?.active ?? [],
      moduleScope: mods?.scope ?? null,
      dynoPulls: pulls.map((p) => ({
        index: p.index,
        label: p.label,
        peakPowerKw: p.peakPowerKw,
        peakTorqueNm: p.peakTorqueNm,
      })),
      signOffVerification: verification,
      liveSnapshot: live,
      trends: history,
      eventLog: log,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `vw-diagnostic-report-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    pushLog("Diagnostic report exported.");
  };

  return (
    <div className="container flex min-h-dvh flex-col gap-6 py-8">
      {/* update notice — renders only when a newer release exists */}
      <UpdateBanner />

      {/* header */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Activity className="size-8 text-chart-1" />
          <div>
            <h1 className="font-serif text-2xl font-bold tracking-tight">
              VW Diagnostic Dashboard
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              J2534 pass-thru monitor spawned from the main process (
              <code className="rounded bg-muted px-1">
                resources/j2534_monitor.py
              </code>
              )
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {isDemoMode() && (
            <Badge variant="outline" className="text-muted-foreground">
              Browser demo · simulated
            </Badge>
          )}
          {isBrowserLive() && (
            <Badge variant="outline" className="border-chart-2/50 text-chart-2">
              Live Python monitor
            </Badge>
          )}
          <StatusBadge status={status} />
          <label className="flex cursor-pointer select-none items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Simulation mode"
              checked={simulate}
              onChange={(event) => setSimulate(event.target.checked)}
              className="size-4 accent-primary"
            />
            Simulation mode
          </label>
          <Button onClick={handleStart} disabled={running || busy}>
            <Play className="fill-current" />
            Start Session
          </Button>
          <Button
            variant="outline"
            onClick={handleStop}
            disabled={!running || busy}
          >
            <Square className="fill-current" />
            Stop
          </Button>
          <Button
            variant="outline"
            onClick={handleExportReport}
            disabled={!info && !analysis}
            aria-label="Export diagnostic report"
            title="Export session report (JSON)"
          >
            <Download />
            Report
          </Button>
        </div>
      </header>

      {/* error banner */}
      {status?.phase === "error" && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="flex items-center gap-3 p-4">
            <AlertTriangle className="size-5 shrink-0 text-destructive" />
            <p className="text-sm text-destructive">{status.message}</p>
          </CardContent>
        </Card>
      )}

      {/* live→simulation fallback acknowledgment */}
      {showFallbackBanner && (
        <Card className="border-chart-4/50 bg-chart-4/10">
          <CardContent className="flex flex-wrap items-center gap-3 p-4">
            <AlertTriangle className="size-5 shrink-0 text-chart-4" />
            <p className="flex-1 text-sm">
              You requested a LIVE connection — running SIMULATION instead:{" "}
              {status?.message}
            </p>
            <Button size="sm" variant="outline" className="h-8" onClick={handleRetryLive}>
              <RotateCcw className="size-3.5" />
              Retry live
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0"
              aria-label="Dismiss simulation notice"
              onClick={() => setFallbackDismissed(true)}
            >
              <X className="size-4" />
            </Button>
          </CardContent>
        </Card>
      )}

      {/* stale-data watchdog */}
      {stale && (
        <Card className="border-chart-4/50">
          <CardContent className="flex items-center gap-3 p-4">
            <AlertTriangle className="size-5 shrink-0 text-chart-4" />
            <p className="text-sm">
              Data stale — last live update{" "}
              <span className="font-semibold tabular-nums">
                {secondsSinceUpdate}s ago
              </span>
              . Values below are frozen, not current. Check the monitor
              process or stop the session.
            </p>
          </CardContent>
        </Card>
      )}

      {/* instrument-cluster tell-tales */}
      <WarningLights codes={codes} live={live} />

      {/* AI assistant + ECU identification */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <AssistantCard analysis={analysis} />
        </div>
        {info ? (
          <EcuInfoCard
            info={info}
            dids={dids}
            flash={flash}
            running={running}
            onBackup={handleBackup}
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>ECU Identification</CardTitle>
              <CardDescription>
                Appears once a session connects to an ECU (real or simulated)
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="h-5 w-48 animate-pulse rounded-md bg-muted" />
              <div className="h-4 w-full animate-pulse rounded-md bg-muted" />
              <div className="h-4 w-3/4 animate-pulse rounded-md bg-muted" />
            </CardContent>
          </Card>
        )}
      </div>

      {/* session state + safety scope */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Session
              {running && live && (
                <span className="relative flex size-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-chart-2 opacity-75" />
                  <span className="relative inline-flex size-2.5 rounded-full bg-chart-2" />
                </span>
              )}
            </CardTitle>
            <CardDescription>Monitor process connection state</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Mode:</span>
              {status?.mode === "live" ? (
                <Badge>Live J2534</Badge>
              ) : (
                <Badge variant="secondary">Simulation</Badge>
              )}
            </div>
            <p className="min-h-5 flex-1 text-sm">
              {status?.message ?? "No session started yet."}
            </p>
            <p className="text-xs tabular-nums text-muted-foreground">
              {updates.toLocaleString()} live updates
              {secondsSinceUpdate !== null && running
                ? ` · last ${secondsSinceUpdate}s ago${stale ? " (STALE)" : ""}`
                : ""}
            </p>
            <select
              aria-label="Duty profile"
              value={dutyProfile}
              onChange={(event) => setDutyProfile(event.target.value as DutyProfile)}
              className="h-7 rounded-md border border-input bg-background px-2 text-xs"
              title="How the truck is used — tunes verification scrutiny, never the safety ceilings"
            >
              <option value="standard">Duty: standard (tow)</option>
              <option value="no_tow">Duty: no-tow</option>
            </select>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={!running}
              onClick={handleVerify}
            >
              Verify & Sign Off
            </Button>
          </CardContent>
        </Card>
        <ScopeCard mods={mods} />
      </div>

      {/* sign-off verification result */}
      {verification && <VerificationCard verification={verification} />}

      {/* live data */}
      <Card className={simulated ? "border-amber-500/40" : undefined}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Live Data
            {simulated && running && (
              <Badge variant="outline" className="border-amber-500/50 text-[10px] text-amber-600">
                simulated data
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Streaming measuring values (UDS 0x22) with rolling trends —
            intermittent faults show up in the history, not the instant value
          </CardDescription>
        </CardHeader>
        <CardContent className={stale ? "opacity-40 grayscale transition-all" : "transition-all"}>
          {live === null ? (
            <div className="grid grid-cols-3 gap-6 sm:grid-cols-5">
              {GAUGES.map((gauge) => (
                <div
                  key={gauge.key}
                  className="mx-auto h-24 w-24 animate-pulse rounded-full bg-muted"
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-6 sm:grid-cols-5">
              {GAUGES.map((gauge) => (
                <Gauge
                  key={gauge.key}
                  label={gauge.label}
                  value={live[gauge.key]}
                  unit={gauge.unit}
                  min={gauge.min}
                  max={gauge.max}
                  decimals={gauge.decimals}
                  warnAt={gauge.warnAt}
                  dangerAt={gauge.dangerAt}
                  history={history[gauge.key]}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* trend chart */}
      <StripChart
        channels={GAUGES.map(({ key, label, unit, decimals = 0 }) => ({
          key,
          label,
          unit,
          decimals,
        }))}
        selected={selectedChannel}
        onSelect={setSelectedChannel}
        history={history}
        running={running}
      />

      {/* performance graphs */}
      <PullChart pulls={pulls} running={running} onRunPull={handleRunPull} />

      {/* fault codes */}
      <DtcTable codes={codes} running={running} onClear={handleClearCodes} />

      {/* performance mods */}
      <ModsPanel
        mods={mods}
        running={running}
        onApply={handleApplyMod}
        onRevert={handleRevertMod}
      />

      {/* component deletion */}
      <DeletionPanel
        deletions={deletions}
        running={running}
        onDelete={handleDeleteComponent}
        onRestore={handleRestoreComponent}
      />

      {/* event log */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Terminal className="size-4 text-muted-foreground" />
            Event Log
          </CardTitle>
        </CardHeader>
        <CardContent>
          {log.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Session events will appear here.
            </p>
          ) : (
            <ul className="space-y-1 font-mono text-xs text-muted-foreground">
              {log.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default App;
