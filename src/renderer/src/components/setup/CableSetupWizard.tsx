import { FormEvent, KeyboardEvent, ReactNode, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Ban,
  Cable,
  Car,
  CheckCircle2,
  CircleDashed,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  ShieldAlert,
  Usb,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils";
import { CableSetupStatus } from "@shared/types";
import {
  Blocker,
  CheckItem,
  CheckState,
  STEPS,
  StepState,
  currentStep,
  deriveChecks,
  findBlocker,
  stepStates,
} from "./setupFlow";
import { CableSetupController } from "./useCableSetup";

/**
 * Cable setup wizard: guided, plug-and-play. Self-checks run on open and
 * keep polling; the step follows live status, so plugging the cable in or
 * finishing the installer moves you on without a click. The driver install
 * is passkey-gated and only ever launches the pinned 1004341 package. No
 * control here changes Windows security settings.
 */

interface WizardProps {
  controller: CableSetupController;
  sessionActive: boolean;
  onStartSession: () => void;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

export default function CableSetupWizard({
  controller,
  sessionActive,
  onStartSession,
}: WizardProps): React.JSX.Element | null {
  const { status, checking, open, closeWizard, recheck } = controller;
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus moves in on open and back to where it was on close.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    (node?.querySelector<HTMLElement>("[data-autofocus]") ?? node)?.focus();
    return () => previous?.focus?.();
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeWizard();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const step = currentStep(status);
  const blocker = findBlocker(status);
  const complete = status !== null && step === "ready" && blocker === null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-background/50 p-4 backdrop-blur-sm animate-in fade-in duration-200 motion-reduce:animate-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cable-setup-title"
        aria-describedby="cable-setup-desc"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative flex max-h-[calc(100dvh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-border/60 bg-card/85 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.45)] outline-none backdrop-blur-2xl animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-300 motion-reduce:animate-none"
      >
        {/* ambient accent: hairline + soft glow */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-chart-1/70 to-transparent" />
        <div aria-hidden className="pointer-events-none absolute -top-28 left-1/2 h-56 w-[28rem] -translate-x-1/2 rounded-full bg-chart-1/15 blur-3xl" />

        <header className="relative flex items-start gap-3 px-6 pb-4 pt-6">
          <div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-chart-1/15 text-chart-1">
            <Cable className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="cable-setup-title" className="font-serif text-xl font-bold tracking-tight">
              Cable setup
            </h2>
            <p id="cable-setup-desc" className="text-sm text-muted-foreground">
              Checks this computer, installs the driver if needed and watches for your cable. Nothing on the truck is touched.
            </p>
          </div>
          <Button variant="ghost" size="icon" className="size-8 shrink-0 rounded-full" aria-label="Close cable setup" onClick={closeWizard}>
            <X className="size-4" />
          </Button>
        </header>

        <div className="relative space-y-5 overflow-y-auto px-6 pb-2">
          <Stepper states={stepStates(status)} />
          <ChecksGrid checks={deriveChecks(status)} />
          <p aria-live="polite" className="sr-only">
            {announcement(status, blocker, complete)}
          </p>
          <section aria-label="Current step" className="pb-2">
            {blocker ? (
              <BlockerCard blocker={blocker} />
            ) : step === "check" ? (
              <LiveLine>Checking this computer…</LiveLine>
            ) : step === "driver" && status ? (
              <DriverPanel status={status} onInstalled={recheck} />
            ) : step === "plug" && status ? (
              <PlugPanel status={status} />
            ) : (
              <ReadyPanel sessionActive={sessionActive} />
            )}
          </section>
          <TechnicalDetails status={status} />
        </div>

        <footer className="relative flex flex-wrap items-center gap-2 border-t border-border/60 bg-background/40 px-6 py-3">
          <Button variant="ghost" size="sm" className="rounded-full" onClick={recheck} disabled={checking}>
            <RefreshCw className={cn("size-4", checking && "animate-spin motion-reduce:animate-none")} />
            {checking ? "Checking…" : "Check again"}
          </Button>
          {!sessionActive && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-chart-2 opacity-60 motion-reduce:animate-none" />
                <span className="relative inline-flex size-2 rounded-full bg-chart-2" />
              </span>
              Live
            </span>
          )}
          <span className="flex-1" />
          {complete && !sessionActive ? (
            <>
              <Button variant="outline" className="rounded-full" onClick={closeWizard}>
                Done
              </Button>
              <Button className="rounded-full" onClick={onStartSession}>
                <Play className="fill-current" />
                Start session
              </Button>
            </>
          ) : (
            <Button variant="outline" className="rounded-full" onClick={closeWizard}>
              {complete ? "Done" : "Finish later"}
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}

function announcement(status: CableSetupStatus | null, blocker: Blocker | null, complete: boolean): string {
  if (!status) return "Checking this computer.";
  if (blocker) return blocker.title;
  if (complete) return "Your cable is ready.";
  const step = currentStep(status);
  if (step === "driver") return "The cable driver needs installing.";
  if (step === "plug") return "Waiting for you to plug in the cable.";
  return "";
}

// --- progress -----------------------------------------------------------------

const BAR: Record<StepState, string> = {
  done: "bg-chart-2",
  current: "bg-primary/70 animate-pulse motion-reduce:animate-none",
  blocked: "bg-destructive",
  todo: "bg-muted",
};

const STEP_STATE_TEXT: Record<StepState, string> = {
  done: "complete",
  current: "in progress",
  blocked: "needs attention",
  todo: "not started",
};

function Stepper({ states }: { states: Record<string, StepState> }): React.JSX.Element {
  return (
    <ol aria-label="Setup progress" className="grid grid-cols-4 gap-2">
      {STEPS.map((step, index) => {
        const state = states[step.id];
        return (
          <li key={step.id} aria-current={state === "current" || state === "blocked" ? "step" : undefined} className="space-y-1.5">
            <div className={cn("h-1.5 rounded-full transition-colors duration-500", BAR[state])} />
            <div className="flex items-center gap-1.5 text-xs">
              <span
                aria-hidden
                className={cn(
                  "grid size-4 place-items-center rounded-full text-[10px] font-semibold",
                  state === "done" && "bg-chart-2 text-background",
                  state === "blocked" && "bg-destructive text-destructive-foreground",
                  state === "current" && "bg-primary text-primary-foreground",
                  state === "todo" && "bg-muted text-muted-foreground"
                )}
              >
                {state === "done" ? "✓" : state === "blocked" ? "!" : index + 1}
              </span>
              <span className={cn(state === "todo" ? "text-muted-foreground" : "font-medium")}>{step.label}</span>
              <span className="sr-only">, {STEP_STATE_TEXT[state]}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// --- self-checks (bento grid) -------------------------------------------------

const CHECK_ICON: Record<CheckState, ReactNode> = {
  pass: <CheckCircle2 className="size-4 text-chart-2" />,
  warn: <AlertTriangle className="size-4 text-chart-4" />,
  fail: <XCircle className="size-4 text-destructive" />,
  waiting: <CircleDashed className="size-4 animate-spin-slow text-muted-foreground motion-reduce:animate-none" />,
  pending: <Loader2 className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />,
  later: <CircleDashed className="size-4 text-muted-foreground/60" />,
};

const CHECK_STATE_TEXT: Record<CheckState, string> = {
  pass: "passed",
  warn: "warning",
  fail: "needs attention",
  waiting: "waiting",
  pending: "checking",
  later: "not yet",
};

function ChecksGrid({ checks }: { checks: CheckItem[] }): React.JSX.Element {
  return (
    <ul aria-label="Self-checks" className="grid grid-cols-2 gap-2">
      {checks.map((check) => (
        <li
          key={check.id}
          className={cn(
            "flex items-start gap-2.5 rounded-2xl border bg-background/40 p-3 transition-colors duration-300",
            check.state === "fail" ? "border-destructive/40" : check.state === "warn" ? "border-chart-4/40" : "border-border/60"
          )}
        >
          <span className="mt-0.5 shrink-0">{CHECK_ICON[check.state]}</span>
          <span className="min-w-0">
            <span className="block text-xs font-semibold">
              {check.label}
              <span className="sr-only">: {CHECK_STATE_TEXT[check.state]}.</span>
            </span>
            <span className="block text-xs text-muted-foreground">{check.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// --- step panels ----------------------------------------------------------------

function LiveLine({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
      {children}
    </p>
  );
}

function PanelTitle({ icon, children }: { icon: ReactNode; children: ReactNode }): React.JSX.Element {
  return (
    <h3 className="mb-2 flex items-center gap-2 text-base font-semibold">
      <span className="text-chart-1">{icon}</span>
      {children}
    </h3>
  );
}

function Steps({ items }: { items: ReactNode[] }): React.JSX.Element {
  return (
    <ol className="mb-3 space-y-1.5 text-sm">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2.5">
          <span aria-hidden className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold">
            {index + 1}
          </span>
          <span className="leading-relaxed">{item}</span>
        </li>
      ))}
    </ol>
  );
}

function Caution({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <p className="flex gap-2 rounded-xl border border-chart-4/40 bg-chart-4/10 p-3 text-xs leading-relaxed">
      <Ban className="mt-px size-4 shrink-0 text-chart-4" />
      <span>{children}</span>
    </p>
  );
}

function BlockerCard({ blocker }: { blocker: Blocker }): React.JSX.Element {
  return (
    <div className="space-y-3 rounded-2xl border border-destructive/40 bg-destructive/10 p-4">
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <ShieldAlert className="size-5 shrink-0 text-destructive" />
        {blocker.title}
      </h3>
      <p className="text-sm leading-relaxed">{blocker.body}</p>
      {blocker.steps.length > 0 && (
        <div>
          <p className="mb-1.5 text-sm font-medium">What you can do</p>
          <Steps items={blocker.steps} />
        </div>
      )}
      {blocker.caution && <Caution>{blocker.caution}</Caution>}
    </div>
  );
}

function PlugPanel({ status }: { status: CableSetupStatus }): React.JSX.Element {
  return (
    <div>
      <PanelTitle icon={<Usb className="size-5" />}>Plug your cable into this computer</PanelTitle>
      <Steps
        items={[
          "Plug the USB end straight into the computer, not through a hub.",
          "Leave the truck end unplugged for now.",
          "The light on the cable should cycle through colours.",
        ]}
      />
      {status.cable === "unknown" ? (
        <p className="text-sm text-muted-foreground">
          Device Manager didn't answer. Plug the cable in, then choose Check again.
        </p>
      ) : (
        <LiveLine>Watching for your cable…</LiveLine>
      )}
    </div>
  );
}

function ReadyPanel({ sessionActive }: { sessionActive: boolean }): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-2xl border border-chart-2/40 bg-chart-2/10 p-4 animate-in fade-in zoom-in-95 duration-300 motion-reduce:animate-none">
        <CheckCircle2 className="size-8 shrink-0 text-chart-2" />
        <div>
          <h3 className="text-base font-semibold">Your cable is ready</h3>
          <p className="text-sm text-muted-foreground">
            {sessionActive ? "A session is already running." : "Windows sees it and the driver is working."}
          </p>
        </div>
      </div>
      {!sessionActive && (
        <div>
          <PanelTitle icon={<Car className="size-5" />}>At the truck</PanelTitle>
          <Steps
            items={[
              "Plug the cable into the OBD port under the dash.",
              "Turn the ignition on. The engine can stay off.",
              "Choose Start session.",
            ]}
          />
        </div>
      )}
    </div>
  );
}

// --- driver step ------------------------------------------------------------------

type InstallPhase = "passkey" | "installing" | "retry" | "installed";

function DriverPanel({ status, onInstalled }: { status: CableSetupStatus; onInstalled: () => void }): React.JSX.Element {
  const intro =
    status.driverInstalled && status.cable === "no_driver" ? (
      <p className="mb-3 text-sm text-muted-foreground">
        Your cable is plugged in, but Windows didn't attach its driver (Code 28). Unplug the cable, install the driver again, then plug it back in.
      </p>
    ) : null;
  return status.driverBundled ? (
    <BundledDriver status={status} intro={intro} onInstalled={onInstalled} />
  ) : (
    <div>
      <PanelTitle icon={<KeyRound className="size-5" />}>Install the driver that came with your cable</PanelTitle>
      {intro}
      <Steps
        items={[
          <>
            Run <code className="rounded bg-muted px-1 text-xs">openport2_setup_1004341.exe</code> (version 1.01.4341).
          </>,
          "Choose Yes on the Windows prompt, then Next, Install and Finish.",
          "Come back here. This screen updates by itself.",
        ]}
      />
      <Caution>
        Don't install newer Tactrix software, EcuFlash or firmware updaters. They can permanently break clone cables.
      </Caution>
      <div className="mt-3">
        <LiveLine>Watching for the driver…</LiveLine>
      </div>
    </div>
  );
}

function BundledDriver({
  status,
  intro,
  onInstalled,
}: {
  status: CableSetupStatus;
  intro: ReactNode;
  onInstalled: () => void;
}): React.JSX.Element {
  const [phase, setPhase] = useState<InstallPhase>("passkey");
  const [notice, setNotice] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(status.unlocked);

  const install = async (): Promise<void> => {
    setPhase("installing");
    setNotice(null);
    const result = await window.context.installDriver();
    if (result.ok) {
      // A fresh install moves the flow on by itself; a reinstall over a
      // Code 28 cable only takes effect once the cable re-enumerates.
      setPhase("installed");
      onInstalled();
      return;
    }
    if (result.reason === "not_unlocked") {
      setUnlocked(false);
      setPhase("passkey");
      setNotice("For safety, enter the passkey again.");
      return;
    }
    setPhase("retry");
    setNotice(
      result.reason === "declined"
        ? "You chose No on the Windows prompt or cancelled the installer, so nothing changed."
        : result.message
    );
  };

  if (phase === "installing") {
    return (
      <div>
        <PanelTitle icon={<KeyRound className="size-5" />}>Finish the installer</PanelTitle>
        <Steps
          items={[
            "Windows asks whether to allow changes to your device. Choose Yes.",
            "In OpenPort setup, choose Next, then Install, then Finish.",
            "If anything offers newer software or a firmware update, skip it.",
          ]}
        />
        <LiveLine>Waiting for the installer to finish…</LiveLine>
      </div>
    );
  }

  if (phase === "installed") {
    return (
      <div>
        <PanelTitle icon={<CheckCircle2 className="size-5" />}>Driver installed</PanelTitle>
        <p className="mb-3 text-sm text-muted-foreground">
          If your cable is plugged in, unplug it and plug it back in so Windows picks up the driver.
        </p>
        <LiveLine>Watching for your cable…</LiveLine>
      </div>
    );
  }

  return (
    <div>
      <PanelTitle icon={<KeyRound className="size-5" />}>Install the cable driver</PanelTitle>
      {intro}
      {notice && (
        <p role="alert" className="mb-3 flex gap-2 rounded-xl border border-chart-4/40 bg-chart-4/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-chart-4" />
          {notice}
        </p>
      )}
      {unlocked ? (
        <Button data-autofocus className="rounded-full" onClick={() => void install()}>
          {phase === "retry" ? "Try again" : "Install driver"}
        </Button>
      ) : (
        <PasskeyForm
          initialLockSeconds={status.lockedForSeconds}
          onUnlocked={() => {
            setUnlocked(true);
            void install();
          }}
        />
      )}
    </div>
  );
}

function PasskeyForm({
  initialLockSeconds,
  onUnlocked,
}: {
  initialLockSeconds: number;
  onUnlocked: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capsLock, setCapsLock] = useState(false);
  const [lockLeft, setLockLeft] = useState(initialLockSeconds);
  const inputRef = useRef<HTMLInputElement>(null);

  // Lockout countdown; the field re-enables itself at zero.
  useEffect(() => {
    if (lockLeft <= 0) return;
    const timer = window.setTimeout(() => setLockLeft((seconds) => seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [lockLeft]);

  useEffect(() => {
    if (lockLeft === 0) inputRef.current?.focus();
  }, [lockLeft]);

  const locked = lockLeft > 0;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!value || busy || locked) return;
    setBusy(true);
    setError(null);
    const result = await window.context.unlockDriver(value);
    setBusy(false);
    setValue("");
    if (result.ok) {
      onUnlocked();
      return;
    }
    if (result.reason === "locked") {
      setLockLeft(result.lockedForSeconds ?? 60);
      setError("Too many wrong tries. The passkey field unlocks when the timer ends.");
    } else if (result.reason === "bad_passkey") {
      const left = result.attemptsLeft ?? 0;
      setError(`That passkey isn't right. ${left} ${left === 1 ? "try" : "tries"} left before a short lockout.`);
      inputRef.current?.focus();
    } else {
      setError(result.message);
    }
  };

  const describedBy = ["passkey-help", error ? "passkey-error" : null, capsLock ? "passkey-caps" : null]
    .filter(Boolean)
    .join(" ");

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-2" noValidate>
      <label htmlFor="cable-passkey" className="text-sm font-medium">
        Passkey
      </label>
      <div className="relative">
        <input
          ref={inputRef}
          id="cable-passkey"
          data-autofocus
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyUp={(event) => setCapsLock(event.getModifierState("CapsLock"))}
          autoComplete="off"
          spellCheck={false}
          disabled={locked || busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            "h-11 w-full rounded-full border bg-background/70 pl-4 pr-12 text-sm outline-none ring-offset-background transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50",
            error ? "border-destructive" : "border-input"
          )}
        />
        <button
          type="button"
          aria-label={visible ? "Hide passkey" : "Show passkey"}
          aria-pressed={visible}
          onClick={() => setVisible((shown) => !shown)}
          className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      <p id="passkey-help" className="text-xs text-muted-foreground">
        Unlocks the OpenPort driver that comes locked inside this app (version 1.01.4341). Windows asks for permission next.
      </p>
      {capsLock && (
        <p id="passkey-caps" className="text-xs text-chart-4">
          Caps Lock is on.
        </p>
      )}
      {error && (
        <p id="passkey-error" role="alert" className="text-sm text-destructive">
          {error}
          {locked && <span className="tabular-nums"> ({lockLeft}s)</span>}
        </p>
      )}
      <Button type="submit" className="rounded-full" disabled={!value || busy || locked}>
        {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <KeyRound />}
        {busy ? "Checking…" : "Unlock and install"}
      </Button>
    </form>
  );
}

// --- progressive disclosure for power users ----------------------------------------

function TechnicalDetails({ status }: { status: CableSetupStatus | null }): React.JSX.Element | null {
  if (!status) return null;
  const rows: [string, string][] = [
    ["Windows build", status.windowsBuild ? String(status.windowsBuild) : "n/a"],
    ["J2534 driver registered", status.driverInstalled ? "yes" : "no"],
    ["Driver version", status.driverVersion ? `${status.driverVersion} (${status.driverVersionState})` : "n/a"],
    ["Cable state", status.cable + (status.cableProblemCode ? ` (Code ${status.cableProblemCode})` : "")],
    ["Locked driver in this app", status.driverBundled ? "yes" : "no"],
    ["Python", status.preflight ? `${status.preflight.bitness ?? "?"}-bit ${status.preflight.python ?? ""}`.trim() : "not checked"],
    ["Last checked", new Date(status.checkedAt).toLocaleTimeString()],
  ];
  return (
    <details className="group rounded-2xl border border-border/60 bg-background/30 px-4 py-2 text-xs">
      <summary className="cursor-pointer select-none py-1 font-medium text-muted-foreground">Technical details</summary>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 py-2">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-all font-mono">{value}</dd>
          </div>
        ))}
      </dl>
      {status.preflight?.message && (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/60 p-2 font-mono text-[11px]">
          {status.preflight.message}
        </pre>
      )}
    </details>
  );
}
