---
name: d300-plate-design
description: Design Tecan D300e drug-printer plates (dose responses, drug-combination / synergy matrices) on given cell lines and produce a bench plan — D300e protocol (.tdd), experiment file, drug amounts to prepare, cassettes and per-head loads, cell seeding, warnings. Use when the user asks to design / plan / lay out D300e or drug-printer plates, synergy or combination screens, or asks how much drug, which cassettes or how many cells an experiment needs.
---

# Designing D300e experiments with Tecan D300 Craft

The repo `~/R projects/d300_designer` (app "Tecan D300 Craft") has a command line that turns a JSON spec into a
D300e protocol and a plan. Its numbers (volumes, DMSO warnings, cassette heads and load volumes) were matched
against D300e Control 4.0.1 run reports and simulated runs (docs/format_notes.md). Do not hand-compute them.

## Steps

1. **Collect the inputs.** Ask only for what is missing; never invent a stock concentration.
   - drugs: name, stock concentration with unit (e.g. "10 mM"), class (default DMSO), optional MW (g/mol) for
     the powder mass, optional `"unit"` = the unit this drug's doses are shown in everywhere (plan, app, Excel):
     "nM" for a potent drug, "µM" (default) or "mM". Doses in the spec can be written in any unit regardless;
   - design: the primary drug (along the columns) and partner drug(s) (along the rows, each its own plate set):
     top concentration, dilution step (any of "1:3", "1.5", "÷2", "×0.667", "-33%"; "1:0.33" = remove a third),
     number of non-zero levels, replicates (adjacent wells), include 0 (default yes: gives single agents and
     vehicle). Instead of a dilution step, give `"bottom"` (lowest concentration, e.g. "0.1 nM"): the levels then
     run evenly on a log scale from top to bottom (step = (top/bottom)^(1/(levels−1))). Never both.
     A single-drug dose response = a partner with `"drug": null` and `replicates` = rows;
   - wide ranges: `plate.dilutedStocks` (default true) adds a second stock "Drug - 1:N" when a series needs less
     than one drop (13 pL DMSO) of the stock — D300e's fluid shift (whole series on the dilution) / extend
     (stock for the high levels, dilution for the low ones). The plan lists it under "Prepare" with a recipe
     and the levels it dispenses; it is one more solution and one more dispense head. Dilution choice INFERRED
     from the user guide's two examples (not yet checked against D300e Control);
   - randomization: `plate.randomize: "cellLine"` (+ optional `randomSeed`) shuffles where each well is
     dispensed, only within the wells of the same cell line, stored in the .tdd; needs `cells.lines`.
     Readouts are pasted as read; the app maps them back. Tell the user not to re-randomize in D300e Control;
   - replicates: in `primary` = adjacent columns per level, in a partner = adjacent rows per level;
     `plate.replicates` = identical plates per layout;
   - plates: type (384 default), `wellVolumeUL` = what is in the well when the D300e prints (medium + cells;
     usually = `cells.seedingVolumeUL`, set both), DMSO limit %
     (default 1), PBS border (1 = outer row/column, default), plate replicates (default 3);
   - cells: cell lines; arrangement `same` (one line), `perLine` (a plate set per line), `splitRows` / `splitCols`
     (two lines per plate, top/bottom or left/right halves — the grid must fit in half the plate);
     cells per well, seeding volume (µL), overage % (default 15). Cells go only on the drug grids; other
     inner wells are reported as unused (medium). `pbsVolumeUL` (default = seeding volume) is the PBS per
     border well.
   - normalization (per partner): `block` (DMSO to the highest, across the plate set; default), `plate`
     (DMSO to the limit, % of total, per plate) or `none`. With several partners, `block` gives each plate set its
   own vehicle DMSO; the plan warns when they differ — use `plate` for all partners if the sets must share one
   DMSO level.
   Inside a 1-well PBS border a 384 plate has 14 rows × 22 columns; columns = (levels + zero) × replicates.

2. **Write the spec** to `~/R projects/d300_designer/experiments/<YYYY-MM-DD>_<slug>/spec.json`
   (`bin/d300craft example` prints a complete example; format documented at the top of `src/design.js`).

3. **Run** from the repo: `bin/d300craft design experiments/<dir>/spec.json --out experiments/<dir>`
   It writes `<name>.tdd`, `<name>.craft.json`, `<name>_plan.md`, `<name>_plan.json`, `<name>_dosemap.svg`
   (colour map of every drug's concentration gradient on every plate), `<name>_loading.svg` (drawing of every
   cassette: which dispense head gets which solution and how many µL; striped = diluted stock) and prints the
   plan. Show the user both drawings.
   Errors (grid does not fit, unknown drug, bad unit) are plain sentences; "does not fit" names what would fit
   (fewer levels, fewer replicates per plate, no border): fix the spec or ask the user.

4. **Check the plan before presenting it.** If it lists warnings (DMSO over the limit, below the smallest drop,
   missing priming wells), propose a concrete fix (lower top concentration, a diluted stock as a second fluid,
   fewer levels) and re-run. Re-run `bin/d300craft check <file.tdd>` after edits (exit 1 = warnings).

5. **Present**: the plate layout table and the concentration levels per axis, drugs to prepare (take the
   volumes from existing stocks; "powder per 1 mL" only matters for making a stock fresh), cassettes and the
   bold per-head loads, cell seeding (cells/mL, mL of suspension, total cells per line), PBS, warnings, the
   dose gradients (levels, range, fold) and the file paths, including the dose map SVG. Keep the plan's numbers
   exactly as printed.

6. **Offer next steps** (ask first, these leave the repo): copy the .tdd + .craft.json to the D300e PC's
   protocols folder (OneDrive `Documents/DispenseControl/Protocols`), or open them in the desktop app
   (`target/release/bundle/macos/Tecan D300 Craft.app`) to edit or later paste plate-reader data
   (Results → Excel, SynergyFinder package).

## Existing protocols

`bin/d300craft dosemap <file.tdd> [--out FILE.svg]` draws the dose map of any protocol (scrap wells are
recognised even without an experiment file).
`bin/d300craft plan <file.tdd> [--spec spec.json] [--json]` gives the same plan for any .tdd (its
`.craft.json` next to it supplies cell lines; `--spec` supplies seeding parameters and MWs).

## Limits (say so if relevant)
- Cassette rules come from simulated runs with "Use high-volume cassettes" ticked (D300e's default).
- One known 0.4 nL mismatch: a "to highest class volume" group whose largest well is an exact rounding tie
  (T05 row A); everything else matched the reports exactly.
