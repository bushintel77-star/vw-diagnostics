import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Cable,
  Download,
  Play,
  Square,
  Terminal,
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
import DeletionPanel from "@/components/dashboard/DeletionPanel";
import ModsPanel, { ScopeCard } from "@/components/dashboard/ModsPanel";
import UpdateBanner from "@/components/dashboard/UpdateBanner";
import UpdateGate from "@/components/dashboard/UpdateGate";
import VersionBadge from "@/components/dashboard/VersionBadge";
import ConnectionProgress from "@/components/dashboard/ConnectionProgress";
import KeyNumbers, { KeyChannel, SessionStats, foldStats } from "@/components/dashboard/KeyNumbers";
import RaceModeToggle from "@/components/dashboard/RaceModeToggle";
import StatusBar from "@/components/dashboard/StatusBar";
import { Skeleton } from "@/components/ui/skeleton";
import VerificationCard from "@/components/dashboard/VerificationCard";
import WarningLights from "@/components/dashboard/WarningLights";
import WorkflowGuide from "@/components/dashboard/WorkflowGuide";
import CableSetupWizard from "@/components/setup/CableSetupWizard";
import CableStatusChip from "@/components/setup/CableStatusChip";
import { useCableSetup } from "@/components/setup/useCableSetup";
import { isBrowserLive } from "@/web/liveBridge";
import {
  DiagnosticAnalysisEvent,
  DiagnosticDeletionsEvent,
  DiagnosticFlashEvent,
  DiagnosticModsEvent,
  DiagnosticPhase,
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

// The six numbers that lead the screen (telemetry hierarchy); the full
// gauge set stays below.
const KEY_CHANNELS: KeyChannel[] = (
  ["rpm", "boostPressureKpa", "railPressureBar", "coolantTempC", "engineLoadPct", "batteryV"] as const
).map((key) => GAUGES.find((gauge) => gauge.key === key)!);
const KEY_KEYS = KEY_CHANNELS.map((channel) => channel.key);
const RATE_WINDOW_MS = 5000;

const HISTORY_LENGTH = 120; // ~60 s at 2 samples/s
const STALE_AFTER_MS = 4000; // no live event for this long while running = stale

const ACTIVE_PHASES: DiagnosticPhase[] = [
  "starting",
  "connecting",
  "connected",
];

const StatusBadge = ({ status }: { status: DiagnosticStatusEvent | null }) => {
  if (!status) return <Badge variant="outline">Not connected</Badge>;
  switch (status.phase) {
    case "connected":
      return <Badge>Connected</Badge>;
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
  const [status, setStatus] = useState<DiagnosticStatusEvent | null>(null);
  const [info, setInfo] = useState<EcuInfo | null>(null);
  const [dids, setDids] = useState<DidMapEntry[] | null>(null);
  const [flash, setFlash] = useState<DiagnosticFlashEvent | null>(null);
  // null = never read this session (no data to report); [] = the ECU was
  // actually read and reported zero faults — a genuine clean result.
  const [codes, setCodes] = useState<DtcCode[] | null>(null);
  const [live, setLive] = useState<LiveValues | null>(null);
  const [analysis, setAnalysis] = useState<DiagnosticAnalysisEvent | null>(null);
  const [deletions, setDeletions] = useState<DiagnosticDeletionsEvent | null>(null);
  const [mods, setMods] = useState<DiagnosticModsEvent | null>(null);
  const [history, setHistory] = useState<Partial<Record<keyof LiveValues, number[]>>>({});
  const [selectedChannel, setSelectedChannel] = useState<keyof LiveValues>("rpm");
  const [updates, setUpdates] = useState<number>(0);
  const [log, setLog] = useState<{ id: number; text: string }[]>([]);
  const logId = useRef(0);
  const [busy, setBusy] = useState<boolean>(false);
  const [verification, setVerification] = useState<DiagnosticVerificationEvent | null>(null);
  const [lastLiveAt, setLastLiveAt] = useState<number | null>(null);
  const [sessionStats, setSessionStats] = useState<SessionStats>({});
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const liveTimes = useRef<number[]>([]);
  const [nowTick, setNowTick] = useState<number>(Date.now());
  const [dutyProfile, setDutyProfile] = useState<DutyProfile>("standard");

  const pushLog = (text: string): void => {
    // A counter id, not the text: the same message can repeat in one second.
    const entry = { id: ++logId.current, text: `${new Date().toLocaleTimeString()}  ${text}` };
    setLog((prev) => [entry, ...prev].slice(0, 10));
  };

  useEffect(() => {
    // 1 Hz heartbeat so the stale-data watchdog re-renders.
    const ticker = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(ticker);
  }, []);

  useEffect(() => {
    const unsubscribe = window.context.onDiagnosticEvent((event) => {
      switch (event.type) {
        case "status":
          setStatus(event);
          pushLog(event.message);
          if (event.phase === "connected") setConnectedAt((at) => at ?? Date.now());
          if (["starting", "disconnected", "error"].includes(event.phase)) {
            // Session data ends with the session — a stale "clean" read or
            // frozen gauge must not persist as if it were current state.
            setCodes(null);
            setLive(null);
            setHistory({});
            setSessionStats({});
            setConnectedAt(null);
            liveTimes.current = [];
            setLastLiveAt(null);
            setUpdates(0);
            setInfo(null);
            setDids(null);
            setAnalysis(null);
            setVerification(null);
            setFlash(null);
            setDeletions(null);
            setMods(null);
          }
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
          setSessionStats((prev) => foldStats(prev, event.values, KEY_KEYS));
          liveTimes.current = [...liveTimes.current, Date.now()].filter(
            (at) => Date.now() - at <= RATE_WINDOW_MS
          );
          setHistory((prev) => {
            const next: Partial<Record<keyof LiveValues, number[]>> = {};
            for (const gauge of GAUGES) {
              const samples = prev[gauge.key] ?? [];
              const value = event.values[gauge.key];
              // A null channel is absence of data — it is not appended to
              // the rolling history as if it were a reading.
              next[gauge.key] = value == null || !Number.isFinite(value)
                ? samples
                : [...samples, value].slice(-HISTORY_LENGTH);
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
        case "verification":
          setVerification(event);
          pushLog(
            `Post-flash health check ${
              { pass: "PASSED", fail: "FAILED", inconclusive: "NOT VERIFIED" }[
                event.verdict
              ]
            }.`
          );
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
          setCodes(null);
          setLive(null);
          setHistory({});
          setSessionStats({});
          setConnectedAt(null);
          liveTimes.current = [];
          setLastLiveAt(null);
          setUpdates(0);
          setInfo(null);
          setDids(null);
          setAnalysis(null);
          setVerification(null);
          setFlash(null);
          pushLog(`Error: ${event.message}`);
          break;
      }
    });
    return unsubscribe;
  }, []);

  const running =
    busy || (status !== null && ACTIVE_PHASES.includes(status.phase));

  // Plug-and-play cable setup: polls while idle, opens itself on problems.
  const cableSetup = useCableSetup({ sessionActive: running });
  // A newer Tactrix driver can reflash (brick) a clone: no session until the
  // safe version is back. The main process enforces this too.
  const driverTooNew =
    cableSetup.status?.driverInstalled === true &&
    cableSetup.status.driverVersionState === "newer";

  const stale =
    running &&
    !busy &&
    lastLiveAt !== null &&
    nowTick - lastLiveAt > STALE_AFTER_MS;
  const secondsSinceUpdate =
    lastLiveAt === null ? null : Math.max(0, Math.round((nowTick - lastLiveAt) / 1000));
  // Real samples per second over the last few seconds; null when not live.
  const sampleHz =
    running && live !== null
      ? liveTimes.current.filter((at) => nowTick - at <= RATE_WINDOW_MS).length / (RATE_WINDOW_MS / 1000)
      : null;
  const sessionSeconds =
    running && connectedAt !== null ? Math.max(0, Math.floor((nowTick - connectedAt) / 1000)) : null;
  const handleStart = async () => {
    setBusy(true);
    try {
      const result = await window.context.startDiagnostic();
      if (!result.started) {
        pushLog(result.message);
        setStatus({ type: "status", phase: "error", mode: "live", message: result.message });
      }
    } catch (error) {
      setStatus({ type: "status", phase: "error", mode: "live", message: `Cannot start session: ${String(error)}` });
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
      postFlashHealthCheck: verification,
      liveSnapshot: live,
      trends: history,
      eventLog: log.map((entry) => entry.text),
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
      {/* kill-switch gate — renders only when the remote floor retires this version */}
      <UpdateGate />
      {/* update notice — renders only when a newer release exists */}
      <UpdateBanner />
      {/* draggable getting-started sticky — persisted open/closed + position */}
      <WorkflowGuide />
      {/* guided cable setup — self-checks, passkey-gated driver, live detection */}
      <CableSetupWizard
        controller={cableSetup}
        sessionActive={running}
        onStartSession={() => {
          cableSetup.closeWizard();
          void handleStart();
        }}
      />

      {/* header */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Activity className="size-8 text-chart-1" />
          <div>
            <h1 className="flex flex-wrap items-center gap-2 font-serif text-2xl font-bold tracking-tight">
              VW Diagnostic Dashboard
              <VersionBadge />
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
          <CableStatusChip
            status={cableSetup.status}
            justConnected={cableSetup.justConnected}
            onOpen={cableSetup.openWizard}
          />
          {isBrowserLive() && (
            <Badge variant="outline" className="border-chart-2/50 text-chart-2">
              Live Python monitor
            </Badge>
          )}
          <RaceModeToggle />
          <StatusBadge status={status} />
          <Button
            onClick={handleStart}
            disabled={running || busy || driverTooNew}
            title={driverTooNew ? "Blocked: a newer Tactrix driver could brick the cable. Open Cable setup." : undefined}
          >
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

      {/* one main landmark: screen-reader users can jump straight here */}
      <main className="flex flex-col gap-6">

      {/* session context strip: link, ECU, bus, sample rate, clock, data age */}
      <StatusBar
        status={status}
        info={info}
        sampleHz={sampleHz}
        sessionSeconds={sessionSeconds}
        dataAgeSeconds={running ? secondsSinceUpdate : null}
        stale={stale}
      />

      {/* error banner */}
      {status?.phase === "error" && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="flex items-center gap-3 p-4">
            <AlertTriangle className="size-5 shrink-0 text-destructive" />
            <p className="text-sm text-destructive">{status.message}</p>
          </CardContent>
        </Card>
      )}

      {/* connecting — each step advances on a real monitor event */}
      {running && live === null && status?.phase !== "error" && (
        <ConnectionProgress
          phase={status?.phase ?? null}
          hasInfo={info !== null}
          hasDids={dids !== null}
          hasLive={false}
        />
      )}

      {/* no interface attached — what the user needs to do */}
      {!running && (status === null || status.phase === "disconnected") && (
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Cable className="size-5 shrink-0 text-muted-foreground" />
            {cableSetup.status?.cable === "ready" ? (
              <p className="flex-1 text-sm text-muted-foreground">
                Cable ready — plug it into the truck's OBD port, turn the
                ignition on, then Start Session.
              </p>
            ) : (
              <p className="flex-1 text-sm text-muted-foreground">
                No interface connected — attach a J2534 pass-thru device,
                use its existing compatible driver and a matching Python interpreter,
                then Start Session to connect to the vehicle. The Python wrapper is included.
              </p>
            )}
            {cableSetup.status?.platformSupported && cableSetup.status.cable !== "ready" && (
              <Button variant="outline" size="sm" className="shrink-0 rounded-full" onClick={cableSetup.openWizard}>
                Set up cable
              </Button>
            )}
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

      {/* the numbers that matter, biggest first */}
      <KeyNumbers channels={KEY_CHANNELS} live={live} stats={sessionStats} stale={stale} />

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
                Appears once a session connects to an ECU
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {running ? (
                <>
                  <Skeleton className="h-5 w-48" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No ECU data — connect a J2534 interface and start a session.
                </p>
              )}
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
              <span className="text-sm text-muted-foreground">Interface:</span>
              {status && status.phase !== "error" ? (
                <Badge>Live J2534</Badge>
              ) : (
                <Badge variant="outline">Not connected</Badge>
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
              Run health check
            </Button>
          </CardContent>
        </Card>
        <ScopeCard mods={mods} />
      </div>

      {/* post-flash health check result */}
      {verification && <VerificationCard verification={verification} />}

      {/* live data */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">Live Data</CardTitle>
          <CardDescription>
            Streaming measuring values (UDS 0x22) with rolling trends —
            intermittent faults show up in the history, not the instant value
          </CardDescription>
        </CardHeader>
        {/* stale: greyed but readable; the stale banner above says why */}
        <CardContent className={stale ? "grayscale transition-all" : "transition-all"}>
          {live === null ? (
            running ? (
              <div className="grid grid-cols-3 gap-6 sm:grid-cols-5">
                {GAUGES.map((gauge) => (
                  <Skeleton key={gauge.key} className="mx-auto h-24 w-24 rounded-full" />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No data — not connected. Start a session with a J2534
                interface attached to stream live values from the ECU.
              </p>
            )
          ) : (
            <div className="grid grid-cols-3 gap-6 animate-fade-up sm:grid-cols-5 motion-reduce:animate-none">
              {GAUGES.map((gauge) => (
                <Gauge
                  key={gauge.key}
                  label={gauge.label}
                  value={live[gauge.key] ?? null}
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
                <li key={entry.id}>{entry.text}</li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      </main>
    </div>
  );
};

export default App;
