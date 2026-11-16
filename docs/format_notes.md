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
  ≤ 200 µL per head; load = 1.25·d + 15 µL (aqueous too, probe-13), shown to 1 µL. A remainder above whole
  D4+ heads of ≤ 20 µL goes to one T8+ head filled to 20 µL; a larger one adds a D4+ head (probe-13 230 µL →
  2 × 115). (was: "≤ 40 µL to T8+", corrected by probe-13.)
- D4+ over several plates: next-fit in plate order, else largest-first (ties: later plate first), else equal
  (probe-13, probe-19, and the D3 run's 265 µL normalization head).
- Normalization ("DMSO normalization") is planned like a fluid, after the fluids.
- Run order: the cassette type fluid 1 needs comes first; each cassette takes the heads needed first, scanning
  from the plate where the previous cassette finished (probe-13, probe-15). (was: "T8+ first, then D4+".)
- The summary's total per fluid can differ by 0.1 µL from the sum of the per-head loads (e.g. 24.1 vs 12.0+12.0).
- Volume solve: see the next section (iteration with a 0.1 % stop; the earlier "3 fixed steps" was a
  partial fit, and the probe-7 A1 0.4 nL difference is resolved by it).
- UNVERIFIED (high-volume cassettes unticked: now verified, see below): the aqueous
  minimum load (one point); the largest-first tie-break (from the aborted D3 run); D300e's pre-run warning
  "plate fluid is split between multiple dispense heads, and there are no wells greater than 30 nL in some
  cases" is not produced by this app.

## Volume sizing and the DMSO warning (simulated runs, 2026-11-15, second session)
- Fluids are sized by fixed-point iteration V_i = C_i·T/S_i, T = fixed + ΣV_i, from V = 0. D300e stops once the
  total changes by < 0.1 % between steps (checked from the second step on) and uses the total of the step
  before. probe-17 (120 wells, k = ΣC/S 0.015–0.095 at 50 and 10 µL): 2 steps below k ≈ 0.032, 3 above;
  the switch matches the relative rule at both volumes, not an absolute nL tolerance. probe-15 (two-fluid wells,
  k = 0.02) and probe-18 (guide p.89 A09: 504.8 nL in 4.0.1 vs 505.2 nL in the older guide) confirm it.
- "DMSO limit exceeded" (tooltip, warning icon; pre-run summary "N wells exceed DMSO limit"): flagged when the
  UNROUNDED DMSO fraction > limit × 1.001. probe-12/14/15/16 (limits 0.1–10 %, 10/50 µL, one and two fluids)
  bracket the factor to 1.000999–1.001001. The D3 wells at 1.0005 % (after the % top-up) are not flagged.
- Pre-run summary also lists "A well of 30 nL or greater is recommended for each fluid on each plate".
- Cassette order follows the fluids: when fluid 1 is on a D4+ head, the D4+ cassette is loaded first (probe-15).
- Normalization top-up (ToVolume, ToMaxVolume, ToTotalVolume, ToMaxTotalVolume). probe-21 (single fluid,
  k = C/S from 1e-5 to 0.011) was designed to isolate it: its plate 2 ("to 560 nL", fixed target) fits only
  with the iteration starting from V₀ = Σ C·A/S and a stop at 0.1 % (the bracket is 0.0958–0.1002 %, i.e. the
  sizing tolerance), keeping the previous N; plate 1 ("to highest") adds the target. Rules (src/dispense.js
  iteratedTopUp):
  - volumes are C·T/S per fluid, summed: this float order decides exact ties (D3 N2 = 37.5 steps → 38;
    T05 A5 = 1253.4999999999998 → 1253), rounded like .NET Math.Round (no tie tolerance);
  - "highest": the target well is sized with its convergence check from the first step (D3 k_max 0.00032 stays
    at Σ C·A/S; probe-21 k_max 0.011 takes one step) and steps along with the well, t ← Σ C·(A + t)/S;
  - stop when |ΔV| / N < 0.1 % (the change of the well's fluids, not of N: on plate 1 the moving target
    partly cancels ΔV in ΔN);
  - "total" types take a first step from V = 0, so wells whose fluids add < 0.1 % of N get the full t − A.
  Results: D3 5752/5752, T05 + two copies 107/107 each, probe-21 1320/1321 (L20: 0.0002 steps below a tie),
  probe-20 (not used to derive these rules, but looked at while fitting earlier versions): to-highest 175/175,
  to-volume 66/66, to-total 58/66, to-highest-total 44/65.
- "To total volume" (probe-23 plate 1, single-fluid sweep; hold-out: probe-20's two-fluid group, all 150
  rows): a LAGGED iteration from V = 0, N = 0 — Tᵢ = A + Nᵢ₋₁ + Vᵢ₋₁, Vᵢ = Σ C·Tᵢ/S, Nᵢ = gap − Vᵢ₋₁ — that stops
  at the first i with |Vᵢ − Vᵢ₋₁| / Nᵢ < 0.1 % (at most i = 3) and returns Nᵢ; the fluids are dispensed as sized
  at step min(max(i, 1), 2). The stop thresholds sit exactly at the switches seen (k = 0.000881 → 0.0999 % stops,
  0.000919 → 0.1048 % goes on; 0.003256 → 0.0975 %, 0.003299 → 0.1005 %). The fluids are sized at T₁ unless the well
  total still changes by ≥ 0.1 % between steps 1 and 2 (|T₂ − T₁| / T₂, i.e. from k ≈ 0.001), then at T₂ — the
  convergence check of an ordinary well, independent of where the top-up stops. probe-27b (blind, gaps 400 / 700 /
  1000 nL, 924 wells, k 0.00075–0.001): 1848/1848 rows; probe-23 plate 1 664/664.
- "To highest total" (src/dispense.js maxTotalTopUp; fitted 2026-11-16 on probe-23 plate 2, checked on probe-20's
  two-fluid group, validation: probe-30). Target: the largest well is sized as a "to total" well whose gap is its
  own plain sizing s; its fluid volume at that total is the target gap g (probe-23: s = 556.05, g = 556.2504).
  Every well: N = g − X with X stepping X₀ = V(A) → X₁ = V(A + 2g) → X₂ = V(T₂), stopping when the step changes
  X by < 0.1 % of the top-up; fluids at T₂. probe-23 plate 2 660/665 (five near-ties within 0.013 steps: G3, I19,
  K6, N4 fluids, L8 top-up), probe-20 1007/1007; blind probe-30 1222/1239 as predicted, 1232/1239 after sizing
  every fluid at T₂ (open: 7 rows on its 20 µL plate — near-ties, and one well, I15, that fits a further step).
  (earlier notes, kept for the record: the implied gap looked k-dependent — 556.25 → 555.7 → 555.4 → 556.25 —
  because the middle band subtracts X₁, not V₀ or V₁; no single-volume model could fit.)
- "% of assay volume", stop check revised 2026-11-16 (probe-31): the first step compares the change of the top-up
  (N₁ − N₀ = p³·A) with 0.1 % of the top-up, later steps the change of the fluid volume. Blind pass: probe-32,
  2081/2081 rows.
- Head volumes (cassette planning): fluids from their dispensed (grid) volumes, top-ups from their UNROUNDED
  volumes. probe-25 head 4: 193.996 µL dispensed, 194.0006 µL unrounded → 258. Blind: probe-32, three heads placed
  between the two sums in both directions — 257 / 254 / 262 as predicted. (Refuted on the way: head volume to
  0.1 µL first — probe-27a; next-iteration top-ups — probe-31.)
- Per-fluid total ("Loaded Volume", pre-run "Total load volumes"): Σ over heads of 1.25·d + 15 (D4+) and
  1.15·d + 0.3 / 2.5 (T8+; the per-head value on the fill screen follows d / 0.87 + dead), rounded once — to 1 µL
  with a D4+ head, else 0.1 µL. All 73 fluid rows of the archived completed runs.
- "Use high-volume cassettes" unticked (probe-9, 2026-11-16): the pre-run summary switches to T8+ heads only
  (10 heads / 2 cassettes for 40 + 60 + 90 µL), 20 µL per head, equal shares: 23.3 ×2, 23.3 ×3, 21.0 ×5. The tick
  is back on at the next run.
- "% of assay volume": lagged iteration from T₀ = A(1+p) (Nᵢ = p·Tᵢ − Vᵢ₋₁), stop |ΔV|/N < 0.1 %, fluids sized at
  A(1+p); wells already over the target get no top-up and normal sizing (src/dispense.js pctTopUp; D3 plate 9 +
  probe-25: 1076/1076).
- Cassettes / heads: see the src/cassette.js header (probe-22a–o, 24, 25, 26; docs/handoff_probe22_predictions.md).
  T8+ heads in probe-25 and D4+ heads in probe-26 were predicted before the run; every cassette phase plans its
  fluids from the plate it starts at. D4+ load = 1.25 × the exact head volume + 15, half up: probe-27a (blind,
  2026-11-16) put 12 heads of every kind 0.004–0.04 µL below a .5 tie and all show the lower value (the
  "0.1 µL first" reading fitted that morning is refuted). OPEN, one head: probe-25 head 4 (193.996 µL of
  "% of assay volume" normalization → 258, not 257).
- Per-fluid total ("Loaded Volume" in the report; pre-run summary to 0.1 µL for fluids, 1 µL for normalization):
  the exact head loads summed and rounded once, to 1 µL if a D4+ head is involved, else 0.1 µL (61/64 rows; three
  T8+-only fluids are 0.1 µL low: probe-22l z1, probe-24 d3, d4).
- Fluid sizing of unnormalized wells: convergence check from the first step (k < 0.001 → sized at A); fluid
  rounding = .NET Math.Round(v / inc) in doubles, no tie tolerance (probe-22l, 26).
- An app-saved file (craft-ui-d3.tdd, canvas thumbnail, revision "Mac\D300 Craft") opens in D300e Control and
  shows its thumbnail in the recent list.
- Plate randomization (probe-28, 2026-11-16, run report): `<Randomize><Well R C ToR ToC/>` — R,C is the well
  dispensed into, ToR,ToC the design ("non-random") well whose contents go there; entries sorted by R,C. 850/850
  report rows (Dispensed Well vs Non-random Well). (was read the other way round; T09 alone cannot tell.)
- A diluted stock written by Craft (`<RootFluidID>`, `<DilutionFactor>` after `<Name>`, concentration = root / N,
  name "Drug - 1:N") opens in D300e Control 4.0.1 with the dilution marker and dispenses like any fluid (probe-28).
- Fluid shift / extend in D300e Control's own titration dialog (probe-29 / 29b, 2026-11-16; files saved by D300e):
  - Offer: "Use Shifted Fluid — Titration can be accomplished with a shifted fluid — Dilution Factor is 1:3 (33%)" /
    "Do Not Shift"; "Use Extended Fluid — … using an extended fluid in addition to the selected fluid — Dilution
    Factor is 1:30" / "Do Not Extend — Without fluid extension, the titration will include wells below the minimum
    dispense volume". Factors seen: 3, 6, 30, 300 — all = smallest candidate ≥ stock minimum / lowest level; shift
    when the top level is within the diluted fluid's maximum (src/ops.js suggestShift, rule unchanged).
  - An existing dilution of the fluid is reused when it covers the series (1 → 0.001 µM with "Fluid 1 - 1:30"
    present: shift 1:30 offered, both fluids shown in the dialog).
  - Level split after "Use Extended Fluid": a level goes to the extended fluid when it needs ≤ ~180 nL of it
    (bracket 179.36–181.51 nL), otherwise it stays on the stock — the stock does NOT keep every level it can reach.
    Independent of the DMSO limit (0.5 %) and the well volume (100 µL). src/ops.js extendThreshold.
  - Stored as Craft writes it: new fluid right after its root, `<Name>Fluid 1 - 1:30</Name>`, `<RootFluidID>0`,
    `<DilutionFactor>30`, `<Concentration>333.3333333333` (13 significant digits).
  - The titration panel shows "Valid range is 0.00260 to 100 µM" (50 µL, 1 %), "0.00260 to 50.0 µM" (0.5 %),
    "0.00130 to 100 µM" (100 µL) — equal to validRange().
  - Remote-desktop notes: Shift and Ctrl are dropped (no shift-click, no Ctrl+A): select a row by its header, clear
    a field with End + Backspace; the plate editor needs APPLY before CLOSE.
