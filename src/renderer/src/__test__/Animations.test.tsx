import "@testing-library/jest-dom";
import "./utils/window.mock";
import { render, screen } from "./utils";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import ConnectionProgress, { connectionStep } from "@/components/dashboard/ConnectionProgress";
import EcuInfoCard from "@/components/dashboard/EcuInfoCard";

afterEach(() => cleanup());

const INFO = {
  protocol: "ISO 15765-4",
  requestId: "0x7E0",
  responseId: "0x7E8",
  ecuName: "Engine",
  partNumber: null,
  swVersion: null,
  hwVersion: null,
  serial: null,
  coding: null,
  vin: "WV1ZZZ2H0JW123456",
};

describe("connecting animation follows real events only", () => {
  test.each([
    [{ phase: "starting", hasInfo: false, hasDids: false, hasLive: false }, 0],
    [{ phase: "connecting", hasInfo: false, hasDids: false, hasLive: false }, 1],
    [{ phase: "connected", hasInfo: false, hasDids: false, hasLive: false }, 2],
    [{ phase: "connected", hasInfo: true, hasDids: false, hasLive: false }, 3],
    [{ phase: "connected", hasInfo: true, hasDids: true, hasLive: false }, 4],
  ] as const)("%o -> step %i", (signals, step) => {
    expect(connectionStep(signals)).toBe(step);
  });

  test("marks done steps, the current step, and says where it is", () => {
    render(<ConnectionProgress phase="connected" hasInfo hasDids={false} hasLive={false} />);
    const steps = screen.getByRole("list", { name: "Connection progress" });
    expect(steps).toHaveTextContent("Opening the cable, done");
    expect(steps).toHaveTextContent("Mapping live data channels, in progress");
    expect(screen.getByText(/step 4 of 5/)).toBeVisible();
  });
});

describe("ECU backup memory map", () => {
  test("fills in proportion to bytes read, as an accessible progressbar", () => {
    render(
      <EcuInfoCard
        info={INFO}
        flash={{ type: "flash", phase: "progress", bytes: 32768, totalBytes: 65536 }}
        running
        onBackup={() => {}}
      />
    );
    expect(screen.getByRole("progressbar", { name: "ECU backup progress" })).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("32 kB / 64 kB (50%)")).toBeVisible();
  });

  test("before any bytes arrive it shows an indeterminate sweep, not a fake %", () => {
    render(<EcuInfoCard info={INFO} flash={{ type: "flash", phase: "start" }} running onBackup={() => {}} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("button", { name: /Reading…/ })).toBeDisabled();
  });
});

test("the channel map counts answered channels", () => {
  render(
    <EcuInfoCard
      info={INFO}
      dids={[
        { channel: "rpm", did: "0xF40C", ok: true, value: 790, note: "" },
        { channel: "boost", did: "0xF4A3", ok: false, value: null, note: "" },
      ]}
    />
  );
  expect(screen.getByText("1 of 2 channels answered")).toBeVisible();
});
