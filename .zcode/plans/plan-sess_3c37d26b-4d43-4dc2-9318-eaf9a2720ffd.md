Fix the DID mis-mapping family + dead template code, verified against SAE J1979 / ISO 15031-5.

## 1. Correct `DID_MAP` / `DID_CANDIDATES` in `resources/uds.py`

- `speedKph` → `(0xF40D, lambda b: b[0])` — vehicle speed, 1 byte
- `intakeTempC` → `(0xF40F, lambda b: b[0] - 40)` — intake air temp, 1 byte
- `boostPressureKpa` candidates: **remove `0xF40E`** (timing advance per ISO 15031-5 — 1 byte, wrong channel); keep `0xF4A3` community candidate first; append `(0xF40B, 1-byte kPa, "J1979 MAP fallback — saturates at 255 kPa, cannot show stage-1 boost")` as last-resort with an explicit saturation note
- `batteryV` keeps its existing TODO comment
- Comment block updated to cite ISO 15031-5 PID mirroring so the origin of the low bytes is explicit

## 2. Length-aware decode (over-read guard)

- Map entries gain expected payload length metadata (e.g. `(did, nbytes, scaler)`)
- `read_live` validates `len(payload) >= nbytes` before scaling; on mismatch (or IndexError/ValueError) the channel is set to `None` instead of crashing the loop — per-channel failure, not per-session

## 3. Simulator speaks DIDs (closes the "93k samples prove nothing" gap)

- Add an encode side: per-channel `value → DID payload bytes` (correct widths/scalers)
- `SimulatedTransport` answers `read_live` by running `sample()` values through encode, so simulated traffic flows through the same DID decode as real traffic
- Round-trip (encode → decode == original value) becomes testable for every channel

## 4. Probe hardening

- Probe records response length; candidate **adoption requires expected width match** — a DID that answers with the wrong byte count is logged as "answered but wrong width — rejected" instead of adopted (catches the 0xF40E trap on a real truck)

## 5. Tests (mirror in demoBridge + window.mock where they show DID strings)

- Decode table unit tests: known bytes → known value per DID (e.g. `0xF40D` `0x64` → 100 kph; `0xF40F` `0x46` → 30 °C)
- Over-read guard test: short payload → channel `None`, no exception
- Sim encode→decode round-trip test per channel
- Probe rejection test: right DID, wrong width → not adopted
- Update SIM_DID_ENTRIES strings (`0xF40B`→`0xF40D` for speed etc.) in `demoBridge.ts` / `window.mock.ts` and any test asserting the old DIDs

## 6. Remove dead template code

- Delete `resources/parser.py`, `src/main/lib/parser.ts`; unwire `runParser` from main + preload (`index.ts`, `index.d.ts`); remove `ParserData` from `src/shared/types.ts`; drop the README "One-shot Python parser" section; remove any test touching them
- `package.json` `"author": "Author"` → `"bushintel77-star"`

## 7. Verify + ship

- `npx vitest run` (all green), `python resources/uds.py --selftest`, monitor smoke (`python resources/j2534_monitor.py --simulate` brief run)
- Commit to `main` and push (gh-pages unaffected — no landing-page copy changes needed; the page makes no DID-level claims)

## 8. What this does NOT change

- The write path stays gated as-is (no 0x34 added, no seed/key) — this fix is about read-side truth
- Real-truck confirmation of every adopted DID still happens at first live connect via the hardened probe; the map just stops being wrong against the standard before that day