import { useEffect, useRef, useState } from "react";
import { RotateCcw, ShieldCheck, TriangleAlert, Zap } from "lucide-react";
import { DiagnosticModsEvent, PerformanceMod } from "@shared/types";

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

const GROUPS: Array<{ id: PerformanceMod["group"]; title: string; note: string }> = [
  { id: "engine", title: "Engine", note: "Engine ECU (0x7E0) calibrations & coding" },
  { id: "transmission", title: "Transmission", note: "DSG TCU (0x7E1) calibrations" },
  {
    id: "offroad",
    title: "Overrun & Acoustic",
    note: "OFF-ROAD / SHOW USE ONLY",
  },
];

const riskVariant = (risk: PerformanceMod["risk"]) =>
  risk === "high" ? "destructive" : risk === "medium" ? "secondary" : "outline";

/** Compact module-scope card shown beside the session state. */
export const ScopeCard = ({ mods }: { mods: DiagnosticModsEvent | null }) => (
  <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-chart-2" />
        Safety Scope
      </CardTitle>
      <CardDescription>Write policy enforced by the monitor</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3 text-sm">
      <div>
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Write allowed
        </p>
        <div className="flex flex-wrap gap-1.5">
          {(mods?.scope.allowed ?? []).map((module) => (
            <Badge key={module.name} variant="secondary" className="font-normal">
              {module.name}
              {module.address && (
                <span className="ml-1 font-mono text-[10px]">{module.address}</span>
              )}
            </Badge>
          ))}
          {!mods && (
            <span className="text-xs text-muted-foreground">
              Loads with the first session…
            </span>
          )}
        </div>
      </div>
      <div>
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Never touched
        </p>
        <div className="flex flex-wrap gap-1.5">
          {(mods?.scope.blocked ?? ["Steering", "Brakes", "Airbag/SRS", "ADAS", "All other modules"]).map(
            (module) => (
              <Badge
                key={module.name}
                variant="outline"
                className="font-normal text-muted-foreground"
              >
                <span className="mr-1">🔒</span>
                {module.name}
              </Badge>
            )
          )}
        </div>
      </div>
      <p className="text-[10px] leading-snug text-muted-foreground">
        Default-deny: any operation targeting a module outside this scope is
        refused by the monitor before a write is attempted. Steering, brakes
        and restraint systems are permanently out of scope.
      </p>
    </CardContent>
  </Card>
);

interface ModsPanelProps {
  mods: DiagnosticModsEvent | null;
  running: boolean;
  onApply: (modId: string) => void;
  onRevert: (modId: string) => void;
}

const ModsPanel = ({ mods, running, onApply, onRevert }: ModsPanelProps) => {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (confirmingId) {
      timer.current = setTimeout(() => setConfirmingId(null), 4000);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [confirmingId]);

  const handleClick = (mod: PerformanceMod): void => {
    if (confirmingId !== mod.id) {
      setConfirmingId(mod.id);
      return;
    }
    setConfirmingId(null);
    onApply(mod.id);
  };

  const catalog = mods?.catalog ?? [];
  const active = new Set(mods?.active ?? []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="size-4 text-chart-1" />
          Performance Mods
          {active.size > 0 && (
            <Badge variant="secondary">{active.size} applied</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Calibrations and coding on the Engine and DSG ECUs — scoped
          performance changes only, every mod reverts to stock
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {catalog.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {running
              ? "Waiting for the mods catalog from the monitor…"
              : "Start a session to load the performance catalog."}
          </p>
        )}

        {GROUPS.map((group) => {
          const items = catalog.filter((mod) => mod.group === group.id);
          if (items.length === 0) return null;
          return (
            <section key={group.id} className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <h3
                  className={cn(
                    "text-sm font-semibold",
                    group.id === "offroad" && "text-destructive"
                  )}
                >
                  {group.title}
                </h3>
                <p className="text-xs text-muted-foreground">{group.note}</p>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {items.map((mod) => {
                  const isActive = active.has(mod.id);
                  const confirming = confirmingId === mod.id;
                  return (
                    <div
                      key={mod.id}
                      className={cn(
                        "flex flex-col gap-2 rounded-lg border p-3",
                        isActive && "border-chart-2/60 bg-chart-2/5",
                        mod.offRoadOnly && !isActive && "border-destructive/30"
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-semibold leading-snug">
                          {mod.name}
                        </p>
                        {isActive && (
                          <Badge variant="secondary">Applied</Badge>
                        )}
                      </div>
                      <p className="font-mono text-xs text-foreground/80">
                        {mod.parameter}
                      </p>
                      <p className="text-xs leading-snug text-muted-foreground">
                        {mod.description}
                      </p>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant={riskVariant(mod.risk)} className="text-[10px]">
                          {mod.risk} risk
                        </Badge>
                        {mod.offRoadOnly && (
                          <Badge variant="destructive" className="text-[10px]">
                            <TriangleAlert className="mr-1 size-2.5" />
                            OFF-ROAD ONLY
                          </Badge>
                        )}
                        <span className="text-[10px] text-muted-foreground">
                          {mod.ecu} · {mod.method}
                        </span>
                      </div>
                      {mod.requirement && (
                        <p className="rounded bg-muted px-2 py-1 text-[10px] leading-snug text-muted-foreground">
                          {mod.requirement}
                        </p>
                      )}
                      <div className="mt-auto pt-1">
                        {isActive ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 w-full text-xs"
                            disabled={!running}
                            onClick={() => onRevert(mod.id)}
                          >
                            <RotateCcw className="size-3.5" />
                            Revert to stock
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant={confirming ? "destructive" : "default"}
                            className="h-7 w-full text-xs"
                            disabled={!running}
                            onClick={() => handleClick(mod)}
                          >
                            {confirming
                              ? mod.offRoadOnly
                                ? "Confirm (off-road use)"
                                : "Confirm apply"
                              : "Apply mod"}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}

        <p className="text-[10px] leading-snug text-muted-foreground">
          Mods load simulated calibration slots/coding on Engine (0x7E0) and
          DSG (0x7E1) only. Fuel and mechanical requirements shown on each mod
          are real-world preconditions — the monitor logs them with every
          apply. Overrun burble raises exhaust temperatures and is off-road
          use.
        </p>
      </CardContent>
    </Card>
  );
};

export default ModsPanel;
