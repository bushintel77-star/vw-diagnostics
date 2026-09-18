import { HardDriveDownload } from "lucide-react";
import { DiagnosticFlashEvent, DidMapEntry, EcuInfo } from "@shared/types";

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

const DidMap = ({ entries }: { entries: DidMapEntry[] }) => (
  <div className="space-y-1.5">
    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      Live DID map (UDS 0x22 probe)
    </p>
    <ul className="grid gap-1 text-xs">
      {entries.map((entry) => (
        <li
          key={`${entry.channel}-${entry.did}`}
          className="flex items-center gap-2"
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
      {pct !== null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-chart-1 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
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
  <Card>
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
