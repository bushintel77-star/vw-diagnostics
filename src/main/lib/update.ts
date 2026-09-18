import { app, shell } from "electron";
import { CheckForUpdateFn } from "@shared/types";

// Update notice: check GitHub's releases API from the main process (the
// renderer CSP is default-src 'self', so it cannot reach api.github.com),
// show a banner, and let the user's browser + installer do the rest.
// Deliberately NO silent auto-install: unsigned builds would need
// verifyUpdateCodeSignature=false, removing the only tamper guard — this
// app will eventually write to an ECU, so that trade is unacceptable.

const RELEASE_API =
  "https://api.github.com/repos/bushintel77-star/vw-diagnostics/releases/latest";
const RELEASES_PAGE =
  "https://github.com/bushintel77-star/vw-diagnostics/releases/latest";
const CHECK_TIMEOUT_MS = 5000;

// The URL offered to the renderer comes only from a check this process
// resolved itself — the renderer is never trusted to supply one.
let lastReleaseUrl: string | null = null;

/** Strict semver compare: "v" prefix tolerated, components compared
 *  numerically (1.10.0 > 1.9.0). Unparseable input fails closed (false). */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (value: string): number[] | null => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const l = parse(latest);
  const c = parse(current);
  if (!l || !c) return false;
  for (let i = 0; i < 3; i++) {
    if (l[i] !== c[i]) return l[i] > c[i];
  }
  return false;
}

/** Never throws and never blocks startup: any failure reports "unknown",
 *  which renders nothing — a failed check is never "you're up to date". */
export const checkForUpdate: CheckForUpdateFn = async () => {
  const currentVersion = app.getVersion();

  // Dev/test override: synthesise an "available" result so the banner can be
  // verified without publishing a release. Env-gated only.
  if (process.env.VWD_FORCE_UPDATE_BANNER === "1") {
    lastReleaseUrl = RELEASES_PAGE;
    return {
      status: "available",
      currentVersion,
      latestVersion: "99.0.0",
      releaseUrl: RELEASES_PAGE,
      publishedAt: "",
    };
  }

  // Dev builds skip the API entirely.
  if (!app.isPackaged) {
    return { status: "unknown", currentVersion, reason: "dev build" };
  }

  try {
    const response = await fetch(RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        // GitHub rejects requests with no User-Agent.
        "User-Agent": `vw-diagnostics/${currentVersion}`,
      },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        status: "unknown",
        currentVersion,
        reason: `GitHub releases API returned ${response.status}`,
      };
    }
    const data = (await response.json()) as {
      tag_name?: unknown;
      html_url?: unknown;
      published_at?: unknown;
    };
    const tag = typeof data?.tag_name === "string" ? data.tag_name : null;
    const releaseUrl = typeof data?.html_url === "string" ? data.html_url : null;
    if (!tag || !releaseUrl) {
      return {
        status: "unknown",
        currentVersion,
        reason: "unexpected release payload",
      };
    }
    if (isNewerVersion(tag, currentVersion)) {
      lastReleaseUrl = releaseUrl;
      return {
        status: "available",
        currentVersion,
        latestVersion: tag.replace(/^v/, ""),
        releaseUrl,
        publishedAt:
          typeof data.published_at === "string" ? data.published_at : "",
      };
    }
    return { status: "current", currentVersion };
  } catch {
    return {
      status: "unknown",
      currentVersion,
      reason: "release check unreachable",
    };
  }
};

/** Opens the release page the main process resolved in its last successful
 *  check. Takes no URL argument — an arbitrary renderer-supplied string to
 *  shell.openExternal would turn renderer injection into "open anything". */
export const openUpdateDownload = (): void => {
  if (lastReleaseUrl) {
    void shell.openExternal(lastReleaseUrl);
  }
};
