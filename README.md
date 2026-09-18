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
npm run dev:web   # browser viewer at http://localhost:5174 — no Electron, page-local demo simulation
```

In a plain browser there is no preload bridge, so `src/renderer/src/web/demoBridge.ts` installs an equivalent `window.context` implemented in the page: it mirrors the monitor's event stream, catalogs, and commands (auto-starts a simulated session; the header shows a "Browser demo" badge). The Python monitor remains the source of truth for the real app.

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

The main dashboard runs a J2534 diagnostic monitor as a streaming Python child process and visualizes its output live.

**Safety scope — performance modules only.** The monitor enforces a default-deny write policy (`MODULE_SCOPE` in `resources/j2534_monitor.py`): writes are allowed only to the Engine (`0x7E0`) and the 8-speed auto Transmission (`0x7E1`) ECUs. Steering (EPS), brakes (ABS/ESP/EPB), airbag/restraints (SRS), ADAS, and every other module are permanently blocked — any catalog entry or command targeting them is refused before a write is attempted, and the dashboard shows the policy in a Safety Scope card.

**Vehicle profile: 2018 VW Amarok 3.0 V6 TDI — DDXC "TDI550" (224 hp / 550 Nm, ZF 8HP70).** The simulation is profiled for this truck: Bosch EDC17 engine ECU identity (DDXC engine code), Amarok-style VIN, diesel fault set (P0299 VNT underboost, P0671 glow plug, P2002 DPF, P2015 intake flap position), diesel live channels (rail pressure ~290 bar at idle, accelerator pedal, boost to 300 kPa), and dyno pulls matching the factory curve (224 hp / 550 Nm with the 10-second 580 Nm overboost noted). The Stage 1 profile uses real-world tuner figures for the TDI550: 224 → ~310 hp, 550 → 680 Nm sustained with 710 Nm remapped overboost — the mod card notes that 680 Nm runs near the ZF 8HP70's torque rating. All curves remain clearly-labelled simulated reference data until the live J2534 transport is wired. The component-deletion catalog is performance-scoped accordingly (engine/exhaust deletes plus off-road monitor deletes); the Performance Mods panel serves Engine and TCU calibrations (stage slots, rev limiter, launch control, DSG shift maps, overrun burble).

- **Monitor**: `resources/j2534_monitor.py` — prints newline-delimited JSON events to stdout (`status` / `info` / `dids` / `dtc` / `live` / `analysis` / `deletions` / `mods` / `baselines` / `pull` / `verification` / `flash` / `log` / `error`) and accepts JSON commands on stdin (`clear_dtc`, `delete_component`/`restore_component`, `apply_mod`/`revert_mod`, `run_pull`, `verify_changes` with a duty profile, `probe_dids`, `read_ecu_backup`, `seed_baseline` — all validated against the module scope). Since no ECU is connected yet, a `SimulatedTransport` fabricates plausible VW data (idle RPM with jitter, coolant warm-up curve, DTCs with freeze frames, a full ECU identification including a DID-probe report).
- **UDS/J2534 protocol layer** (`resources/uds.py`): ISO-TP framing, a UDS client (session control, DID reads, 0x19 DTC read, 0x14 clear, 0x23 read-memory, 0x27 security access, 0x35/0x36/0x37 flash transfer, 0x31 routines), the J2534 pass-thru transport (ISO15765 with firmware segmentation), and a DID map with scaling plus **runtime probing** — the diesel-critical channels (rail/boost/pedal) carry candidate DIDs that are probed on first live connect and the first one the ECU answers is adopted. `python resources/uds.py --selftest` exercises the protocol layer offline (23 checks). The monitor's live path (`RealTransport`) constructs this stack; without a device it fails gracefully and falls back to simulation with an actionable message. See `HARDWARE.md` for the EDC17CP54 read/flash strategy and the self-tune toolchain cost table.
- **Tier-1 statistical analysis layer** (`StreamTracker` in the monitor): continuous, on-device, no model required. It learns per-channel baselines (EWMA + EW variance) from the live stream, flags deviations in sigmas ("abnormal for this session") once warm-up completes, and extrapolates trends (least-squares fit gated by R² × slope-stability, so a saturating warm-up curve is *not* projected linearly) into predictive alerts with explicit confidence. Provenance is shown in the UI (`static-fallback` → `session-learned` → `cross-session`). The monitor performs **no file I/O**: learned baselines are emitted as `baselines` events, persisted by the main process at `<userData>/diagnostic-state.json`, and seeded back on the next session via `seed_baseline`. Static alert thresholds remain the deterministic fallback throughout.
- **Main process**: `src/main/lib/diagnostic.ts` spawns the interpreter via Node `child_process`, streams stdout line-by-line to the renderer over the `diagnostic:event` IPC channel, and forwards commands from `sendDiagnosticCommand()` to the monitor's stdin. `PARSER_PYTHON` overrides the interpreter path.
- **Dashboard** (`src/renderer/src/App.tsx`): Start/Stop session controls with a simulation toggle (on by default while no ECU is connected), an **AI Diagnostic Assistant** card (vehicle health score, plain-language findings, likely causes, recommended next steps, confidence, technician disclaimer), ECU identification, live-data gauges with rolling sparklines and min/max, a selectable trend chart for intermittent faults, **Performance Graphs** (dyno pulls: run a full-throttle sweep, power/torque curves with previous-pull overlay and peak deltas — curves scale with Stage 1 and rev-limiter mods), a fault-code table with freeze-frame conditions and a two-step-confirmed clear (UDS 0x14), the performance-mods and component-deletion catalogs, a session report export, and an event log.

```ts
// Renderer API (also usable from any component)
const { started, message } = await window.context.startDiagnostic({ simulate: true });
const unsubscribe = window.context.onDiagnosticEvent((event) => {
  if (event.type === "live") console.log(event.values.rpm);
  if (event.type === "analysis") console.log(event.healthScore, event.summary);
});
await window.context.sendDiagnosticCommand({ cmd: "clear_dtc" });
await window.context.stopDiagnostic();
unsubscribe();
```

To go live later: `pip install pyj2534`, connect the pass-thru device, implement `open_real_transport()`, then untick "Simulation mode" before starting a session.

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

`site/index.html` is a self-contained landing page (dark theme, matches the app icon) with a download button and install guide. To publish:

1. Create a GitHub repo and push this project.
2. Cut a release with the installer attached:
   ```
   gh release create v1.0.0 dist/vw-diagnostics-setup.exe --title "v1.0.0"
   ```
3. Replace `YOUR-USERNAME` in `site/index.html` (two links: download + source).
4. Host `site/` anywhere static — GitHub Pages (Settings → Pages → deploy from the `site/` folder), Netlify drop, or Cloudflare Pages.

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