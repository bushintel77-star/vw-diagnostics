import "@testing-library/jest-dom";
import "./utils/window.mock";
import { render, screen, fireEvent } from "./utils";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import VersionBadge from "@/components/dashboard/VersionBadge";
import { UpdateCheckResult } from "@shared/types";

const checkMock = () => window.context.checkForUpdate as ReturnType<typeof vi.fn>;
const openMock = () => window.context.openUpdateDownload as ReturnType<typeof vi.fn>;

const renderWith = async (result: UpdateCheckResult) => {
  checkMock().mockResolvedValueOnce(result);
  await act(async () => {
    render(<VersionBadge />);
  });
};

afterEach(() => cleanup());

describe("version badge", () => {
  test("says Latest only after a successful check", async () => {
    await renderWith({ status: "current", currentVersion: "1.3.0" });
    expect(screen.getByText("v1.3.0 · Latest")).toBeVisible();
  });

  test("offers the update when a newer release exists", async () => {
    await renderWith({
      status: "available",
      currentVersion: "1.3.0",
      latestVersion: "1.4.0",
      releaseUrl: "https://github.com/x/y/releases/tag/v1.4.0",
      publishedAt: "",
    });
    fireEvent.click(screen.getByRole("button", { name: "v1.3.0 · Update available" }));
    expect(openMock()).toHaveBeenCalled();
  });

  test("offline shows the bare version, never a false Latest", async () => {
    await renderWith({ status: "unknown", currentVersion: "1.3.0", reason: "offline" });
    expect(screen.getByText("v1.3.0")).toBeVisible();
    expect(screen.queryByText(/Latest/)).toBeNull();
  });
});
