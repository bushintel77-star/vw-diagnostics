# electron-react-shadcn

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Required Node.JS >= 18.0.0](https://img.shields.io/static/v1?label=node&message=%20%3E=18.0.0&logo=node.js&color=3f893e)](https://nodejs.org/en/download/package-manager)


## Overview

This Electron boilerplate enables developers to quickly build cross-platform apps using Electron, Vite, and React with Shadcn UI. Based on [@alex8088](https://github.com/alex8088)’s awesome `npm create @quick-start/electron` package, this template includes added styling (Tailwind, Shadcn UI) and testing libraries (Jest, Testing Library) to streamline setup and save development time.

### Tech Stack

| Category                  | Technology                                                                                  |
|---------------------------|---------------------------------------------------------------------------------------------|
| **Software Framework**    | [Electron](https://www.electronjs.org/)                                                     |
| **Frontend Library**      | [React](https://react.dev/)                                                                 |
| **Build Tool**            | [Vite](https://vite.dev/), [Electron-Vite](https://electron-vite.org/)                                                                   |
| **UI and Styling**        | [shadcn](https://ui.shadcn.com/), [Tailwind](https://tailwindcss.com/)                      |
| **Testing**               | [Vitest](https://vitest.dev), [Testing Library](https://testing-library.com/)                 |

## Quick Start

### Run the dashboard

```bash
npm run dev       # the Electron app (real pipeline: main process spawns the Python monitor)
npm run dev:web   # browser viewer at http://localhost:5174 — real monitor through the local bridge
```

In a plain browser, `src/renderer/src/web/liveBridge.ts` connects to the local monitor bridge. Start Session attempts a real hardware connection. Without the bridge the page reports not connected; no simulated product mode is available.

### Option 1 (Recommended): Use `npx electron-react-shadcn` to create a new project.

You can use this command to create a new project with this boilerplate directly in the directory. You can also setup and project name and theme colors by following the command prompts.

```bash
# create a new project using this boilerplate
npx electron-react-shadcn

# navigate to the project folder
cd electron-react-shadcn

# install dependencies and run the project in dev mode
npm install && npm run dev
```

### Option 2: Clone this repository directly

You can use this boilerplate by directly downloading or clone this repository, and install the dependencies.

```bash
# clone this project
git clone https://github.com/terrence-ou/electron-react-shadcn.git

# navigate to the project folder
cd electron-react-shadcn

# you can choose to remove the git info from this repo to avoid potential git conflicts
sudo rm -r .git

# install dependencies
npm install

# start the project in dev mode
npm run dev
```


### Test and build commands

There're some pre-defined commands you might find useful

```bash
# run unit test
npm run test

# run test coverage
npm run coverage

# build app for different platforms
npm run build:mac # build for mac
npm run build:win # build for windows
npm run build:linux # build for linux
```

## VW Diagnostic Dashboard (J2534)

The dashboard runs a J2534 diagnostic monitor as a streaming Python child process and visualizes its output live. **No real hardware has been connected yet** — the read path is selftested offline, and first connect is the first real test. See `HARDWARE.md` for the device, driver and bitness requirements and the first-connect checklist.

**What it does:** live data via UDS `0x22` (width-validated decode, DID probing, NRC `0x78` responsePending handled), fault codes via `0x19` with ISO 14229 status decode, clear codes via `0x14` (two-step confirmed), ECU identity via `0xF187`/`0xF189`/`0xF191`/`0xF18C`, a post-flash health check, and a Tier-1 statistical analysis layer.

**What it does not do:** it does not write to the ECU. Calibration changes are applied by boot-mode bench flashing (PCMFlash + PowerBox/boot cable; the ECU's bootstrap loader runs, the security layer never loads). The app's role is diagnosis before the flash and health verification after it. The `0x27`/`0x35`/`0x36`/`0x37`/`0x31` primitives in `uds.py` are tested protocol scaffolding, intentionally unwired; `0x34` is deliberately absent. The DPF/EGR/SCR catalog entries are off-road only, with UK MOT and insurance implications.

**Safety scope — performance modules only.** All ECU access is hard-scoped (`MODULE_SCOPE` in `resources/j2534_monitor.py`) to the Engine (`0x7E0`) and the ZF 8HP70 Transmission (`0x7E1`) ECUs. Steering (EPS), brakes (ABS/ESP/EPB), airbags/restraints (SRS), ADAS, and every other module are permanently refused — a deliberate scope, not a limitation to be lifted.

**Vehicle profile: 2018 VW Amarok 3.0 V6 TDI — DDXC "TDI550" (224 hp / 550 Nm, ZF 8HP70).** Bosch EDC17CP54 engine ECU. The mod/deletion catalogs are planning tools for the external flash: entries reference real figures (Stage 1 ≈ 310 hp / 680 Nm sustained against the 8HP70's ~700 Nm rating) but the app never applies them.

- **Monitor**: `resources/j2534_monitor.py` — newline-delimited JSON events on stdout (`status` / `info` / `dids` / `dtc` / `live` / `analysis` / `deletions` / `mods` / `baselines` / `verification` / `flash` / `log` / `error`) and JSON commands on stdin (`clear_dtc`, `probe_dids`, `read_ecu_backup`, `verify_changes`, `seed_baseline`, plus mod/deletion planning commands — all scope-validated, and write requests refused with a bench-flash explanation). With no interface attached it reports the real TransportError plus a J2534 preflight (interpreter bitness + registered PassThru DLLs) instead of simulating.
- **UDS/J2534 protocol layer** (`resources/uds.py`): ISO-TP framing, a UDS client (session control, DID reads, `0x19` DTC read, `0x14` clear, plus the unwired write-path scaffolding above), the J2534 pass-thru transport (ISO15765, firmware segmentation, per-ECU CAN pairs), registry preflight for the bitness/registration cases, and a DID map with scaling plus **runtime probing** — the diesel-critical channels (rail/boost/pedal) carry community-table candidate DIDs that are probed on first connect and only adopted if the ECU answers at the expected width. `python resources/uds.py --selftest` exercises the layer offline.
- **Tier-1 statistical analysis layer** (`StreamTracker` in the monitor): learns per-channel baselines (EWMA + EW variance) from the live stream, flags deviations in sigmas once warm-up completes, and extrapolates trends (least-squares gated by R² × slope-stability) into predictive alerts with confidence. Provenance is shown in the UI (`static-fallback` → `session-learned` → `cross-session`); learned baselines are persisted by the main process at `<userData>/diagnostic-state.json` and seeded back via `seed_baseline`.
- **Main process**: `src/main/lib/diagnostic.ts` spawns the interpreter via Node `child_process`, streams stdout line-by-line to the renderer over `diagnostic:event`, and forwards commands to the monitor's stdin. `VWD_PYTHON` overrides the interpreter path (`PARSER_PYTHON` still works as a deprecated alias) — needed when the vendor J2534 DLL's bitness differs from the default Python (see `HARDWARE.md` §2).
- **Dashboard** (`src/renderer/src/App.tsx`): Start/Stop session controls, an **AI Diagnostic Assistant** card (health score, findings, likely causes, next steps, confidence, technician disclaimer), ECU identification, live-data gauges with rolling history and min/max (a failed channel reads `—`, never a frozen value), a selectable trend chart, a fault-code table (real ISO 14229 status, knowledge-base descriptions, two-step clear), warning tell-tales keyed on the ECU's warningIndicator bit, the mod/deletion planning catalogs, a session report export, and an event log.

```ts
// Renderer API (also usable from any component)
const { started, message } = await window.context.startDiagnostic();
const unsubscribe = window.context.onDiagnosticEvent((event) => {
  if (event.type === "live") console.log(event.values.rpm);
  if (event.type === "analysis") console.log(event.healthScore, event.summary);
});
await window.context.sendDiagnosticCommand({ cmd: "clear_dtc" });
await window.context.stopDiagnostic();
unsubscribe();
```

To connect hardware: use the included Python wrapper with a Python whose bitness matches the existing vendor DLL (a 32-bit `op20pt32.dll` needs a 32-bit interpreter — point `VWD_PYTHON` at it), preserve the compatible legacy driver, connect the pass-thru device, Start Session. `HARDWARE.md` covers the full setup and first-connect checklist.

## Packaging & distribution

Build the Windows installer:

```
npm run release:win
```

This produces `dist/vw-diagnostics-setup.exe` (~80 MB, one-click NSIS installer, custom icon).

**Why `release:win` instead of `build:win`:** this machine cannot create NTFS symlinks (Windows Developer Mode off, non-admin shell), which makes electron-builder's bundled winCodeSign tool-cache extraction fail. The workaround stages the build:

1. `electron-builder --dir` with `win.signAndEditExecutable: false` (skips the failing toolchain),
2. `scripts/edit-exe.mjs` embeds the icon + version strings via the standalone `build/tools/rcedit-x64.exe`,
3. `electron-builder --prepackaged dist/win-unpacked` builds the NSIS installer from the already-fixed app.

If you enable Windows Developer Mode (Settings → System → For developers), you can delete `signAndEditExecutable: false` from `electron-builder.yml` and use plain `npm run build:win` again.

### Publishing the landing page + download

`site/index.html` is a self-contained landing page (dark theme, matches the app icon) with a download button and install guide. It is served from the `gh-pages` branch at https://bushintel77-star.github.io/vw-diagnostics/, together with `update-floor.json` (the kill-switch floor the app checks on launch). To ship a version:

1. Cut a release with the installer attached:
   ```
   gh release create vX.Y.Z dist/vw-diagnostics-setup.exe --title "vX.Y.Z"
   ```
2. Copy any changed `site/` files to the `gh-pages` branch.

The download link uses the `releases/latest/download/vw-diagnostics-setup.exe` pattern with a version-stable filename, so it always serves the newest release without editing the page again.

## Project Structure
```
├── resources/                      # Additional resources for the app
├── src/                            # Main source code
│   ├── main/                       # Main process code
│   │   ├── lib/                    # Libraries for main process logic
│   │   └── index.ts                # Entry point for the main process
│   ├── preload/                    # Preload scripts
│   │   ├── index.ts                # Preload script entry point
│   │   └── index.d.ts              # TypeScript declarations for preload
│   ├── renderer/                   # Renderer process code (front-end)
│   │   ├── src/                    # Source for renderer
│   │   │   ├── __tests__/          # Tests for renderer components
│   │   │   ├── assets/             # Assets for the renderer
│   │   │   ├── components/         # React components
│   │   │   │   └── ui/             # Shadcn UI components
│   │   │   └── utils/              # Utility functions
│   │   ├── App.tsx                 # Main application component
│   │   ├── env.d.ts                # TypeScript environment declarations
│   │   ├── main.tsx                # Main entry point for the renderer
│   │   └── index.html              # HTML template for the renderer
│   └── shared/                     # Shared code between main and renderer
├── .gitignore                      # Git ignore patterns
├── components.json                 # Shadcn Components configuration
├── electron.vite.config.ts         # Vite configuration for Electron
├── vite.config.mjs                 # Vitest testing configuration
├── LICENSE                         # Project license
├── package.json                    # Project metadata and dependencies
├── package-lock.json               # Dependency lock file
├── postcss.config.js               # PostCSS configuration
├── README.md                       # Project documentation
├── tailwind.config.js              # Tailwind CSS configuration
├── tsconfig.json                   # TypeScript configuration (general)
├── tsconfig.node.json              # TypeScript configuration for Node.js
└── tsconfig.web.json               # TypeScript configuration for web
```

## Offline regression checks

```powershell
python -m unittest discover -s tests -v
python resources/uds.py --selftest
python resources/j2534_monitor.py --selftest
npm test
npm run build
```

The driver tests use a fake DLL. `--preflight` only inspects the registry,
DLL headers and optional hash; it does not load the driver or contact USB.
See HARDWARE.md for the legacy Openport 1.01.0.4341 setup and driver pinning.
Hardware compatibility remains unverified until a controlled connection test.
