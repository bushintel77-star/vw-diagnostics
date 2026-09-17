# Hardware & First-Connect Guide

What to buy, install, and do the first time the laptop meets the truck
(2018 Amarok 3.0 V6 TDI, DDXC / TDI550, Bosch EDC17CP54 + ZF 8HP70).

## 1. The pass-thru device (the one purchase that matters)

The app talks ISO 15765-4 (CAN 500 kbps) through a **J2534 pass-thru
device**. Any Windows-registered J2534 DLL works with `pyj2534`.

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

## 2. Software setup (once)

```bash
pip install pyj2534
```

Install the vendor driver so its J2534 DLL registers with Windows. The
transport (`resources/uds.py`, `J2534Transport`) opens the first available
device; enumeration via `listAvailiableDevices` is wired for when more than
one DLL is registered.

## 3. First-connect checklist (in order)

1. **Ignition on, engine off** (terminal 15). Laptop on charger — a full
   flash read can take tens of minutes.
2. Start the app, untick *Simulation mode*, Start Session.
3. The monitor opens the device and falls back to simulation with a banner
   if anything fails — the banner names the reason.
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

Reads and writes are hard-scoped to **Engine (0x7E0)** and **Transmission
(0x7E1)**. Steering, brakes, SRS, ADAS are refused by the monitor before
any transport call. Verification must pass against the factory envelope
(700 Nm sustained ceiling — the ZF 8HP70 ladder) before any sign-off.

## 7. Known-unverified (from the calibration research — treat as open)

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
| "pyj2534 is not installed" | `pip install pyj2534`; vendor DLL not registered |
| Connects, no DID answers | Wrong pins — the Amarok uses pins 6/14 for CAN; check the adapter |
| VIN reads, rail/boost/pedal missing | Candidate DIDs didn't answer — update `DID_CANDIDATES` from label data |
| Reads drop under load | Budget cable — lower `LIVE_INTERVAL_S`, or replace device |
