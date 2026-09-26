import "@testing-library/jest-dom";
import "./utils/window.mock";
import { render, screen } from "./utils";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import KeyNumbers, { KeyChannel, foldStats } from "@/components/dashboard/KeyNumbers";
import StatusBar from "@/components/dashboard/StatusBar";
import { LiveValues } from "@shared/types";

afterEach(() => cleanup());

const COOLANT: KeyChannel = { key: "coolantTempC", label: "Coolant", unit: "°C", min: 0, max: 120, warnAt: 105, dangerAt: 115 };
const live = (patch: Partial<LiveValues>): LiveValues =>
  ({ rpm: null, speedKph: null, coolantTempC: null, intakeTempC: null, boostPressureKpa: null, pedalPct: null, engineLoadPct: null, batteryV: null, railPressureBar: null, ...patch }) as LiveValues;

describe("key numbers", () => {
  test("session min/max fold only real readings", () => {
    let stats = foldStats({}, live({ coolantTempC: 80 }), ["coolantTempC"]);
    stats = foldStats(stats, live({ coolantTempC: 95 }), ["coolantTempC"]);
    stats = foldStats(stats, live({ coolantTempC: null }), ["coolantTempC"]);
    expect(stats.coolantTempC).toEqual({ min: 80, max: 95 });
  });

  test("colour marks real limits only, with the number itself", () => {
    const { rerender } = render(<KeyNumbers channels={[COOLANT]} live={live({ coolantTempC: 90 })} stats={{}} stale={false} />);
    expect(screen.getByText("90")).not.toHaveClass("text-destructive");
    expect(screen.queryByText("High")).toBeNull();
    rerender(<KeyNumbers channels={[COOLANT]} live={live({ coolantTempC: 108 })} stats={{}} stale={false} />);
    expect(screen.getByText("High")).toBeVisible();
    rerender(<KeyNumbers channels={[COOLANT]} live={live({ coolantTempC: 118 })} stats={{}} stale={false} />);
    expect(screen.getByText("118")).toHaveClass("text-destructive");
    // Never colour alone: the limit is also stated in words.
    expect(screen.getByText("Limit")).toBeVisible();
  });

  test("no reading shows a dash, never a number", () => {
    render(<KeyNumbers channels={[COOLANT]} live={null} stats={{}} stale={false} />);
    expect(screen.getByText("—")).toBeVisible();
    expect(screen.getByText("min —")).toBeVisible();
  });
});

describe("status bar", () => {
  test("shows link state, rate and session clock", () => {
    render(
      <StatusBar
        status={{ type: "status", phase: "connected", message: "", mode: "live" }}
        info={null}
        sampleHz={2}
        sessionSeconds={3725}
        dataAgeSeconds={0}
        stale={false}
      />
    );
    const bar = screen.getByRole("group", { name: "Session status" });
    expect(bar).toHaveTextContent("LIVE");
    expect(bar).toHaveTextContent("2.0 Hz");
    expect(bar).toHaveTextContent("01:02:05");
  });

  test("a stale connection is called stale, not live", () => {
    render(
      <StatusBar
        status={{ type: "status", phase: "connected", message: "", mode: "live" }}
        info={null}
        sampleHz={0}
        sessionSeconds={10}
        dataAgeSeconds={9}
        stale
      />
    );
    expect(screen.getByRole("group", { name: "Session status" })).toHaveTextContent("STALE");
  });
});
