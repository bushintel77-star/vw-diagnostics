import "@testing-library/jest-dom";
import "./utils/window.mock";
import { render, screen, fireEvent, waitFor } from "./utils";
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

/** The listener App registered via onDiagnosticEvent. */
const dashboardListener = (): DiagnosticEventListener =>
  subscribeMock().mock.calls[0][0];

describe("Testing the VW diagnostic dashboard", () => {
  beforeEach(async () => {
    startMock().mockClear();
    stopMock().mockClear();
    commandMock().mockClear();
    subscribeMock().mockClear();
    await act(async () => {
      render(<App />);
    });
  });

  test("renders the dashboard shell with replayed session data", () => {
    expect(screen.getByText(/VW Diagnostic Dashboard/i)).toBeVisible();
    expect(screen.getByText(/^Simulation$/)).toBeVisible(); // session mode badge
    expect(screen.getByText(/Not connected/i)).toBeVisible();
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

  test("defaults to simulation mode and starts the monitor on click", async () => {
    expect(screen.getByLabelText("Simulation mode")).toBeChecked();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start session/i }));
    });

    await waitFor(() => {
      expect(startMock()).toHaveBeenCalledWith({ simulate: true });
    });
  });

  test("honors unchecking simulation mode", async () => {
    fireEvent.click(screen.getByLabelText("Simulation mode"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start session/i }));
    });

    await waitFor(() => {
      expect(startMock()).toHaveBeenCalledWith({ simulate: false });
    });
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
      dashboardListener()({
        type: "status",
        phase: "simulated",
        message: "Simulation active",
        mode: "simulate",
      });
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
    // exhaust flap is active in the mock session
    expect(screen.getByText(/^Coded out$/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /restore stock coding/i })).toBeVisible();
  });

  test("deleting a component requires confirmation and sends the command", async () => {
    // No running session yet: delete buttons disabled
    expect(
      screen.getByRole("button", { name: /delete component/i })
    ).toBeDisabled();

    await act(async () => {
      dashboardListener()({
        type: "status",
        phase: "simulated",
        message: "Simulation active",
        mode: "simulate",
      });
    });

    // First click only arms the confirmation
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /delete component/i }));
    });
    expect(commandMock()).not.toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "delete_component" })
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /confirm \(off-road use\)/i })
      );
    });

    await waitFor(() => {
      expect(commandMock()).toHaveBeenCalledWith({
        cmd: "delete_component",
        componentId: "egr",
      });
    });
  });

  test("restoring a coded-out component sends the command", async () => {
    await act(async () => {
      dashboardListener()({
        type: "status",
        phase: "simulated",
        message: "Simulation active",
        mode: "simulate",
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /restore stock coding/i }));
    });

    await waitFor(() => {
      expect(commandMock()).toHaveBeenCalledWith({
        cmd: "restore_component",
        componentId: "start_stop_memory",
      });
    });
  });

  test("renders the safety scope and performance mods catalog", () => {
    expect(screen.getByText(/Safety Scope/i)).toBeVisible();
    expect(screen.getByText(/Steering \(EPS\)/i)).toBeVisible();
    expect(screen.getByText(/Brakes \(ABS \/ ESP \/ EPB\)/i)).toBeVisible();
    expect(screen.getByText(/Airbag \/ belt tensioners \(SRS\)/i)).toBeVisible();
    expect(screen.getByText(/Performance Mods/i)).toBeVisible();
    expect(screen.getByText("Stage 1 calibration")).toBeVisible();
    expect(screen.getByText(/Rev limiter \+300 rpm/i)).toBeVisible();
    expect(screen.getByText(/^Applied$/)).toBeVisible(); // stage1 active
    expect(screen.getByRole("button", { name: /revert to stock/i })).toBeVisible();
  });

  test("applying a performance mod requires confirmation and sends the command", async () => {
    expect(screen.getByRole("button", { name: /apply mod/i })).toBeDisabled();

    await act(async () => {
      dashboardListener()({
        type: "status",
        phase: "simulated",
        message: "Simulation active",
        mode: "simulate",
      });
    });

    // First click only arms the confirmation
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /apply mod/i }));
    });
    expect(commandMock()).not.toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "apply_mod" })
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm apply/i }));
    });

    await waitFor(() => {
      expect(commandMock()).toHaveBeenCalledWith({
        cmd: "apply_mod",
        modId: "rev_limit",
      });
    });
  });

  test("reverting an applied mod sends the command", async () => {
    await act(async () => {
      dashboardListener()({
        type: "status",
        phase: "simulated",
        message: "Simulation active",
        mode: "simulate",
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /revert to stock/i }));
    });

    await waitFor(() => {
      expect(commandMock()).toHaveBeenCalledWith({
        cmd: "revert_mod",
        modId: "stage1",
      });
    });
  });

  test("renders the dyno pull graphs with before/after comparison", () => {
    expect(screen.getByText(/Performance Graphs — Dyno Pull/i)).toBeVisible();
    // latest pull peaks (stage1 mock, real TDI550 tuner figures)
    expect(screen.getByText(/228 kW \(306 hp\)/i)).toBeVisible();
    expect(screen.getByText(/680 Nm @ 2,000 rpm/i)).toBeVisible();
    // delta row between stock and stage1 pulls
    expect(screen.getByText(/\+62\.0 kW power/i)).toBeVisible();
    expect(screen.getByText(/\+130 Nm torque/i)).toBeVisible();
    // pull history chips
    expect(screen.getByText(/#1 · Stock · 166 kW/i)).toBeVisible();
    expect(screen.getByText(/#2 · stage1 · 228 kW/i)).toBeVisible();
    // simulated-reference honesty label
    expect(screen.getByText(/Simulated reference curves/i)).toBeVisible();
  });

  test("running a dyno pull sends the command once a session is active", async () => {
    expect(screen.getByRole("button", { name: /run dyno pull/i })).toBeDisabled();

    await act(async () => {
      dashboardListener()({
        type: "status",
        phase: "simulated",
        message: "Simulation active",
        mode: "simulate",
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /run dyno pull/i }));
    });

    await waitFor(() => {
      expect(commandMock()).toHaveBeenCalledWith({ cmd: "run_pull" });
    });
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
    expect(screen.getByText(/^PASSED$/)).toBeVisible();
    expect(screen.getByText("No new fault codes introduced")).toBeVisible();
    expect(screen.getByText(/Applied state read-back/i)).toBeVisible();
  });

  test("Verify & Sign Off sends the command once a session is running", async () => {
    expect(
      screen.getByRole("button", { name: /verify & sign off/i })
    ).toBeDisabled();

    await act(async () => {
      dashboardListener()({
        type: "status",
        phase: "simulated",
        message: "Simulation active",
        mode: "simulate",
      });
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
      dashboardListener()({
        type: "status",
        phase: "simulated",
        message: "Simulation active",
        mode: "simulate",
      });
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
    expect(screen.getByText("simulated self-check")).toBeVisible();
    expect(screen.getByText(/duty: Standard \(tow-capable\)/i)).toBeVisible();
    expect(screen.getByText(/vs ceilings 715 \/ 700 Nm/i)).toBeVisible();
    expect(
      screen.getByText(/550 stock · 580 VW transient · 620 single-turbo Audi/i)
    ).toBeVisible();
    // An un-run pull check is SKIP, not a fake PASS
    expect(screen.getByText(/^SKIP$/)).toBeVisible();
    expect(
      screen.getByText(/no dyno pull this session — run one before sign-off/i)
    ).toBeVisible();
  });

  test("renders the probed live DID map in the ECU card", () => {
    expect(screen.getByText(/Live DID map \(UDS 0x22 probe\)/i)).toBeVisible();
    expect(screen.getByText("0xF484")).toBeVisible(); // adopted rail-pressure DID
    expect(screen.getByText("railPressureBar")).toBeVisible();
    expect(screen.getByText("community EDC17 table (x0.1 bar)")).toBeVisible();
  });

  test("backs up the stock ECU: button sends the read command, path is shown", async () => {
    expect(
      screen.getByRole("button", { name: /read & back up/i })
    ).toBeDisabled();

    await act(async () => {
      dashboardListener()({
        type: "status",
        phase: "simulated",
        message: "Simulation active",
        mode: "simulate",
      });
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

  test("shows the live-fallback banner with retry when simulation was not requested", async () => {
    // Request LIVE by unticking simulation, then start.
    fireEvent.click(screen.getByLabelText("Simulation mode"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start session/i }));
    });
    expect(startMock()).toHaveBeenCalledWith({ simulate: false });

    await act(async () => {
      dashboardListener()({
        type: "status",
        phase: "simulated",
        message: "pyj2534 is not installed — falling back to simulation",
        mode: "simulate",
      });
    });

    expect(screen.getByText(/requested a LIVE connection/i)).toBeVisible();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /retry live/i }));
    });
    await waitFor(() => {
      expect(startMock()).toHaveBeenCalledWith({ simulate: false });
    });
  });

  test("renders the 710 Nm overboost overlay on a stage-1 pull", () => {
    expect(screen.getByText("10-s overboost 710 Nm")).toBeVisible();
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
