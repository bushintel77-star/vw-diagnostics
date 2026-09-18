import { useEffect, useRef, useState } from "react";
import { Eraser } from "lucide-react";
import { DtcCode } from "@shared/types";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const statusVariant = (status: DtcCode["status"]) =>
  status === "Active"
    ? "destructive"
    : status === "Pending"
      ? "outline"
      : "secondary";

const freezeFrameText = (frame: DtcCode["freezeFrame"]): string =>
  frame
    ? `${frame.rpm} rpm · ${frame.coolantTempC}°C · ${frame.engineLoadPct}% load · ${frame.speedKph} km/h`
    : "—";

interface DtcTableProps {
  /** null = never read this session; [] = ECU read, zero faults reported. */
  codes: DtcCode[] | null;
  /** Session active — clearing requires a running monitor. */
  running: boolean;
  onClear: () => void;
}

const DtcTable = ({ codes, running, onClear }: DtcTableProps) => {
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (confirming) {
      timer.current = setTimeout(() => setConfirming(false), 4000);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [confirming]);

  const handleClearClick = (): void => {
    // Two-step confirmation: destructive UDS 0x14 must never be one click away.
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    onClear();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Fault Codes
          {codes !== null && codes.length > 0 && (
            <Badge
              variant={
                codes.some((c) => c.status === "Active") ? "destructive" : "secondary"
              }
            >
              {codes.length}
            </Badge>
          )}
          <Button
            size="sm"
            variant={confirming ? "destructive" : "outline"}
            className="ml-auto h-7 text-xs"
            disabled={!codes || codes.length === 0 || !running}
            onClick={handleClearClick}
          >
            <Eraser className="size-3.5" />
            {confirming ? "Confirm clear (UDS 0x14)?" : "Clear codes"}
          </Button>
        </CardTitle>
        <CardDescription>
          Diagnostic Trouble Codes with freeze-frame conditions (UDS 0x19)
        </CardDescription>
      </CardHeader>
      {codes === null ? (
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No data — connect an interface and start a session to read fault
            codes from the ECU.
          </p>
        </CardContent>
      ) : codes.length === 0 ? (
        <CardContent>
          {/* Genuine result: the ECU was read (UDS 0x19) and reported none. */}
          <p className="text-sm text-muted-foreground">No fault codes stored.</p>
        </CardContent>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Conditions when set</TableHead>
              <TableHead className="text-right">Mileage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {codes.map((dtc) => (
              <TableRow key={dtc.code}>
                <TableCell className="font-mono font-semibold">{dtc.code}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(dtc.status)}>{dtc.status}</Badge>
                </TableCell>
                <TableCell className="max-w-72 text-muted-foreground">
                  {dtc.description}
                </TableCell>
                <TableCell className="text-xs tabular-nums text-muted-foreground">
                  {freezeFrameText(dtc.freezeFrame)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {dtc.mileageKm === null
                    ? "—"
                    : `${dtc.mileageKm.toLocaleString()} km`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
};

export default DtcTable;
