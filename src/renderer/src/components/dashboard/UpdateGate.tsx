import { useEffect, useState } from "react";
import { AlertTriangle, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { UpdateCheckResult } from "@shared/types";

/**
 * UpdateGate — the kill-switch screen. Renders ONLY on a "blocked" result:
 * this install is below the remotely declared minimum version and must not
 * present the dashboard. There is deliberately no dismiss; the only way out
 * is downloading the update. "current", "available" (the banner handles
 * that) and "unknown" render nothing.
 */
const UpdateGate = () => {
  const [result, setResult] = useState<UpdateCheckResult | null>(null);

  useEffect(() => {
    if (typeof window.context?.checkForUpdate !== "function") return;
    let cancelled = false;
    window.context
      .checkForUpdate()
      .then((check) => {
        if (!cancelled) setResult(check);
      })
      .catch(() => {
        // A failed check never blocks the dashboard.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (result?.status !== "blocked") return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 p-6 backdrop-blur">
      <Card className="max-w-lg border-destructive/50 bg-destructive/5">
        <CardContent className="space-y-4 p-6">
          <div className="flex items-center gap-3">
            <AlertTriangle className="size-6 shrink-0 text-destructive" />
            <h2 className="text-xl font-bold">
              Update required before continuing
            </h2>
          </div>
          <p className="text-sm leading-relaxed">
            This version ({result.currentVersion}) has been retired —
            version {result.requiredVersion} or newer is required to run the
            dashboard. Diagnostics software that talks to a real ECU must not
            run on a version with known faults.
          </p>
          <p className="text-xs text-muted-foreground">
            Download the new installer, run it, and reopen the app. Your
            data — learned baselines and session history — is untouched by
            the update.
          </p>
          <Button
            className="w-full"
            onClick={() => {
              if (typeof window.context?.openUpdateDownload === "function") {
                void window.context.openUpdateDownload();
              }
            }}
          >
            <Download className="size-4" />
            Download {result.requiredVersion}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};

export default UpdateGate;
