import "@testing-library/jest-dom";
import "../utils/window.mock";
import { READY_MACHINE, mockState } from "../utils/window.mock";
import { render, screen, fireEvent, waitFor } from "../utils";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import App from "@/App";

// Plug-and-play: the dashboard opens cable setup by itself when something
// needs fixing, and stays out of the way when the machine is fine.

const statusMock = () => window.context.getCableSetupStatus as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockState.replaySession = false;
  statusMock().mockReset();
  window.localStorage.setItem("vwd.guide", JSON.stringify({ open: false, x: 24, y: 90, stage: null }));
});
afterEach(() => {
  cleanup();
  statusMock().mockReset();
  statusMock().mockImplementation(() => Promise.resolve(READY_MACHINE));
  mockState.replaySession = true;
});

const renderApp = async () => {
  await act(async () => {
    render(<App />);
  });
};

describe("cable setup on the dashboard", () => {
  test("a missing driver opens the wizard by itself and runs the full check", async () => {
    statusMock().mockResolvedValue({ ...READY_MACHINE, driverInstalled: false });
    await renderApp();
    expect(await screen.findByRole("dialog", { name: "Cable setup" })).toBeVisible();
    await waitFor(() => expect(statusMock()).toHaveBeenCalledWith({ full: true }));
  });

  test("a set-up machine with the cable unplugged stays quiet", async () => {
    statusMock().mockResolvedValue(READY_MACHINE);
    await renderApp();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /Cable not plugged in\. Open cable setup/ })).toBeVisible();
  });

  test("closing the wizard doesn't reopen it for the same problem", async () => {
    statusMock().mockResolvedValue({ ...READY_MACHINE, driverInstalled: false });
    await renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Finish later" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    // The header chip reopens it on demand.
    fireEvent.click(screen.getByRole("button", { name: /Driver needed\. Open cable setup/ }));
    expect(await screen.findByRole("dialog")).toBeVisible();
  });

  test("a ready cable turns the empty-state card into the next step", async () => {
    statusMock().mockResolvedValue({ ...READY_MACHINE, cable: "ready" });
    await renderApp();
    expect(screen.getByText(/Cable ready — plug it into the truck's OBD port/)).toBeVisible();
    expect(screen.queryByText(/No interface connected/)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("the browser demo hides cable setup entirely", async () => {
    statusMock().mockResolvedValue({ ...READY_MACHINE, platformSupported: false, cable: "unknown" });
    await renderApp();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /Open cable setup/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set up cable" })).toBeNull();
  });
});
