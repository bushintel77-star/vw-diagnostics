import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { UpdateCheckResult } from "@shared/types";

/**
 * New-version notice. Renders ONLY on an "available" result — "current" and
 * "unknown" (offline, dev build, API failure) render nothing at all, so a
 * failed check can never masquerade as "you're up to date". The click opens
 * the release page via the main process; the renderer never sees the URL.
 */
const UpdateBanner = () => {
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(false);

  useEffect(() => {
    // Browser/demo contexts expose an "unknown" stub; guard anyway so a
    // missing preload can never break first paint.
    if (typeof window.context?.checkForUpdate !== "function") return;
    let cancelled = false;
    window.context
      .checkForUpdate()
      .then((check) => {
        if (!cancelled) setResult(check);
      })
      .catch(() => {
        // Silence on failure is intentional.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (dismissed || result?.status !== "available") return null;

  return (
    <Card className="border-chart-2/50 bg-chart-2/10">
      <CardContent className="flex flex-wrap items-center gap-3 p-4">
        <Download className="size-5 shrink-0 text-chart-2" />
        <p className="flex-1 text-sm">
          Version {result.latestVersion} is available — you have{" "}
          {result.currentVersion}.
        </p>
        <Button
          size="sm"
          className="h-8"
          onClick={() => {
            if (typeof window.context?.openUpdateDownload === "function") {
              void window.context.openUpdateDownload();
            }
          }}
        >
          <Download className="size-3.5" />
          Download {result.latestVersion}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          aria-label="Dismiss update notice"
          onClick={() => setDismissed(true)}
        >
          <X className="size-4" />
        </Button>
      </CardContent>
    </Card>
  );
};

export default UpdateBanner;
