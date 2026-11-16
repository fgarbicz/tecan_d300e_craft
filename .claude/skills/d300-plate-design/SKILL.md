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
     the powder mass;
   - design: the primary drug (along the columns) and partner drug(s) (along the rows, each its own plate set):
     top concentration, dilution step (any of "1:3", "1.5", "÷2", "×0.667", "-33%"; "1:0.33" = remove a third),
     number of non-zero levels, replicates (adjacent wells), include 0 (default yes: gives single agents and
     vehicle). A single-drug dose response = a partner with `"drug": null` and `replicates` = rows;
   - plates: type (384 default), well volume before printing (medium + cells, µL; default 50), DMSO limit %
     (default 1), PBS border (1 = outer row/column, default), plate replicates (default 3);
   - cells: cell lines; arrangement `same` (one line), `perLine` (a plate set per line), `splitRows` / `splitCols`
     (two lines per plate, top/bottom or left/right halves — the grid must fit in half the plate);
     cells per well, seeding volume (µL), overage % (default 15).
   - normalization (per partner): `block` (DMSO to the highest, across the plate set; default), `plate`
     (DMSO to the limit, % of total, per plate) or `none`.
   Inside a 1-well PBS border a 384 plate has 14 rows × 22 columns; columns = (levels + zero) × replicates.

2. **Write the spec** to `~/R projects/d300_designer/experiments/<YYYY-MM-DD>_<slug>/spec.json`
   (`bin/d300craft example` prints a complete example; format documented at the top of `src/design.js`).

3. **Run** from the repo: `bin/d300craft design experiments/<dir>/spec.json --out experiments/<dir>`
   It writes `<name>.tdd`, `<name>.craft.json`, `<name>_plan.md`, `<name>_plan.json` and prints the plan.
   Errors (grid does not fit, unknown drug, bad unit) are plain sentences: fix the spec or ask the user.

4. **Check the plan before presenting it.** If it lists warnings (DMSO over the limit, below the smallest drop,
   missing priming wells), propose a concrete fix (lower top concentration, a diluted stock as a second fluid,
   fewer levels) and re-run. Re-run `bin/d300craft check <file.tdd>` after edits (exit 1 = warnings).

5. **Present**: the plate layout table, drugs to prepare (with masses if MWs were given), cassettes and the
   bold per-head loads, cell seeding (cells/mL, mL of suspension, total cells per line), PBS, warnings, and the
   file paths. Keep the plan's numbers exactly as printed.

6. **Offer next steps** (ask first, these leave the repo): copy the .tdd + .craft.json to the D300e PC's
   protocols folder (OneDrive `Documents/DispenseControl/Protocols`), or open them in the desktop app
   (`target/release/bundle/macos/Tecan D300 Craft.app`) to edit or later paste plate-reader data
   (Results → Excel, SynergyFinder package).

## Existing protocols

`bin/d300craft plan <file.tdd> [--spec spec.json] [--json]` gives the same plan for any .tdd (its
`.craft.json` next to it supplies cell lines; `--spec` supplies seeding parameters and MWs).

## Limits (say so if relevant)
- Cassette rules come from simulated runs with "Use high-volume cassettes" ticked (D300e's default).
- One known 0.4 nL mismatch: a "to highest class volume" group whose largest well is an exact rounding tie
  (T05 row A); everything else matched the reports exactly.
