# .tdd format notes (observed)

Source: `fixtures/reference/2026.08.28 synergy D3.tdd`, saved by D300e Control 4.0.1 (DLL 2.182).

- UTF-8 without BOM, CRLF, 2-space indent, no trailing newline, empty elements `<X />`.
- Protocol-level units: VolumeUnit nL, MolarityConcentrationUnit µM, MassConcentrationUnit ng_mL.
- Fluid `<Concentration>` 1000 with `<ConcentrationUnit>mM</ConcentrationUnit>`. Hypothesis (UNVERIFIED):
  the number is in the protocol unit (µM) and ConcentrationUnit is only the display unit, i.e. 1000 = 1 mM.
  Evidence: 0.02 µM in 50 µL from a 1000 mM stock would be 1 pL, below the smallest droplet; from 1 mM it is 1 nL.
- Well values are final concentrations in the protocol unit; 13 significant digits (G13), 4908/4908 match.
- Wells written row-major; fluids within a well in the order they were applied (T07: IDs 0,2,1); empty wells omitted; Row/Col 0-based.
- Backfill blocks: `<Backfill ClassID Type [Param]>` with explicit `<Well P R C/>` lists (P = plate index).
  Types seen: `ToMaxVolume`, `ToAssayVolumePct` Param=0.01. Backfill wells are a user-chosen region, not
  "every well with fluid" (plates 0-2: wells A23/A24 have drug but no backfill; 4 backfilled wells have no drug).
- `<Randomize />` empty on all plates; `<HPDDPlates />` empty; `<Revisions>` one entry per save (Time, UserID);
  `<Thumbnail>` base64 PNG of the first plate.
- Fluid `<Color>` optional (only on fluid 1).

## Confirmed against D300e Control 4.0.1 (2026-11-15, simulated D300e on PC-workstation)
Source: `fixtures/reference/t01-setvalue-units.tdd` (new blank 384 protocol, Set Value on row A).
- **Stock units CONFIRMED:** UI "DMSO @ 10.0 mM" is stored `<Concentration>10000</Concentration>` +
  `<ConcentrationUnit>mM</ConcentrationUnit>`: the number is in the protocol molarity unit (µM);
  ConcentrationUnit is display only.
- Numbers: 33.333333333333 typed → `33.33333333333` (13 significant digits). 0.00001 → `1E-05`
  (.NET "G": scientific notation when exponent < -4).
- Set Value valid range shown "0.00260 to 100 µM suggested" for 10 mM, 50 µL, 1 % — matches validRange().
- Below-minimum value offers "Use Diluted Fluid" with factor 1:3 for 0.001 µM and 1:300 for 0.00001 µM
  (= smallest of 2..9, 10..90, 100..900, … ≥ min/value). "Do Not Dilute" stores the value and flags the well.
- A diluted fluid is a new fluid "Fluid 1 - 1:300" with `<RootFluidID>0</RootFluidID>` and
  `<DilutionFactor>300</DilutionFactor>` after `<Name>`; Concentration = stock / factor (33.33333333333).
- New-protocol defaults: ShakePerFluid False, ShakePerWell False, plate DontShake True, Deionize True,
  PromptPlateLoad True, CellDispenseMode 3, BackfillOrder Mixed, ShakeThresholdVolume 100, ShakePlateDuration 5.
- Revision UserID is `<machine>\<user>`; one Revision per save.

Tecan's example protocols (`fixtures/reference/tecan_examples/`, from OneDrive Documents/DispenseControl/Protocols):
- Format versions 2 and 3: root element is `<Protocol>` (no `<Root>`), protocol-level `<ConcentrationUnit>`,
  `<Plates><Mode>Volume|Concentration</Mode>`, plate `<AqueousLimit>`, `BackfillOrder` `LastPriority`,
  empty `<Wells>` written as open/close tags with whitespace. All round-trip byte-identical.
- Plate type strings: Default48 (6×8), Default96, Default384, Default1536.

## Best practice built into the app
- Guide Appendix F p.113: each plate should have a well with ≥ 30 nL of every fluid it uses (a shared
  "scrap" well is fine). The reference D3 file does this (A23 Bortezomib 0.6 µM, A24 MEN 6 µM = 30 nL each).
  App: Check tab → Priming → "Add scrap well".

## Reverse direction confirmed (2026-11-15)
`tools/roundtrip/make_protocol.mjs` built a protocol from scratch (3 fluids incl. a 1:100 diluted fluid,
titration, set values, scrap well, synergy plate, ToMaxVolume + ToAssayVolumePct normalization, no
thumbnail). D300e Control 4.0.1 opened it without any message, showed all content, and Save As produced
a file byte-identical to ours except `<Revisions>` (it appends its own) and `<Thumbnail>` (it adds one).
Normalization total shown in D300e: 11.3 µL; engine: 11.285 µL. Files: `fixtures/reference/roundtrip/`.
Note: D300e's revision list included a revision from the previously open document (its own quirk).

## Fluid classes (confirmed, `fixtures/reference/t10-classes.tdd`)
Fluid editor: "Fluid group" (DMSO / Aqueous / Master Mix) then "Fluid class".
ClassID 0 DMSO · 1 Aqueous+Tween 20 · 2 Aqueous+Brij 35 · 3 Aqueous+Triton X100 · 4 Aqueous+Tween 20+glycerol ·
5 Aqueous+Brij 35+glycerol · 6 Aqueous+Triton X100+glycerol · 12 Brilliant II SYBR Green qRT-PCR 1-Step Master Mix
(Master Mix classes force Dispense by Volume; IDs 7-11 and the other ~9 master mixes not yet mapped).
`<Color>` is written only when the user picks a non-default colour (default = palette index by fluid order:
1 red, 2 green, 3 blue, 4 yellow, 5 pink, 6 cyan, …, 10 magenta).
New fluids default to "Fluid N", DMSO, 10 mM, MaxVolume 1000 nL.

## Run planning: cassettes, dispense heads, load volumes (simulated runs, 2026-11-15)

Source: D300e Control 4.0.1 in simulation on PC-workstation. Protocols `fixtures/reference/probes/probe-*.tdd`
(made by `tools/cassette/make_probes.mjs`), run reports `fixtures/reference/reports/probes/`, and the per-head
fill screens (read off screen). Implemented in `src/cassette.js`, tested in `tests/cassette.test.js`.

- The pre-run summary ("Requirements", "Total load volumes") appears after Run → Simulate, before anything
  is dispensed. Per-head volumes appear on the fill screen after "Loaded (F3)".
- T8+ (8 heads): ≤ 20 µL dispensed per head. load = d / 0.87 + 0.3 µL (DMSO) or + 2.5 µL (aqueous),
  shown to 0.1 µL; minimum 2.0 µL (DMSO) / 4.0 µL (aqueous, 1 point).
- A fluid needing k = ⌈d/20⌉ heads: whole plates per head if next-fit packing in plate order fits in k heads,
  else equal split (a well can be dispensed by two heads: "multiple" in the report).
- D4+ (4 heads, "Use high-volume cassettes", ticked by default): used when a fluid needs > 2 T8+ heads.
  ≤ 200 µL per head; load = 1.25·d + 15 µL, shown to 1 µL. Remainder above whole D4+ heads ≤ 40 µL goes to
  T8+ heads filled to 20 µL; otherwise one more D4+ head, equal split.
- Normalization ("DMSO normalization") is planned like a fluid, after the fluids.
- Head order: T8+ cassettes first, then D4+; by first plate dispensed, then fluid, then head index.
- The summary's total per fluid can differ by 0.1 µL from the sum of the per-head loads (e.g. 24.1 vs 12.0+12.0).
- Volume solve: D300e runs 3 fixed-point steps (T = fixed·(1+k+k²)), not the exact solution; visible from
  ~1 µL per well (probe-2/10 reports). One ToVolume-normalized well (probe-7 A1) still differs by 0.4 nL: open.
- UNVERIFIED: aqueous on D4+; D4+ remainder 20–40 µL; whole-plate packing on D4+; the D3 run's normalization
  heads (that run used a modified, unsaved protocol); behaviour with "Use high-volume cassettes" unticked
  (the summary did not update when unticked).
