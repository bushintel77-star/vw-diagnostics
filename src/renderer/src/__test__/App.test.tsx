import "@testing-library/jest-dom";
import "./utils/window.mock";
import { mockState } from "./utils/window.mock";
import { render, screen, fireEvent, waitFor } from "./utils";
import { cleanup } from "@testing-library/react";
import { expect, test, describe, beforeEach, vi } from "vitest";
import { act } from "react";
import App from "@/App";
import { DiagnosticEventListener } from "@shared/types";

const startMock = () => window.context.startDiagnostic as ReturnType<typeof vi.fn>;
const stopMock = () => window.context.stopDiagnostic as ReturnType<typeof vi.fn>;
const commandMock = () =>
  window.context.sendDiagnosticCommand as ReturnType<typeof vi.fn>;
const subscribeMock = () =>
  window.context.onDiagnosticEvent as ReturnType<typeof vi.fn>;

/** The listener App most recently registered via onDiagnosticEvent. */
const dashboardListener = (): DiagnosticEventListener =>
  subscribeMock().mock.calls.at(-1)![0];

const CONNECTED_STATUS = {
  type: "status",
  phase: "connected",
  message: "Connected via J2534 pass-thru",
  mode: "live",
} as const;

const J2534_MISSING =
  "pyj2534 is not installed (pip install pyj2534) and/or the vendor J2534 DLL is not registered";

describe("Testing the VW diagnostic dashboard", () => {
  beforeEach(async () => {
    startMock().mockClear();
    stopMock().mockClear();
    commandMock().mockClear();
    subscribeMock().mockClear();
    mockState.replaySession = true;
    await act(async () => {
      render(<App />);
    });
  });

  test("renders the dashboard shell with replayed session data", () => {
    expect(screen.getByText(/VW Diagnostic Dashboard/i)).toBeVisible();
    // No simulation mode exists: no checkbox, no simulation badge.
    expect(screen.queryByLabelText("Simulation mode")).toBeNull();
    expect(screen.queryByText(/^Simulation$/)).toBeNull();
    expect(screen.getAllByText("Not connected").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("WV1ZZZ2H0JW123456")).toBeVisible();
    // P0299 shows in both the DTC table and the assistant finding
    expect(screen.getAllByText("P0299").length).toBeGreaterThanOrEqual(2);
    // Engine RPM labels both the gauge and the trend selector
    expect(screen.getAllByText("Engine RPM").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/No session started yet/i)).toBeVisible();
  });

  test("renders the AI assistant analysis and freeze frame", () => {
    expect(screen.getByText(/AI Diagnostic Assistant/i)).toBeVisible();
    expect(screen.getByText(/^Good$/)).toBeVisible();
    expect(screen.getByText("Turbo underboost (VNT)")).toBeVisible(); // finding title (exact)
    expect(screen.getByText(/68% confidence/i)).toBeVisible();
    expect(screen.getByText(/Boost pipe or intercooler leak/)).toBeVisible();
    expect(screen.getByText(/2210 rpm · 88°C/)).toBeVisible();
    expect(screen.getByText(/not a substitute for a qualified technician/i)).toBeVisible();
  });

  test("renders the tier-1 statistical layer with provenance and predictions", () => {
    // Provenance line
    expect(screen.getByText(/Session-learned baselines/i)).toBeVisible();
    expect(screen.getByText(/118 samples/i)).toBeVisible();
    // Learned baseline grid
    expect(screen.getByText(/Learned baselines vs\. live/i)).toBeVisible();
    expect(screen.getByText("+0.3σ")).toBeVisible();
    // Predictive alert with confidence and uncertainty note
    expect(screen.getByText(/Predictive alerts/i)).toBeVisible();
    expect(screen.getByText(/projects past 105°C in ~6 min/i)).toBeVisible();
    expect(screen.getByText(/91% confidence — extrapolation, not a certainty/i)).toBeVisible();
  });

  test("Start Session requests a real connection — no options, no mode flag", async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start session/i }));
    });

    await waitFor(() => {
      expect(startMock()).toHaveBeenCalledTimes(1);
    });
    // No arguments at all: the IPC surface carries no simulate flag.
    expect(startMock()).toHaveBeenCalledWith();
  });

  test("reacts to status events, then stops the running session", async () => {
    await act(async () => {
      dashboardListener()({
        type: "status",
        phase: "connected",
        message: "Connected via J2534 pass-thru",
        mode: "live",
      });
    });

    expect(screen.getByText(/^Connected$/)).toBeVisible();
    expect(screen.getByText(/^Connected via J2534 pass-thru$/)).toBeVisible();
    // While connected: Start is locked, Stop is available.
    expect(
      screen.getByRole("button", { name: /start session/i })
    ).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));
    });

    await waitFor(() => {
      expect(stopMock()).toHaveBeenCalledTimes(1);
    });
  });

  test("clearing fault codes requires a two-step confirmation", async () => {
    const clearButton = screen.getByRole("button", { name: /clear codes/i });
    expect(clearButton).toBeDisabled(); // no running session yet

    await act(async () => {
      dashboardListener()(CONNECTED_STATUS);
    });

    // First click only arms the confirmation.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /clear codes/i }));
    });
    expect(commandMock()).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /confirm clear/i })
    ).toBeVisible();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm clear/i }));
    });

    await waitFor(() => {
      expect(commandMock()).toHaveBeenCalledWith({ cmd: "clear_dtc" });
    });
  });

  test("renders the component deletion catalog with off-road gating", () => {
    expect(screen.getByText(/Component Deletion/i)).toBeVisible();
    expect(screen.getByText("Start-Stop memory (stays off)")).toBeVisible();
    expect(screen.getByText("EGR system")).toBeVisible();
    expect(screen.getByText(/OFF-ROAD ONLY/i)).toBeVisible();
    // Real calibration steps are shown for the EGR delete
    expect(
      screen.getByText(/Zero the five EGR hysteresis matrices/i)
    ).toBeVisible();
    expect(
      screen.getByText(/MAF plausibility model/i)
    ).toBeVisible();
    // conflict warnings (e.g. ASV vs DPF regen) surface on the card
    expect(
      screen.getByText(/CONFLICT — the ECU uses the ASV/i)
    ).toBeVisible();
    // Nothing can ever be coded out by this app — no active badge, no restore
    expect(screen.queryByText(/^Coded out$/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /restore stock coding/i })
    ).toBeNull();
  });

  test("deletion controls are disabled — deletions are applied by bench flashing", async () => {
    // Even with a session running, this app never writes: delete controls
    // stay disabled and send nothing, and nothing is ever "coded out".
    expect(
      screen.getAllByRole("button", { name: /delete component/i }).length
    ).toBeGreaterThanOrEqual(1);
    screen
      .getAllByRole("button", { name: /delete component/i })
      .forEach((btn) => expect(btn).toBeDisabled());

    await act(async () => {
      dashboardListener()(CONNECTED_STATUS);
    });

    screen
      .getAllByRole("button", { name: /delete component/i })
      .forEach((btn) => expect(btn).toBeDisabled());
    expect(
      screen.queryByRole("button", { name: /restore stock coding/i })
    ).toBeNull();
    expect(screen.queryByText(/^Coded out$/i)).toBeNull();
    expect(
      screen.getAllByText(/applied by bench flashing/i).length
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText(/does not write to the ECU/i).length
    ).toBeGreaterThanOrEqual(1);

    await act(async () => {
      screen
        .getAllByRole("button", { name: /delete component/i })
        .forEach((btn) => fireEvent.click(btn));
    });
    expect(commandMock()).not.toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "delete_component" })
    );
    expect(commandMock()).not.toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "restore_component" })
    );
  });

  test("renders the safety scope and performance mods catalog", () => {
    expect(screen.getByText(/Safety Scope/i)).toBeVisible();
    expect(screen.getByText(/Steering \(EPS\)/i)).toBeVisible();
    expect(screen.getByText(/Brakes \(ABS \/ ESP \/ EPB\)/i)).toBeVisible();
    expect(screen.getByText(/Airbag \/ belt tensioners \(SRS\)/i)).toBeVisible();
    expect(screen.getByText(/Performance Mods/i)).toBeVisible();
    expect(screen.getByText("Stage 1 calibration")).toBeVisible();
    expect(screen.getByText(/Rev limiter \+300 rpm/i)).toBeVisible();
    // Nothing can ever be applied by this app — no active badge, no revert
    expect(screen.queryByText(/^Applied$/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /revert to stock/i })
    ).toBeNull();
  });

  test("mod controls are disabled — mods are applied by bench flashing", async () => {
    // Even with a session running, this app never writes: apply controls
    // stay disabled and send nothing, and nothing is ever "applied".
    screen
      .getAllByRole("button", { name: /apply mod/i })
      .forEach((btn) => expect(btn).toBeDisabled());

    await act(async () => {
      dashboardListener()(CONNECTED_STATUS);
    });

    screen
      .getAllByRole("button", { name: /apply mod/i })
      .forEach((btn) => expect(btn).toBeDisabled());
    expect(
      screen.queryByRole("button", { name: /revert to stock/i })
    ).toBeNull();
    expect(screen.queryByText(/^Applied$/)).toBeNull();
    expect(
      screen.getAllByText(/applied by bench flashing/i).length
    ).toBeGreaterThanOrEqual(1);

    await act(async () => {
      screen
        .getAllByRole("button", { name: /apply mod/i })
        .forEach((btn) => fireEvent.click(btn));
    });
    expect(commandMock()).not.toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "apply_mod" })
    );
    expect(commandMock()).not.toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "revert_mod" })
    );
  });

  test("renders cluster tell-tales driven by codes and live data", () => {
    // Mock session: P0299 stored, coolant 64°C, battery 14.0V
    const mil = screen.getByRole("img", { name: /check engine/i });
    expect(mil).toHaveAttribute("data-state", "on");
    expect(mil).toHaveAttribute("title", "Stored fault codes (P0299)");
    expect(screen.getByRole("img", { name: /glow plugs/i })).toHaveAttribute(
      "data-state",
      "off"
    );
    expect(screen.getByRole("img", { name: /^DPF/i })).toHaveAttribute(
      "data-state",
      "off"
    );
    expect(screen.getByRole("img", { name: /battery/i })).toHaveAttribute(
      "data-state",
      "off"
    );
    expect(screen.getByRole("img", { name: /coolant/i })).toHaveAttribute(
      "data-state",
      "off"
    );
  });

  test("renders the sign-off verification checklist", () => {
    expect(screen.getByText("Sign-off Verification")).toBeVisible();
    // Nothing was applied by this app — the verdict is inconclusive, and
    // "PASSED" must not appear: it would read as a verified tune.
    expect(screen.getByText("NOT VERIFIED")).toBeVisible();
    expect(screen.queryByText(/^PASSED$/)).toBeNull();
    expect(screen.queryByText(/^FAILED$/)).toBeNull();
    expect(screen.getByText("No new fault codes introduced")).toBeVisible();
    expect(screen.getByText(/Applied state read-back/i)).toBeVisible();
  });

  test("a pass verdict renders PASSED and a fail verdict renders FAILED", async () => {
    const base = {
      type: "verification" as const,
      source: "ecu" as const,
      dutyProfile: "Standard (tow-capable)",
      items: [
        { check: "No new fault codes introduced", status: "pass" as const, detail: "0 known code(s), none new this session" },
      ],
      timestamp: "2026-08-15T03:00:02.000Z",
    };

    await act(async () => {
      dashboardListener()({ ...base, verdict: "fail" });
    });
    expect(screen.getByText(/^FAILED$/)).toBeVisible();

    await act(async () => {
      dashboardListener()({ ...base, verdict: "pass" });
    });
    expect(screen.getByText(/^PASSED$/)).toBeVisible();
    expect(screen.queryByText("NOT VERIFIED")).toBeNull();
  });

  test("Verify & Sign Off sends the command once a session is running", async () => {
    expect(
      screen.getByRole("button", { name: /verify & sign off/i })
    ).toBeDisabled();

    await act(async () => {
      dashboardListener()(CONNECTED_STATUS);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /verify & sign off/i }));
    });

    await waitFor(() => {
      expect(commandMock()).toHaveBeenCalledWith({
        cmd: "verify_changes",
        dutyProfile: "standard",
      });
    });
  });

  test("the duty profile selector changes what verification receives", async () => {
    await act(async () => {
      dashboardListener()(CONNECTED_STATUS);
    });

    fireEvent.change(screen.getByLabelText("Duty profile"), {
      target: { value: "no_tow" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /verify & sign off/i }));
    });

    await waitFor(() => {
      expect(commandMock()).toHaveBeenCalledWith({
        cmd: "verify_changes",
        dutyProfile: "no_tow",
      });
    });
  });

  test("verification is honest about its source and shows the factory envelope", () => {
    expect(screen.getByText("re-read from ECU")).toBeVisible();
    expect(screen.getByText(/duty: Standard \(tow-capable\)/i)).toBeVisible();
    expect(screen.getByText(/vs ceilings 715 \/ 700 Nm/i)).toBeVisible();
    expect(
      screen.getByText(/550 stock · 580 VW transient · 620 single-turbo Audi/i)
    ).toBeVisible();
    // Checks that evaluated nothing are SKIP, not a fake PASS — no deletes
    // active, nothing applied, and this app never writes
    expect(screen.getAllByText(/^SKIP$/).length).toBeGreaterThanOrEqual(3);
    expect(
      screen.getByText(/no deletes active — nothing to check/i)
    ).toBeVisible();
    expect(
      screen.getByText(/Calibration changes applied this session/i)
    ).toBeVisible();
    expect(
      screen.getByText(/this app does not write to the ECU/i)
    ).toBeVisible();
  });

  test("renders the probed live DID map in the ECU card", () => {
    expect(screen.getByText(/Live DID map \(UDS 0x22 probe\)/i)).toBeVisible();
    expect(screen.getByText("0xF484")).toBeVisible(); // adopted rail-pressure DID
    expect(screen.getByText("railPressureBar")).toBeVisible();
    expect(screen.getByText("community EDC17 table (x0.1 bar)")).toBeVisible();
    // corrected ISO 15031-5 mirror: speed is PID 0x0D, never 0x0B
    expect(screen.getByText("speedKph")).toBeVisible();
    expect(screen.getByText("0xF40D")).toBeVisible();
    expect(screen.queryByText("0xF40B")).toBeNull();
  });

  test("backs up the stock ECU: button sends the read command, path is shown", async () => {
    expect(
      screen.getByRole("button", { name: /read & back up/i })
    ).toBeDisabled();

    await act(async () => {
      dashboardListener()(CONNECTED_STATUS);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /read & back up/i }));
    });

    await waitFor(() => {
      expect(commandMock()).toHaveBeenCalledWith({ cmd: "read_ecu_backup" });
    });
    // Mock session replayed a completed backup: show the persisted file.
    expect(screen.getByText(/Backup saved/i)).toBeVisible();
    expect(screen.getByText(/ecu-backup-2026-08-16\.bin/i)).toBeVisible();
    expect(
      screen.getByText(/sha256 a3f5c7d9b1e02468/i)
    ).toBeVisible();
  });

  test("an empty DTC read with a live session is a genuine clean result", async () => {
    // [] means the ECU answered the 0x19 read with zero faults — distinct
    // from null (never read), and it SHOULD still say so.
    await act(async () => {
      dashboardListener()(CONNECTED_STATUS);
      dashboardListener()({ type: "dtc", codes: [] });
    });

    expect(screen.getByText("No fault codes stored.")).toBeVisible();
    expect(
      screen.getByText(/All tell-tales off — no active warnings/i)
    ).toBeVisible();
  });

  test("session end resets a clean read back to the no-data state", async () => {
    await act(async () => {
      dashboardListener()(CONNECTED_STATUS);
      dashboardListener()({ type: "dtc", codes: [] });
    });
    expect(screen.getByText("No fault codes stored.")).toBeVisible();

    await act(async () => {
      dashboardListener()({
        type: "status",
        phase: "disconnected",
        message: "Session stopped by user.",
        mode: "live",
      });
    });

    // The stale "clean" result must not persist after the session drops.
    expect(screen.queryByText(/No fault codes stored/i)).toBeNull();
    expect(screen.queryByText(/no active warnings/i)).toBeNull();
    expect(
      screen.getAllByText(/No data — connect an interface/i).length
    ).toBeGreaterThanOrEqual(1);
  });

  test("coolant tell-tale turns blue when cold and red when overheating", async () => {
    // Cold engine: preheat also lights the glow-plug lamp
    await act(async () => {
      dashboardListener()({
        type: "live",
        values: {
          rpm: 790, speedKph: 0, coolantTempC: 18, intakeTempC: 20,
          boostPressureKpa: 99, pedalPct: 0.8, engineLoadPct: 21,
          batteryV: 14.0, railPressureBar: 290,
        },
        timestamp: "2026-08-15T04:00:00.000Z",
      });
    });
    expect(screen.getByRole("img", { name: /coolant/i })).toHaveAttribute(
      "data-state",
      "on"
    );
    expect(screen.getByRole("img", { name: /glow plugs/i })).toHaveAttribute(
      "data-state",
      "on"
    );

    await act(async () => {
      dashboardListener()({
        type: "live",
        values: {
          rpm: 790, speedKph: 0, coolantTempC: 108, intakeTempC: 60,
          boostPressureKpa: 99, pedalPct: 5, engineLoadPct: 30,
          batteryV: 13.8, railPressureBar: 400,
        },
        timestamp: "2026-08-15T04:00:02.000Z",
      });
    });
    const coolant = screen.getByRole("img", { name: /coolant/i });
    expect(coolant).toHaveAttribute("data-state", "on");
    expect(coolant.getAttribute("title")).toContain("Overheating");
  });
});

describe("No J2534 interface attached", () => {
  beforeEach(async () => {
    cleanup();
    mockState.replaySession = false;
    await act(async () => {
      render(<App />);
    });
  });

  test("explains no interface is connected and what is needed", () => {
    expect(screen.getByText(/No interface connected/i)).toBeVisible();
    expect(
      screen.getByText(/attach a J2534 pass-thru device/i)
    ).toBeVisible();
    expect(screen.getByText(/No session started yet/i)).toBeVisible();
    expect(screen.getAllByText("Not connected").length).toBeGreaterThanOrEqual(1);
  });

  test("panels show unavailable states — never fabricated vehicle data", () => {
    expect(screen.getByText(/No data — not connected/i)).toBeVisible();
    expect(
      screen.getByText(/No ECU data — connect a J2534 interface/i)
    ).toBeVisible();
    expect(
      screen.getByText(/Start a session to load the deletion catalog/i)
    ).toBeVisible();
    // No invented telemetry may appear: no fake VIN, DTCs or mod state.
    expect(screen.queryByText(/WV1ZZZ/)).toBeNull();
    expect(screen.queryByText("P0299")).toBeNull();
    expect(screen.queryByText(/Stage 1 calibration/)).toBeNull();
    // Absence of data must never render as an affirmative claim about the
    // vehicle — these exact strings previously asserted a clean bill of
    // health with zero evidence.
    expect(screen.queryByText(/no active warnings/i)).toBeNull();
    expect(screen.queryByText(/No fault codes stored/i)).toBeNull();
    expect(
      screen.getAllByText(/No data — connect an interface/i).length
    ).toBeGreaterThanOrEqual(1);
  });

  test("Start Session surfaces the genuine transport error", async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start session/i }));
    });
    await waitFor(() => {
      expect(startMock()).toHaveBeenCalledWith();
    });

    // The monitor reports the real J2534Transport.open() failure verbatim.
    await act(async () => {
      dashboardListener()({
        type: "status",
        phase: "error",
        message: J2534_MISSING,
        mode: "live",
      });
    });

    expect(screen.getByText("Error")).toBeVisible();
    // The verbatim transport error reaches both the error banner and the
    // Session status line — it is never replaced by a generic message.
    expect(
      screen.getAllByText(J2534_MISSING).length
    ).toBeGreaterThanOrEqual(2);
  });
});
