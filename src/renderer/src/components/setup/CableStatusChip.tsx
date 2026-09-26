import { Cable } from "lucide-react";
import { cn } from "@/utils";
import { CableSetupStatus } from "@shared/types";
import { attentionKey } from "./setupFlow";

/**
 * Ambient cable status in the header: always-current, one click into the
 * setup wizard. Hidden where setup doesn't apply (browser sessions).
 */
export default function CableStatusChip({
  status,
  justConnected,
  onOpen,
}: {
  status: CableSetupStatus | null;
  justConnected: boolean;
  onOpen: () => void;
}): React.JSX.Element | null {
  if (!status?.platformSupported) return null;

  const tone = attentionKey(status)
    ? status.driverInstalled
      ? { label: "Cable needs attention", dot: "bg-destructive", ring: "border-destructive/50" }
      : { label: "Driver needed", dot: "bg-chart-4", ring: "border-chart-4/50" }
    : status.cable === "ready"
      ? { label: "Cable ready", dot: "bg-chart-2", ring: "border-chart-2/50" }
      : { label: "Cable not plugged in", dot: "bg-muted-foreground/60", ring: "border-border" };

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${tone.label}. Open cable setup`}
      title="Cable setup"
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-full border bg-background/60 px-3 text-xs font-medium backdrop-blur transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        tone.ring
      )}
    >
      <span className="relative flex size-2">
        {justConnected && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-chart-2 opacity-75 motion-reduce:animate-none" />
        )}
        <span className={cn("relative inline-flex size-2 rounded-full", tone.dot)} />
      </span>
      <Cable className="size-3.5 text-muted-foreground" />
      {tone.label}
    </button>
  );
}
