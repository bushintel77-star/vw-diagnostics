import { useEffect, useRef, useState } from "react";
import { Ban, RotateCcw, TriangleAlert } from "lucide-react";
import { ComponentDeletion, DiagnosticDeletionsEvent } from "@shared/types";

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

const GROUPS: Array<{ id: ComponentDeletion["group"]; title: string; note: string }> = [
  { id: "engine", title: "Engine & Exhaust", note: "Reversible coding changes on the Engine ECU" },
  {
    id: "offroad",
    title: "Post-Removal Deletes",
    note: "Emissions-related — OFF-ROAD / SHOW USE ONLY, not legal on public roads",
  },
];

const riskVariant = (risk: ComponentDeletion["risk"]) =>
  risk === "high" ? "destructive" : risk === "medium" ? "secondary" : "outline";

interface DeletionPanelProps {
  deletions: DiagnosticDeletionsEvent | null;
  running: boolean;
  onDelete: (componentId: string) => void;
  onRestore: (componentId: string) => void;
}

const DeletionPanel = ({
  deletions,
  running,
  onDelete,
  onRestore,
}: DeletionPanelProps) => {
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

  const handleClick = (item: ComponentDeletion): void => {
    if (confirmingId !== item.id) {
      setConfirmingId(item.id);
      return;
    }
    setConfirmingId(null);
    onDelete(item.id);
  };

  const catalog = deletions?.catalog ?? [];
  const active = new Set(deletions?.active ?? []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Ban className="size-4 text-muted-foreground" />
          Component Deletion
          {active.size > 0 && (
            <Badge variant="secondary">{active.size} coded out</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Code components out via ECU adaptation/coding — every change is
          reversible with Restore
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {catalog.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {running
              ? "Waiting for the deletion catalog from the monitor…"
              : "Start a session to load the deletion catalog."}
          </p>
        )}

        {GROUPS.map((group) => {
          const items = catalog.filter((item) => item.group === group.id);
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
                {items.map((item) => {
                  const isActive = active.has(item.id);
                  const confirming = confirmingId === item.id;
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        "flex flex-col gap-2 rounded-lg border p-3",
                        isActive && "border-chart-2/60 bg-chart-2/5",
                        item.offRoadOnly && !isActive && "border-destructive/30"
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-semibold leading-snug">
                          {item.name}
                        </p>
                        {isActive && <Badge variant="secondary">Coded out</Badge>}
                      </div>
                      <p className="text-xs leading-snug text-muted-foreground">
                        {item.description}
                      </p>
                      {item.requirement && (
                        <p className="flex items-start gap-1.5 rounded-md border border-chart-4/40 bg-chart-4/10 px-2 py-1.5 text-[11px] leading-snug text-chart-4">
                          <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                          {item.requirement}
                        </p>
                      )}
                      {item.steps && item.steps.length > 0 && (
                        <ol className="list-decimal space-y-0.5 pl-4 text-[11px] leading-snug text-muted-foreground">
                          {item.steps.map((step) => (
                            <li key={step}>{step}</li>
                          ))}
                        </ol>
                      )}
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant={riskVariant(item.risk)} className="text-[10px]">
                          {item.risk} risk
                        </Badge>
                        {item.offRoadOnly && (
                          <Badge variant="destructive" className="text-[10px]">
                            <TriangleAlert className="mr-1 size-2.5" />
                            OFF-ROAD ONLY
                          </Badge>
                        )}
                        {item.commonlyPairedWith?.map((pairedId) => {
                          const paired = catalog.find((c) => c.id === pairedId);
                          return paired ? (
                            <Badge key={pairedId} variant="outline" className="text-[10px] font-normal">
                              Often paired: {paired.name}
                            </Badge>
                          ) : null;
                        })}
                        <span className="text-[10px] text-muted-foreground">
                          {item.ecu} ECU · {item.method}
                        </span>
                      </div>
                      {item.clearsCodes.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="text-[10px] text-muted-foreground">
                            stops reporting:
                          </span>
                          {item.clearsCodes.map((code) => (
                            <Badge
                              key={code}
                              variant="outline"
                              className="font-mono text-[10px]"
                            >
                              {code}
                            </Badge>
                          ))}
                        </div>
                      )}
                      <div className="mt-auto pt-1">
                        {isActive ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 w-full text-xs"
                            disabled={!running}
                            onClick={() => onRestore(item.id)}
                          >
                            <RotateCcw className="size-3.5" />
                            Restore stock coding
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant={confirming ? "destructive" : "outline"}
                            className="h-7 w-full text-xs"
                            disabled={!running}
                            onClick={() => handleClick(item)}
                          >
                            {confirming
                              ? item.offRoadOnly
                                ? "Confirm (off-road use)"
                                : "Confirm deletion"
                              : "Delete component"}
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
          Performance-scoped deletions on the Engine ECU only. Post-removal
          deletes disable emissions monitoring (SAI, EGR, GPF, O₂) and are for
          off-road or show use only — illegal on public roads in most
          jurisdictions.
        </p>
      </CardContent>
    </Card>
  );
};

export default DeletionPanel;
