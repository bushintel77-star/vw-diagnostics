import "@testing-library/jest-dom";
import "../utils/window.mock";
import { READY_MACHINE } from "../utils/window.mock";
import { render, screen, fireEvent, waitFor } from "../utils";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import CableSetupWizard from "@/components/setup/CableSetupWizard";
import { CableSetupController } from "@/components/setup/useCableSetup";
import { CableSetupStatus, DriverInstallResult, DriverUnlockResult } from "@shared/types";

const unlockMock = () => window.context.unlockDriver as ReturnType<typeof vi.fn>;
const installMock = () => window.context.installDriver as ReturnType<typeof vi.fn>;

const controller = (status: CableSetupStatus | null, patch: Partial<CableSetupController> = {}): CableSetupController => ({
  status,
  checking: false,
  open: true,
  justConnected: false,
  openWizard: vi.fn(),
  closeWizard: vi.fn(),
  recheck: vi.fn(),
  ...patch,
});

const machine = (patch: Partial<CableSetupStatus>): CableSetupStatus => ({ ...READY_MACHINE, ...patch });
const NEEDS_DRIVER = machine({ driverInstalled: false, driverBundled: true });

const renderWizard = async (ctl: CableSetupController, props: { sessionActive?: boolean; onStartSession?: () => void } = {}) => {
  await act(async () => {
    render(
      <CableSetupWizard
        controller={ctl}
        sessionActive={props.sessionActive ?? false}
        onStartSession={props.onStartSession ?? vi.fn()}
      />
    );
  });
};

beforeEach(() => {
  unlockMock().mockReset();
  installMock().mockReset();
});
afterEach(() => cleanup());

describe("dialog behaviour", () => {
  test("is a labelled modal dialog that takes focus", async () => {
    await renderWizard(controller(machine({})));
    const dialog = screen.getByRole("dialog", { name: "Cable setup" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription(/Nothing on the truck is touched/);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  test("Escape and the close button both close it", async () => {
    const ctl = controller(machine({}));
    await renderWizard(ctl);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close cable setup" }));
    expect(ctl.closeWizard).toHaveBeenCalledTimes(2);
  });

  test("Tab is trapped inside the dialog", async () => {
    await renderWizard(controller(machine({})));
    const buttons = screen.getAllByRole("button");
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  test("renders nothing while closed", async () => {
    await renderWizard(controller(machine({}), { open: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("shows progress and self-checks with text, not colour alone", async () => {
    await renderWizard(controller(machine({})));
    expect(screen.getByRole("list", { name: "Setup progress" })).toHaveTextContent(/Plug in, in progress/);
    expect(screen.getByRole("list", { name: "Self-checks" })).toHaveTextContent(/Cable: waiting\./);
    expect(screen.getByText("Watching for your cable…")).toBeVisible();
  });
});

describe("passkey-gated driver install", () => {
  test("the unlock button stays disabled until something is typed", async () => {
    await renderWizard(controller(NEEDS_DRIVER));
    const submit = screen.getByRole("button", { name: /Unlock and install/ });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Passkey"), { target: { value: "x" } });
    expect(submit).toBeEnabled();
  });

  test("the passkey field focuses itself and can be shown or hidden", async () => {
    await renderWizard(controller(NEEDS_DRIVER));
    const field = screen.getByLabelText("Passkey");
    expect(document.activeElement).toBe(field);
    expect(field).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Show passkey" }));
    expect(field).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide passkey" })).toHaveAttribute("aria-pressed", "true");
  });

  test("a wrong passkey explains tries left, clears the field and marks it invalid", async () => {
    unlockMock().mockResolvedValue({ ok: false, reason: "bad_passkey", message: "no", attemptsLeft: 1 } satisfies DriverUnlockResult);
    await renderWizard(controller(NEEDS_DRIVER));
    const field = screen.getByLabelText("Passkey");
    fireEvent.change(field, { target: { value: "wrong" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Unlock and install/ }));
    });
    expect(unlockMock()).toHaveBeenCalledWith("wrong");
    expect(screen.getByRole("alert")).toHaveTextContent("That passkey isn't right. 1 try left before a short lockout.");
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(/That passkey isn't right/);
    expect(installMock()).not.toHaveBeenCalled();
  });

  test("a lockout disables the field and shows the countdown", async () => {
    unlockMock().mockResolvedValue({ ok: false, reason: "locked", message: "locked", lockedForSeconds: 42 } satisfies DriverUnlockResult);
    await renderWizard(controller(NEEDS_DRIVER));
    fireEvent.change(screen.getByLabelText("Passkey"), { target: { value: "wrong" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Unlock and install/ }));
    });
    expect(screen.getByLabelText("Passkey")).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("(42s)");
  });

  test("a lockout that is already running shows on open", async () => {
    await renderWizard(controller(machine({ ...NEEDS_DRIVER, lockedForSeconds: 20 })));
    expect(screen.getByLabelText("Passkey")).toBeDisabled();
  });

  test("unlock launches the installer with guidance, and a declined Windows prompt can be retried without the passkey", async () => {
    let finish: (result: DriverInstallResult) => void = () => {};
    unlockMock().mockResolvedValue({ ok: true });
    installMock().mockImplementation(() => new Promise<DriverInstallResult>((resolve) => (finish = resolve)));
    await renderWizard(controller(NEEDS_DRIVER));
    fireEvent.change(screen.getByLabelText("Passkey"), { target: { value: "right" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Unlock and install/ }));
    });
    expect(screen.getByText("Finish the installer")).toBeVisible();
    expect(screen.getByText(/Choose Yes/)).toBeVisible();

    await act(async () => finish({ ok: false, reason: "declined", message: "cancelled" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/You chose No on the Windows prompt/);
    expect(screen.queryByLabelText("Passkey")).toBeNull();
    installMock().mockResolvedValue({ ok: true, message: "Driver installed." });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(installMock()).toHaveBeenCalledTimes(2);
  });

  test("a successful install re-runs the self-checks", async () => {
    const ctl = controller(NEEDS_DRIVER);
    unlockMock().mockResolvedValue({ ok: true });
    installMock().mockResolvedValue({ ok: true, message: "Driver installed." });
    await renderWizard(ctl);
    fireEvent.change(screen.getByLabelText("Passkey"), { target: { value: "right" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Unlock and install/ }));
    });
    await waitFor(() => expect(ctl.recheck).toHaveBeenCalled());
    expect(screen.getByText("Driver installed")).toBeVisible();
  });

  test("an expired unlock asks for the passkey again", async () => {
    installMock().mockResolvedValue({ ok: false, reason: "not_unlocked", message: "Enter the passkey first." });
    await renderWizard(controller(machine({ ...NEEDS_DRIVER, unlocked: true })));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install driver" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("For safety, enter the passkey again.");
    expect(screen.getByLabelText("Passkey")).toBeVisible();
  });

  test("a public build gives manual steps and never asks for a passkey", async () => {
    await renderWizard(controller(machine({ driverInstalled: false, driverBundled: false })));
    expect(screen.queryByLabelText("Passkey")).toBeNull();
    expect(screen.getByText(/openport2_setup_1004341\.exe/)).toBeVisible();
    expect(screen.getByText(/Don't install newer Tactrix software/)).toBeVisible();
    expect(screen.getByText("Watching for the driver…")).toBeVisible();
  });
});

describe("blocked and ready states", () => {
  test("Windows 11 Code 39 shows the block, the safe options, and no security workaround", async () => {
    await renderWizard(controller(machine({ windowsBuild: 26200, cable: "blocked", cableProblemCode: 39 })));
    expect(screen.getByRole("heading", { name: "Windows 11 is blocking this cable's driver" })).toBeVisible();
    expect(screen.getByText(/Use a Windows 10 computer/)).toBeVisible();
    expect(screen.getByText(/Don't turn off Windows security features/)).toBeVisible();
    const actions = screen.getAllByRole("button").map((button) => button.textContent ?? "");
    expect(actions.join(" ")).not.toMatch(/disable|turn off|test sign/i);
  });

  test("ready offers Start session and hands over to the dashboard", async () => {
    const start = vi.fn();
    await renderWizard(
      controller(machine({ cable: "ready", preflight: { ready: true, message: "ok", bitness: 32, python: "py" } })),
      { onStartSession: start }
    );
    expect(screen.getByRole("heading", { name: "Your cable is ready" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    expect(start).toHaveBeenCalledTimes(1);
  });

  test("no second session is offered while one is running", async () => {
    await renderWizard(controller(machine({ cable: "ready" })), { sessionActive: true });
    expect(screen.queryByRole("button", { name: "Start session" })).toBeNull();
    expect(screen.getByText("A session is already running.")).toBeVisible();
  });

  test("Check again runs the full self-check and shows progress", async () => {
    const ctl = controller(machine({}), { checking: true });
    await renderWizard(ctl);
    expect(screen.getByRole("button", { name: /Checking…/ })).toBeDisabled();
  });
});
