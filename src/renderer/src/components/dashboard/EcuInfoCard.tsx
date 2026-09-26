import { HardDriveDownload } from "lucide-react";
import { DiagnosticFlashEvent, DidMapEntry, EcuInfo } from "@shared/types";

import { cn } from "@/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const rows = (info: EcuInfo): Array<[string, string]> => [
  ["ECU", info.ecuName],
  ["Protocol", info.protocol],
  ["Request / Response", `${info.requestId} / ${info.responseId}`],
  ["Part number", info.partNumber ?? "not reported"],
  [
    "Software / Hardware",
    `${info.swVersion ?? "not reported"} / ${info.hwVersion ?? "not reported"}`,
  ],
  // Serial only appears when the ECU actually answered 0xF18C.
  ...(info.serial ? ([["Serial", info.serial]] as Array<[string, string]>) : []),
  ["Coding", info.coding ?? "not reported"],
];

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} kB`;

// Each probed channel "lights up" in turn; order and colour are the real
// probe result (answered vs not), only the reveal is staggered.
const STAGGER_MS = 70;

const DidMap = ({ entries }: { entries: DidMapEntry[] }) => (
  <div className="space-y-1.5">
    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      Live DID map (UDS 0x22 probe)
    </p>
    <div className="flex items-center gap-2">
      <div aria-hidden className="flex flex-wrap gap-1">
        {entries.map((entry, index) => (
          <span
            key={`cell-${entry.channel}-${entry.did}`}
            className={cn(
              "size-3 rounded-[3px] animate-cell-pop motion-reduce:animate-none",
              entry.ok
                ? "bg-chart-2 shadow-[0_0_8px_1px_hsl(var(--chart-2)/0.85)]"
                : "border border-border bg-muted"
            )}
            style={{ animationDelay: `${index * STAGGER_MS}ms` }}
          />
        ))}
      </div>
      <span className="text-[11px] tabular-nums text-muted-foreground">
        {entries.filter((entry) => entry.ok).length} of {entries.length} channels answered
      </span>
    </div>
    <ul className="grid gap-1 text-xs">
      {entries.map((entry, index) => (
        <li
          key={`${entry.channel}-${entry.did}`}
          className="flex items-center gap-2 animate-fade-up motion-reduce:animate-none"
          style={{ animationDelay: `${index * STAGGER_MS}ms` }}
          title={entry.note}
        >
          <Badge
            variant={entry.ok ? "secondary" : "outline"}
            className={`h-5 px-1.5 text-[10px] ${
              entry.ok ? "" : "text-muted-foreground"
            }`}
          >
            {entry.ok ? entry.did : "—"}
          </Badge>
          <span className={entry.ok ? "font-medium" : "text-muted-foreground line-through"}>
            {entry.channel}
          </span>
          <span className="truncate text-muted-foreground">{entry.note}</span>
        </li>
      ))}
    </ul>
  </div>
);

// ECU memory as a grid of blocks, filled in read order as bytes arrive.
const MEMORY_BLOCKS = 64;

const MemoryMap = ({ pct }: { pct: number }) => {
  const filled = Math.round((pct / 100) * MEMORY_BLOCKS);
  return (
    <div
      role="progressbar"
      aria-label="ECU backup progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="grid grid-cols-[repeat(16,minmax(0,1fr))] gap-[3px]"
    >
      {Array.from({ length: MEMORY_BLOCKS }, (_, index) => (
        <span
          key={index}
          className={cn(
            "h-2 rounded-[2px] transition-colors duration-300",
            index < filled
              ? "bg-chart-1 shadow-[0_0_6px_hsl(var(--chart-1)/0.7)]"
              : index === filled
                ? // the block being read right now: bright, breathing neon
                  "animate-neon-pulse bg-chart-1 shadow-[0_0_12px_3px_hsl(var(--chart-1))] motion-reduce:animate-none"
                : "bg-muted"
          )}
        />
      ))}
    </div>
  );
};

const BackupControl = ({
  flash,
  running,
  onBackup,
}: {
  flash: DiagnosticFlashEvent | null;
  running: boolean;
  onBackup: () => void;
}) => {
  const busy = flash?.phase === "start" || flash?.phase === "progress";
  const progress =
    flash && flash.phase === "progress" && flash.totalBytes ? flash : null;
  const pct = progress
    ? Math.min(100, Math.round(((progress.bytes ?? 0) / (progress.totalBytes ?? 1)) * 100))
    : null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Stock ECU backup
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={!running || busy}
          onClick={onBackup}
        >
          <HardDriveDownload className="size-3.5" />
          {busy ? "Reading…" : "Read & back up"}
        </Button>
        {progress && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {`${formatBytes(progress.bytes ?? 0)} / ${formatBytes(
              progress.totalBytes ?? 0
            )} (${pct}%)`}
          </span>
        )}
      </div>
      {busy && pct === null && (
        // Read requested, no byte count yet: honest indeterminate sweep.
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="absolute inset-y-0 w-1/4 animate-sweep rounded-full bg-gradient-to-r from-transparent via-chart-1 to-transparent motion-reduce:animate-none" />
        </div>
      )}
      {pct !== null && <MemoryMap pct={pct} />}
      {flash?.phase === "complete" && (
        <p className="text-xs text-chart-2">
          {flash.path ? (
            <>
              {`Backup saved — ${formatBytes(flash.bytes ?? 0)} at `}
              <code className="rounded bg-muted px-1">{flash.path}</code>
              {flash.sha256 && (
                <span className="block truncate font-mono text-[10px] text-muted-foreground">
                  {`sha256 ${flash.sha256.slice(0, 32)}…`}
                </span>
              )}
            </>
          ) : (
            "Read complete (browser demo — nothing written to disk)."
          )}
        </p>
      )}
      {flash?.phase === "error" && (
        <p className="text-xs text-destructive">{flash.message}</p>
      )}
      <p className="text-[11px] leading-snug text-muted-foreground">
        The rollback path for every future ECU write: read the stock image and
        keep the file safe before anything touches the calibration.
      </p>
    </div>
  );
};

interface EcuInfoCardProps {
  info: EcuInfo;
  dids?: DidMapEntry[] | null;
  flash?: DiagnosticFlashEvent | null;
  running?: boolean;
  onBackup?: () => void;
}

const EcuInfoCard = ({ info, dids, flash, running, onBackup }: EcuInfoCardProps) => (
  <Card className="animate-fade-up motion-reduce:animate-none">
    <CardHeader>
      <CardTitle>ECU Identification</CardTitle>
      <CardDescription>UDS identification data</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          VIN
        </p>
        <p className="font-mono text-sm font-semibold tracking-wider">
          {info.vin}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        {rows(info).map(([label, value]) => (
          <div key={label} className="col-span-2 grid grid-cols-subgrid">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      {dids && dids.length > 0 && <DidMap entries={dids} />}
      {onBackup && (
        <BackupControl flash={flash ?? null} running={Boolean(running)} onBackup={onBackup} />
      )}
    </CardContent>
  </Card>
);

export default EcuInfoCard;
