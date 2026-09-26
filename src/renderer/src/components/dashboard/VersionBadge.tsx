import { useEffect, useState } from "react";
import { cn } from "@/utils";
import { UpdateCheckResult } from "@shared/types";

/**
 * Always-visible app version with its update state. "Latest" is shown only
 * after a successful check says so — offline or a failed check shows the
 * bare version, never a false "up to date". "Update available" opens the
 * release page via the main process (the renderer never handles the URL).
 */
const VersionBadge = () => {
  const [result, setResult] = useState<UpdateCheckResult | null>(null);

  useEffect(() => {
    if (typeof window.context?.checkForUpdate !== "function") return;
    let cancelled = false;
    window.context
      .checkForUpdate()
      .then((check) => {
        if (!cancelled) setResult(check);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!result || !/^\d/.test(result.currentVersion)) return null;
  const version = `v${result.currentVersion}`;
  const base = "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium";

  if (result.status === "available" || result.status === "blocked") {
    return (
      <button
        type="button"
        onClick={() => void window.context.openUpdateDownload?.()}
        className={cn(base, "border-chart-4/50 bg-chart-4/10 hover:bg-chart-4/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
        title="Download the new version"
      >
        <span className="size-1.5 rounded-full bg-chart-4" />
        {version} · Update available
      </button>
    );
  }
  if (result.status === "current") {
    return (
      <span className={cn(base, "border-chart-2/50 bg-chart-2/10")}>
        <span className="size-1.5 rounded-full bg-chart-2" />
        {version} · Latest
      </span>
    );
  }
  return <span className={cn(base, "border-border text-muted-foreground")}>{version}</span>;
};

export default VersionBadge;
