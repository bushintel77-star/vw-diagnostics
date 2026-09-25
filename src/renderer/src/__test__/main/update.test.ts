import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";

// update.ts runs in the Electron main process; vitest mocks the module.
const electronState = vi.hoisted(() => ({
  version: "1.0.0",
  isPackaged: true,
}));
vi.mock("electron", () => ({
  app: {
    getVersion: () => electronState.version,
    get isPackaged() {
      return electronState.isPackaged;
    },
  },
  shell: { openExternal: vi.fn() },
}));

import { checkForUpdate, isNewerVersion } from "../../../../main/lib/update";

// jsdom's AbortSignal lacks the static timeout() helper the main-process
// code uses; polyfill a no-op so fetch calls reach the stub.
if (typeof AbortSignal.timeout !== "function") {
  (AbortSignal as { timeout?: (ms: number) => AbortSignal }).timeout = () =>
    new AbortController().signal;
}

const stubFetch = (impl: () => Promise<unknown>) => {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const releaseJson = (body: unknown, status = 200) =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });

describe("isNewerVersion", () => {
  test("compares numerically, not lexicographically", () => {
    expect(isNewerVersion("1.1.0", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.1.0")).toBe(false);
    expect(isNewerVersion("1.10.0", "1.9.0")).toBe(true); // "10" > "9" numerically
    expect(isNewerVersion("2.0.0", "1.99.99")).toBe(true);
  });

  test("tolerates a leading v prefix", () => {
    expect(isNewerVersion("v1.1.0", "1.0.0")).toBe(true);
    expect(isNewerVersion("v1.0.0", "1.0.0")).toBe(false);
  });

  test("fails closed on unparseable input", () => {
    expect(isNewerVersion("", "1.0.0")).toBe(false);
    expect(isNewerVersion("abc", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.x.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.1.0", "garbage")).toBe(false);
  });
});

describe("checkForUpdate", () => {
  beforeEach(() => {
    delete process.env.VWD_FORCE_UPDATE_BANNER;
    electronState.isPackaged = true;
    electronState.version = "1.0.0";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("newer tag_name -> available with release URL", async () => {
    stubFetch(() =>
      releaseJson({
        tag_name: "v1.1.0",
        html_url: "https://github.com/x/releases/tag/v1.1.0",
        published_at: "2026-09-01T00:00:00Z",
      })
    );
    const result = await checkForUpdate();
    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.currentVersion).toBe("1.0.0");
      expect(result.latestVersion).toBe("1.1.0");
      expect(result.releaseUrl).toContain("github.com");
      expect(result.publishedAt).toBe("2026-09-01T00:00:00Z");
    }
  });

  test("same tag -> current", async () => {
    stubFetch(() =>
      releaseJson({ tag_name: "v1.0.0", html_url: "https://github.com/x" })
    );
    const result = await checkForUpdate();
    expect(result.status).toBe("current");
  });

  test("older tag -> current", async () => {
    stubFetch(() =>
      releaseJson({ tag_name: "v0.9.9", html_url: "https://github.com/x" })
    );
    const result = await checkForUpdate();
    expect(result.status).toBe("current");
  });

  test("rejected fetch -> unknown, never current", async () => {
    stubFetch(() => Promise.reject(new Error("offline")));
    const result = await checkForUpdate();
    expect(result.status).toBe("unknown");
    expect(result.status).not.toBe("current");
  });

  test("HTTP 500 -> unknown, never current", async () => {
    stubFetch(() => releaseJson({}, 500));
    const result = await checkForUpdate();
    expect(result.status).toBe("unknown");
    expect(result.status).not.toBe("current");
  });

  test("HTTP 403 rate limit -> unknown, never current", async () => {
    stubFetch(() => releaseJson({ message: "rate limited" }, 403));
    const result = await checkForUpdate();
    expect(result.status).toBe("unknown");
    expect(result.status).not.toBe("current");
  });

  test("malformed JSON -> unknown, never current", async () => {
    stubFetch(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error("bad json")),
      })
    );
    const result = await checkForUpdate();
    expect(result.status).toBe("unknown");
    expect(result.status).not.toBe("current");
  });

  test("missing tag_name -> unknown", async () => {
    stubFetch(() => releaseJson({ html_url: "https://github.com/x" }));
    const result = await checkForUpdate();
    expect(result.status).toBe("unknown");
  });

  test("dev build skips the network call entirely", async () => {
    electronState.isPackaged = false;
    const fetchMock = stubFetch(() => releaseJson({}));
    const result = await checkForUpdate();
    expect(result.status).toBe("unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("VWD_FORCE_UPDATE_BANNER synthesises available", async () => {
    electronState.isPackaged = false; // must work in dev too
    process.env.VWD_FORCE_UPDATE_BANNER = "1";
    const result = await checkForUpdate();
    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.latestVersion).toBe("99.0.0");
    }
  });
});

describe("release URL allowlist", () => {
  beforeEach(() => {
    delete process.env.VWD_FORCE_UPDATE_BANNER;
    electronState.isPackaged = true;
    electronState.version = "1.0.0";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A hostile html_url must fail the check AND leave nothing stored for the
  // click handler — each case re-imports the module for clean state.
  test.each([
    "file:///C:/Windows/System32/calc.exe",
    "https://evil.example.com/x",
    "http://github.com/releases/x", // https only
    "not-a-url",
  ])("rejects %s", async (htmlUrl) => {
    vi.resetModules();
    const { checkForUpdate: check, openUpdateDownload: open } = await import(
      "../../../../main/lib/update"
    );
    const { shell } = await import("electron");
    const openExternal = vi.mocked(shell.openExternal);
    openExternal.mockClear();

    stubFetch(() =>
      releaseJson({ tag_name: "v9.9.9", html_url: htmlUrl })
    );
    const result = await check();
    expect(result.status).toBe("unknown");
    expect(result.status).not.toBe("current");
    await open();
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("legitimate https github.com URL is stored and opened", async () => {
    vi.resetModules();
    const { checkForUpdate: check, openUpdateDownload: open } = await import(
      "../../../../main/lib/update"
    );
    const { shell } = await import("electron");
    const openExternal = vi.mocked(shell.openExternal);
    openExternal.mockClear();

    const url = "https://github.com/bushintel77-star/vw-diagnostics/releases/tag/v9.9.9";
    stubFetch(() => releaseJson({ tag_name: "v9.9.9", html_url: url }));
    const result = await check();
    expect(result.status).toBe("available");
    await open();
    expect(openExternal).toHaveBeenCalledWith(url);
  });
});

describe("kill-switch floor (update-floor.json)", () => {
  beforeEach(() => {
    electronState.isPackaged = true;
    electronState.version = "1.0.0";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** URL-routing stub: the check makes two fetches (release API + floor). */
  const stubRouting = (
    routes: Record<string, () => Promise<unknown>>,
    fallback: () => Promise<unknown>
  ) => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const handler = Object.entries(routes).find(([prefix]) =>
          url.startsWith(prefix)
        );
        return (handler ? handler[1] : fallback)();
      })
    );
  };

  const floorResponse = (minRequired: string | null) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          minRequired === null ? {} : { minRequired }
        ),
    });

  const releaseResponse = (tag: string) =>
    releaseJson({ tag_name: tag, html_url: "https://github.com/x", published_at: "" });

  test("floor above current -> blocked, even when release says current", async () => {
    stubRouting(
      { "https://bushintel77-star.github.io/": () => floorResponse("1.2.0") },
      () => releaseResponse("v1.0.0")
    );
    const result = await checkForUpdate();
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.requiredVersion).toBe("1.2.0");
      expect(result.currentVersion).toBe("1.0.0");
    }
  });

  test("floor blocks even when the release API is unreachable", async () => {
    stubRouting(
      { "https://bushintel77-star.github.io/": () => floorResponse("1.1.0") },
      () => Promise.reject(new Error("offline"))
    );
    const result = await checkForUpdate();
    expect(result.status).toBe("blocked");
  });

  test("floor unreachable -> check behaves as before (no block)", async () => {
    stubRouting(
      {},
      () => releaseResponse("v1.0.0") // release current, floor fetch falls through
    );
    // floor falls to fallback (release JSON, no minRequired) -> null floor
    const result = await checkForUpdate();
    expect(result.status).toBe("current");
  });

  test("floor equal to current -> not blocked", async () => {
    stubRouting(
      { "https://bushintel77-star.github.io/": () => floorResponse("1.0.0") },
      () => releaseResponse("v1.0.0")
    );
    const result = await checkForUpdate();
    expect(result.status).toBe("current");
  });

  test("unparseable floor -> not blocked (fail-open on the floor only)", async () => {
    stubRouting(
      { "https://bushintel77-star.github.io/": () => floorResponse("banana") },
      () => releaseResponse("v1.0.0")
    );
    const result = await checkForUpdate();
    expect(result.status).toBe("current");
  });
});
