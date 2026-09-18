import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { DiagnosticVerificationEvent, VerificationItem } from "@shared/types";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const itemBadge = (status: VerificationItem["status"]) => {
  if (status === "pass") {
    return (
      <Badge variant="secondary" className="text-[10px]">
        PASS
      </Badge>
    );
  }
  if (status === "skipped") {
    return (
      <Badge variant="outline" className="text-[10px] text-muted-foreground">
        SKIP
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className="text-[10px]">
      FAIL
    </Badge>
  );
};

const VerificationCard = ({
  verification,
}: {
  verification: DiagnosticVerificationEvent;
}) => (
  <Card>
    <CardHeader>
      <CardTitle className="flex flex-wrap items-center gap-2">
        {verification.verdict === "pass" ? (
          <ShieldCheck className="size-4 text-chart-2" />
        ) : verification.verdict === "fail" ? (
          <ShieldX className="size-4 text-destructive" />
        ) : (
          <ShieldAlert className="size-4 text-muted-foreground" />
        )}
        Post-Flash Health Check
        <Badge
          variant={
            verification.verdict === "pass"
              ? "secondary"
              : verification.verdict === "fail"
                ? "destructive"
                : "outline"
          }
          className={verification.verdict === "inconclusive" ? "text-muted-foreground" : ""}
        >
          {verification.verdict === "pass"
            ? "PASSED"
            : verification.verdict === "fail"
              ? "FAILED"
              : "NOT VERIFIED"}
        </Badge>
        {verification.source && (
          <Badge
            variant={verification.source === "ecu" ? "default" : "outline"}
            className="text-[10px]"
          >
            {verification.source === "ecu"
              ? "re-read from ECU"
              : "simulated self-check"}
          </Badge>
        )}
        <Badge variant="outline" className="ml-auto font-mono text-[10px]">
          {new Date(verification.timestamp).toLocaleTimeString()}
        </Badge>
      </CardTitle>
      <CardDescription>
        Post-flash scan: new fault codes, channel limits, coolant,
        sample plausibility — confirms the vehicle reads healthy; this
        app does not write or verify tunes
        {verification.dutyProfile ? ` · duty: ${verification.dutyProfile}` : ""}
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      {verification.envelope && (
        <p className="rounded-md border border-chart-2/30 bg-chart-2/5 px-3 py-2 text-xs text-muted-foreground">
          {`Factory envelope — peak ${
            verification.envelope.peakTorqueNm?.toFixed(0) ?? "—"
          } Nm / sustained ${
            verification.envelope.sustainedTorqueNm?.toFixed(0) ?? "—"
          } Nm vs ceilings ${verification.envelope.ceilingPeakNm.toFixed(0)} / ${verification.envelope.ceilingSustainedNm.toFixed(
            0
          )} Nm (${verification.envelope.ladder})`}
        </p>
      )}
      <ul className="space-y-1.5">
        {verification.items.map((item) => (
          <li
            key={item.check}
            className="flex flex-wrap items-baseline gap-x-2 text-sm"
          >
            {itemBadge(item.status)}
            <span
              className={`font-medium ${
                item.status === "skipped" ? "text-muted-foreground" : ""
              }`}
            >
              {item.check}
            </span>
            <span className="text-xs text-muted-foreground">— {item.detail}</span>
          </li>
        ))}
      </ul>
    </CardContent>
  </Card>
);

export default VerificationCard;
