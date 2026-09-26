import { useCallback, useEffect, useRef, useState } from "react";
import { CablePreflight, CableSetupStatus } from "@shared/types";
import { attentionKey } from "./setupFlow";

// Plug-and-play: status is polled (fast while the wizard is open, slow in
// the background, never while a session holds the cable), so plugging in or
// finishing the installer is noticed without a click.
export const FAST_POLL_MS = 2000;
export const SLOW_POLL_MS = 5000;
const CONNECTED_FLASH_MS = 4000;

export interface CableSetupController {
  status: CableSetupStatus | null;
  checking: boolean;
  open: boolean;
  justConnected: boolean;
  openWizard: () => void;
  closeWizard: () => void;
  recheck: () => void;
}

export function useCableSetup({
  sessionActive,
}: {
  sessionActive: boolean;
}): CableSetupController {
  const [probe, setProbe] = useState<CableSetupStatus | null>(null);
  // The Python check only comes from full checks, so it is kept apart from
  // the quick polls and composed back in below.
  const [preflight, setPreflight] = useState<CablePreflight | null>(null);
  const [fullChecks, setFullChecks] = useState(0);
  const [open, setOpen] = useState(false);
  const [justConnected, setJustConnected] = useState(false);

  const lastProbe = useRef<CableSetupStatus | null>(null);
  const requestSeq = useRef(0);
  const appliedSeq = useRef(0);
  const quickInFlight = useRef(false);
  const dismissedKey = useRef<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  const refreshRef = useRef<(full: boolean) => Promise<void>>(async () => {});

  const refresh = useCallback(async (full: boolean): Promise<void> => {
    const context = window.context;
    if (typeof context?.getCableSetupStatus !== "function") return;
    if (!full && quickInFlight.current) return;
    const seq = ++requestSeq.current;
    if (full) setFullChecks((n) => n + 1);
    else quickInFlight.current = true;
    try {
      const next = await context.getCableSetupStatus({ full });
      if (full) setPreflight(next.preflight);
      // A slow full check must not overwrite a newer quick poll.
      if (seq <= appliedSeq.current) return;
      appliedSeq.current = seq;
      const before = lastProbe.current;
      lastProbe.current = next;
      setProbe(next);
      if (!before) return;
      if (before.driverInstalled !== next.driverInstalled && !full) {
        setPreflight(null);
        void refreshRef.current(true);
      }
      if (before.cable !== "ready" && next.cable === "ready") {
        setJustConnected(true);
        window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setJustConnected(false), CONNECTED_FLASH_MS);
        if (!full) void refreshRef.current(true);
      }
    } catch {
      // A failed probe keeps the last known state; the next poll retries.
    } finally {
      if (full) setFullChecks((n) => n - 1);
      else quickInFlight.current = false;
    }
  }, []);
  refreshRef.current = refresh;

  const status: CableSetupStatus | null = probe ? { ...probe, preflight } : null;
  const supported = probe?.platformSupported !== false;

  // First look on launch.
  useEffect(() => {
    void refresh(false);
    return () => window.clearTimeout(flashTimer.current);
  }, [refresh]);

  // Live polling.
  useEffect(() => {
    if (!supported || sessionActive) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh(false);
    }, open ? FAST_POLL_MS : SLOW_POLL_MS);
    return () => window.clearInterval(timer);
  }, [supported, sessionActive, open, refresh]);

  // Opening the wizard runs the full self-check, Python link included.
  useEffect(() => {
    if (open) void refresh(true);
  }, [open, refresh]);

  // Auto-open once per distinct problem; never over a running session.
  const key = attentionKey(status);
  useEffect(() => {
    if (key && key !== dismissedKey.current && !open && !sessionActive) setOpen(true);
  }, [key, open, sessionActive]);

  const openWizard = useCallback(() => setOpen(true), []);
  const closeWizard = useCallback(() => {
    dismissedKey.current = attentionKey(lastProbe.current ? { ...lastProbe.current, preflight } : null);
    setOpen(false);
  }, [preflight]);
  const recheck = useCallback(() => void refresh(true), [refresh]);

  return {
    status,
    checking: fullChecks > 0,
    open,
    justConnected,
    openWizard,
    closeWizard,
    recheck,
  };
}
