# Hardware & First-Connect Guide

What to buy, install, and do the first time the laptop meets the truck
(2018 Amarok 3.0 V6 TDI, DDXC / TDI550, Bosch EDC17CP54 + ZF 8HP70).

**What this app does:** live data via UDS `0x22` (width-validated decode,
DID probing, NRC `0x78` responsePending handled), fault codes via `0x19`
with ISO 14229 status decode, clear codes via `0x14`, ECU identity via
`0xF187`/`0xF189`/`0xF191`/`0xF18C`, and a post-flash health check.

**What this app does not do:** it does not write to the ECU. Calibration
changes are applied by boot-mode bench flashing — ECU on the bench,
PCMFlash + PowerBox/boot cable driving BOOT/RESET/CNF1/GPT signals, CPU
halted in the bootstrap loader so the security layer never loads, full
~4 MB read, edit, flash back (PCMFlash corrects checksums). The
`0x27`/`0x35`/`0x36`/`0x37`/`0x31` primitives in `uds.py` are tested
protocol scaffolding, intentionally unwired; `0x34 RequestDownload` is
deliberately absent. The app's role is diagnosis before the flash and
health verification after it.

**Verification status:** no real hardware has ever been connected. The
J1979-mirror DIDs are correct against ISO 15031-5, but the
manufacturer-specific candidates (`0xF4A3` boost, `0xF484` rail,
`0xF4A1` pedal, `0xF448` battery) come from community tables unconfirmed
on a DDXC ECU — the width-gated probe will reject wrong-width answers
at first connect, but adoption still needs confirming on the vehicle.

## 1. The pass-thru device (the one purchase that matters)

The app talks ISO 15765-4 (CAN 500 kbps) through a **J2534 pass-thru
device**. The bundled `resources/j2534.py` wrapper loads an existing Windows J2534 DLL. Actual adapter compatibility still needs a hardware test.

| Device | Class | Notes |
|---|---|---|
| Tactrix Openport 2.0 | Pro-sumer | The community standard for VAG flashing; solid drivers |
| Scanmatik 2 Pro | Professional | Recommended for EDC17CP54 bench work (GPT signal timing) |
| CarDAQ-Plus 3 / Plus 4 | Professional | Dealer-level, J2534 2.0 certified, fastest for full-flash reads |
| Generic OBDLink-style | Budget | Read-only DIDs usually fine; **not** for flash work |

Rules of thumb:

- For **reading** (DIDs, DTCs, live data, verification): anything genuine works.
- For **backup/flash**: prefer Openport / Scanmatik / CarDAQ. A dropped
  connection mid-write is how ECUs brick; buy the device with the
  reputation, not the price.

## 2. Software setup (existing legacy Openport driver)

Keep the driver confirmed for your clone. For the reported setup,
`openport2_setup_1004341.exe` has installed `op20pt32.dll` version
`1.01.0.4341`. Do not replace it with a newer Tactrix/EcuFlash package or
run firmware updaters. Public builds of this app never install drivers; a
private build can launch only that pinned installer, behind a passkey (see
[Cable setup wizard](#cable-setup-wizard)). The app never requests adapter
firmware updates; vendor DLL behaviour remains vendor-controlled.

The Python J2534 wrapper is included. **Do not run `pip install pyj2534`.**
The interpreter must match the DLL architecture. A 32-bit driver requires
32-bit Python (3.10 or newer), even on 64-bit Windows 11. Windows launchers
try `py -3-32` first, then other interpreters using a read-only preflight.
`VWD_PYTHON` is an authoritative path override; `PARSER_PYTHON` remains an alias.
Neither silently falls back when the selected interpreter is incompatible.

From the repository, check setup without loading the vendor DLL or opening USB:

```powershell
py -3-32 resources/j2534_monitor.py --preflight
```

`ready: true` verifies registry/file/interpreter compatibility only. It is
not proof that Windows permits the USB driver to load, or that the vehicle responds.

To pin an existing installation in the PowerShell window that starts the app:

```powershell
$env:VWD_PYTHON = (& py -3-32 -c "import sys; print(sys.executable)").Trim()
$env:VWD_J2534_DLL = 'C:\Windows\SysWOW64\op20pt32.dll'
$env:VWD_J2534_SHA256 = (Get-FileHash -LiteralPath $env:VWD_J2534_DLL -Algorithm SHA256).Hash
& $env:VWD_PYTHON resources/j2534_monitor.py --preflight
npm run dev
```

Record the hash while the known compatible driver is installed and keep it
in your launcher. Do not recompute it after replacing the driver: the stored
hash is what makes the app refuse a changed DLL. The same variables apply to
the installed app and `npm run dev:web`. They do not modify Windows settings.

The app reads both registry views under `HKLM\SOFTWARE\PassThruSupport.04.04`.
When several compatible DLLs are registered, select one with `VWD_J2534_DLL`;
the app will not open an arbitrary driver. The optional `VWD_J2534_SHA256`
check runs before the DLL is loaded.

### Windows 11 driver block (Code 39)

Since the April 2026 Windows updates, Windows 11 (24H2 and later) no longer
trusts kernel drivers signed under the old cross-signing program. The
Openport 2.0 USB driver `openport.sys` from `openport2_setup_1004341.exe` is
one of them. The cable still appears in Device Manager, but with a yellow
mark and **Code 39**, and every J2534 open fails. When this happens the app
names the Code 39 in its connection error; no app setting can get past it.

Confirm it (read-only) from an administrator PowerShell with the cable in
the PC only:

```powershell
Get-PnpDevice | ? FriendlyName -match 'openport|tactrix' | ft FriendlyName,Status,Problem -auto
Get-WinEvent -LogName 'Microsoft-Windows-CodeIntegrity/Operational' -MaxEvents 500 |
  ? Message -match 'openport' | select -First 2 TimeCreated,Id,Message | fl
```

Options, least invasive first. None of them replaces the 1.01.0.4341 driver.

1. **A Windows 10 PC**, or a **Windows 10 virtual machine** (VirtualBox with
   the cable passed through over USB). The policy is not on Windows 10, so
   the legacy driver loads there and the host PC stays untouched.
2. **Remove the policy** on the Windows 11 PC, as Microsoft documents for
   July 2026 and later builds: `CiTool.exe --remove-policy
   "{8F9CB695-5D48-48D6-A329-7202B44607E3}"` from an administrator prompt,
   then restart. This lowers driver security for the whole PC, there is no
   per-driver exception, and Microsoft's only way back is restoring a
   backup or reinstalling Windows.

The "Microsoft Vulnerable Driver Blocklist" switch under Windows Security >
Device security > Core isolation is a different list and does not lift
this block. Sources: [The Windows Driver Policy](https://support.microsoft.com/en-us/windows/hardware/drivers/the-windows-driver-policy),
[Removing trust for the cross-signed driver program](https://techcommunity.microsoft.com/blog/windows-itpro-blog/advancing-windows-driver-security-removing-trust-for-the-cross-signed-driver-pro/4504818).

### Cable setup wizard

The cable chip in the dashboard header opens **Cable setup**. It also opens by
itself when something needs fixing: no driver, or Code 28/39/other. It runs
the same read-only checks as this section: Windows build, the J2534
registration, the cable's Device Manager state (present devices only, polled
every few seconds), and the `--preflight` Python check. The step follows live
status, so plugging the cable in or finishing the installer moves it on
without a click. On Windows 11 with Code 39 it explains the block and points
to the Windows 10 options above. It never offers to change security settings.

**Private build with the driver bundled.** Tactrix's installer is never
committed or shipped in public releases (`resources/driver/` is gitignored
and excluded by `electron-builder.yml`). For your own machines only:

```powershell
npm run driver:passkey          # verifies the pinned SHA-256, copies the installer, asks for a passkey (hidden)
npm run release:win:private     # re-checks the bundle, builds dist-private/vw-diagnostics-private-setup.exe
```

Only the scrypt hash of the passkey is stored. In the wizard, the passkey
unlocks the install for 10 minutes. Five wrong entries lock it for a minute.
The installer's hash is checked again right before it runs through the
Windows (UAC) prompt. The passkey is a convenience gate, not encryption:
anyone holding the private build has the installer, so never publish it.

## 3. First-connect checklist (in order)

1. **Ignition on, engine off** (terminal 15). Laptop on charger — a full
   flash read can take tens of minutes.
2. Start the app, Start Session. (There is no simulation mode in the
   shipped app — the fixture is test-only.)
3. If the interface can't be opened the monitor reports the real reason
   plus the preflight enumeration (see §2) — the error stays on screen
   until the session is stopped.
4. **DID probe** runs automatically (`dids` event): every dashboard channel
   shows the address the ECU actually answered. The diesel channels
   (rail/boost/pedal) try their candidate DIDs and adopt the first that
   responds — if all fail, the candidate table in `uds.py`
   (`DID_CANDIDATES`) needs better addresses from label data.
5. Confirm VIN against the build plate before anything else.
6. Clear nothing yet. Read codes, let the Tier-1 layer warm up (60 samples),
   and check the learned baselines look sane.

## 4. The ECU and the stock backup — how a real read actually happens

**ECU:** Bosch **EDC17CP54** (not the CP44 of the pre-2016 3.0 V6 era),
Infineon TriCore TC1793, 4 MB internal flash + 192 KB EEPROM. Part number
`2H0906027`, expected SW 6177 — confirm from the live identification read
before ordering anything version-specific.

**Protection:** UDS 0x27 seed/key over OBD, TPROT on the processor, and a
block-CRC + RSA signature over the file — a bit-flipped map that isn't
checksum-corrected will not start. Modern flash tools (PCMFlash, Swiftec,
Flex) correct checksums on the fly during write; standalone WinOLS editing
needs the OLS288-type checksum module.

**Reading strategy (from the calibration research):**

- **Bench read via GPT pins** (PCMFlash Module 71-class) is the rigorous
  path: exact silicon contents *including* EEPROM/immobilizer config — the
  complete rollback. Uses the ECU connector on a workbench, no enclosure
  breach.
- **OBD "virtual read" (VR)** (KESS3 / PCMFlash M50-class) identifies the
  SW and downloads a *server-matched stock file* — convenient but risks
  undocumented OEM revision mismatches. Not good enough for the master
  backup; acceptable for map identification once a bench copy exists.

The app's *Read & back up* button persists whatever the monitor streams to
`%APPDATA%/vw-diagnostics/backups/ecu-backup-<timestamp>.bin` with a
sha256. In live mode it honestly refuses until the security-access key
algorithm and the CP54 flash-layout addresses are installed in `uds.py` —
when a bench tool provides the image, keep BOTH: the bench master (never
touch it) and per-change copies.

**Map identification:** an exact-match A2L/Damos for `2H0906027 SW 6177`
trades at ~$100–300 and turns 4 MB of hex into named maps (driver wish,
torque limiters, injection quantity, gearbox torque offset…). A mismatched
A2L corrupts adjacent matrices — match software version exactly. Without
one, only the big structural maps are findable by pattern; the single-byte
scalars (EGR masks, DTC bytes) effectively require the definition file.

## 5. Self-tune toolchain (sourced cost table)

| Component | Purpose | Est. cost (USD) |
|---|---|---|
| PCMFlash (dongle + bench module) | GPT bench read/write of TC1793 flash + EEPROM | ~$180–200 |
| Scanmatik 2 Pro | J2534 interface with the timing control bench work needs | ~$400–450 |
| EVC WinOLS | Hex editing + heuristic map recognition | ~$1,000+ |
| A2L / Damos (exact SW match) | Named maps, axis scaling, conversion factors | ~$100–200 |
| VCDS or this app | Datalogging specified-vs-actual (boost, rail, EGT) | ~$200 / $0 |
| xHP Flashtool (license + map pack) | ZF 8HP70 TCU line pressure + torque limiters | ~$350 |
| **Total** | | **~$2,230–2,400** |

Against a professional remote tune at £600–800 (~$800–1,050). The economics
only close if you count the education and the ownership — which is the
whole philosophy here. This app replaces the datalogging line item and the
post-write verification loop (the step first-timers skip and professionals
don't: flash baseline → log actual vs specified → revise → repeat).

## 6. Safety scope (unchanged, worth repeating)

All ECU access is hard-scoped to **Engine (0x7E0)** and the ZF 8HP70
**Transmission (0x7E1)**. Steering, brakes/ABS, airbags/SRS and ADAS are
refused by the monitor before any transport call — a deliberate,
permanent scope, not a limitation to be lifted. The post-flash health
check reports `pass` only when checks actually evaluated real ECU data
(fresh DTC read, live channels within limits, plausible samples); with
no vehicle data it reports `inconclusive`, never a vacuous pass.

The DPF/EGR/SCR catalog entries are **off-road use only** — removing
emissions equipment has UK MOT and insurance consequences. The app plans
these for the external bench flash; it never applies them itself.

## 7. Known-unverified (from the calibration research — treat as open)

- **No real hardware has ever been connected.** Everything above the
  J2534 boundary is selftested offline; first connect is the first real
  test of the whole read path.
- **Manufacturer-specific DIDs are community tables.** The J1979-mirror
  DIDs match ISO 15031-5, but `0xF4A3` boost, `0xF484` rail, `0xF4A1`
  pedal and `0xF448` battery are unconfirmed on a DDXC — the width-gated
  probe rejects wrong-width answers, but adoption still needs
  confirming on the vehicle.
- **ZF 8HP70 transient factor:** 700 Nm is the continuous rating; the
  10-second 710 Nm overboost rides an unpublished safety factor. Community
  data suggests >750 Nm holds with line-pressure work; no OEM document
  confirms the input-shaft/planetary yield margin.
- **A2L availability** for the exact `2H0906027 SW 6177` is fragmented —
  confirm before buying anything else.
- **DPF regen without the ASV:** the ECU throttles intake via the
  anti-shudder valve to reach regen temperatures. Reports differ on whether
  regens merely lengthen or eventually fail with the ASV deleted. Decision
  rule as built: keep the DPF → keep the ASV.

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Missing `j2534.py` or `uds.py` | Rebuild/reinstall the app with all three bundled Python files; no pip package is required |
| "registered only in the 32-bit registry view" | 32-bit vendor DLL (Openport clone) under a 64-bit Python — install a 32-bit Python, set `VWD_PYTHON` |
| "Code 39" in the connection error / yellow mark in Device Manager | Windows 11 is blocking the legacy `openport.sys` — see §2, Windows 11 driver block |
| "No J2534 PassThru device is registered" | Vendor J2534 driver not installed — install it, check the preflight log lines |
| Connects, no DID answers | Wrong pins — the Amarok uses pins 6/14 for CAN; check the adapter |
| VIN reads, rail/boost/pedal missing | Candidate DIDs didn't answer — update `DID_CANDIDATES` from label data |
| Reads drop under load | Budget cable — increase `LIVE_INTERVAL_S`, or replace device |
