import { expect, test } from "vitest";
import { DiagnosticEvent } from "@shared/types";

import { ensureDemoContext, isDemoMode } from "@/web/demoBridge";

describe("Browser demo bridge", () => {
  test("installs only without a preload context and runs a full session", async () => {
    // This file never imports window.mock, so window.context is absent.
    expect(window.context).toBeUndefined();

    ensureDemoContext();
    expect(isDemoMode()).toBe(true);

    const events: DiagnosticEvent[] = [];
    const unsubscribe = window.context.onDiagnosticEvent((event) =>
      events.push(event)
    );

    const result = await window.context.startDiagnostic({ simulate: true });
    expect(result.started).toBe(true);

    // Let the 500 ms live ticker produce a few samples.
    await new Promise((resolve) => setTimeout(resolve, 1300));

    expect(events.filter((e) => e.type === "live").length).toBeGreaterThanOrEqual(2);
    const info = events.find((e) => e.type === "info");
    expect(info && info.type === "info" && info.info.vin).toBe(
      "WV1ZZZ2H0JW123456"
    );
    expect(events.some((e) => e.type === "analysis")).toBe(true);
    expect(events.some((e) => e.type === "deletions")).toBe(true);
    expect(events.some((e) => e.type === "mods")).toBe(true);

    // Command flow: clearing codes updates the DTC list and analysis.
    const command = await window.context.sendDiagnosticCommand({
      cmd: "clear_dtc",
    });
    expect(command.ok).toBe(true);
    expect(
      events.some((e) => e.type === "dtc" && e.codes.length === 0)
    ).toBe(true);

    // A second bridge install is a no-op; stop ends the session.
    ensureDemoContext();
    const stopped = await window.context.stopDiagnostic();
    expect(stopped.started).toBe(false);
    unsubscribe();
  });
});
