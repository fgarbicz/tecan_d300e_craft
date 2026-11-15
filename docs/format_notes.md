# .tdd format notes (observed)

Source: `fixtures/reference/2026.08.28 synergy D3.tdd`, saved by D300e Control 4.0.1 (DLL 2.182).

- UTF-8 without BOM, CRLF, 2-space indent, no trailing newline, empty elements `<X />`.
- Protocol-level units: VolumeUnit nL, MolarityConcentrationUnit µM, MassConcentrationUnit ng_mL.
- Fluid `<Concentration>` 1000 with `<ConcentrationUnit>mM</ConcentrationUnit>`. Hypothesis (UNVERIFIED):
  the number is in the protocol unit (µM) and ConcentrationUnit is only the display unit, i.e. 1000 = 1 mM.
  Evidence: 0.02 µM in 50 µL from a 1000 mM stock would be 1 pL, below the smallest droplet; from 1 mM it is 1 nL.
- Well values are final concentrations in the protocol unit; 13 significant digits (G13), 4908/4908 match.
- Wells written row-major; fluids within a well ascending by ID; empty wells omitted; Row/Col 0-based.
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
