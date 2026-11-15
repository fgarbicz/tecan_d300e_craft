# Reference protocols to build in D300e Control (Windows VM)

Purpose: each file is a known-answer case. The Mac app must (1) read it, (2) write it back
byte-identical, and (3) reproduce the volumes/concentrations in its report. Questions refer to
`spec_from_user_guide.md` §10.

Where to save: `\\vmware-host\Shared Folders\vm_exchange\` (Mac: `fixtures/vm_exchange/`).
For every protocol save **both** the `.tdd` and the report (Excel-compatible XML, all tabs) with
the same base name, e.g. `T01_units.tdd` + `T01_units.xml`. A screenshot is useful where noted
(Win+Shift+S, paste into Paint, save as PNG into the same folder).

Use a 384-well plate and Additional/Assay volume 50 µL unless stated.

| # | File | What to build | Answers |
|---|------|---------------|---------|
| T01 | `T01_units` | New protocol. One fluid "DrugA", DMSO class, **10 mM**. Set well A1 = 1 µM. Save. Then change DrugA's display unit to **µM** (value 10000) and save as `T01b_units`. | Q1 units of `<Concentration>`; AssayVolume meaning (report shows total volume) |
| T02 | `T02_numbers` | DrugA 10 mM. Set A1 = 0.00001, A2 = 0.0000012345, A3 = 33.333333333333, A4 = 100, A5 = 0.5 µM. | number formatting incl. exponent form |
| T03 | `T03_rounding` | DrugA 10 mM, Additional volume 100 µL. Set B1..B8 = 0.0017, 0.0015, 0.0006, 0.36, 0.359, 0.361, 1.5, 0.15 µM (no normalization). | rounding at 13 pL/17 pL/3.6 nL edges and ties; sub-minimum handling (Q6) |
| T04 | `T04_titrations` | DrugA 10 mM. Row A: Log titration 10 → 0.001 µM, 12 points. Row B: Linear 10 → 1, 10 points. Row C: 1/2 Log from 10, 8 points. Columns 1-3 rows D-K: column-wise log titration with 3 replicates. | Q7 distributions/patterns |
| T05 | `T05_normalize` | DrugA 10 mM titrated across row A (log 100 → 0.01). Copy that row to rows B-F. Normalize: B = highest class volume; C = highest total volume; D = specified volume 200 nL; E = 1 % of total volume; F = specified total volume. Dispense order "with the fluids". Screenshot the Normalize dialog. | Q2 backfill Type names/Params |
| T06 | `T06_synergy2` | Synergy wizard: DrugA 10 mM, DrugB 5 mM, 6 levels each, Include 0 ticked, defaults otherwise. Screenshot each wizard page. | Q10 |
| T07 | `T07_synergy3` | Synergy wizard with DrugA, DrugB, DrugC (3 levels for C), default layout. Screenshot the layout options page. | Q10 combination order, plate breaks |
| T08 | `T08_quickplate` | Quick Plate: reproduce the guide's first worked example. Screenshot every page. | Q11 |
| T09 | `T09_randomize` | Copy of T04, then Randomize the whole plate. Save. Then randomize again and save as `T09b_randomize`. | Q15 storage format |
| T10 | `T10_classes` | One fluid per class offered in the Fluid class dropdown (name each after its class). Screenshot the dropdown, the Current Protocol tab, the Advanced tab, the Settings dialog (all tabs) and the plate-type list. | Q3, Q4, Q5, Q14 ClassID mapping, settings |
| T11 | `T11_plates` | Three plates: 96-well, 384-well, 1536-well; give each a name; tick Don't Shake on plate 2. | plate-type strings, per-plate fields |
| T12 | `T12_byvol_mass` | Fluid by volume (Buffer) set A1 = 100 nL; mass fluid (Antibody, 1 mg/mL aqueous) set A2 = 1 µg/mL. | ByVol and mass units in XML |

If something in the UI differs from this plan, save what the software does and note it in
`fixtures/vm_exchange/NOTES.txt`. The files are copied into `fixtures/reference/` (read-only)
once checked.
