# Tecan D300 Craft (repo: d300_designer)

A Mac (and cross-platform) protocol and experiment designer for the Tecan D300e digital dispenser.
It reads and writes D300e Control 4.0.1 protocol files (`.tdd`) so that layouts designed
on the Mac open and run unchanged in D300e Control on the instrument PC.

Clean-room: built only from protocol files saved by D300e Control and the vendor user
guide. Tecan's software is not decompiled or redistributed. D300e Control in a Windows
VM is used as the reference ("oracle") for differential tests.

**Always open a generated protocol in D300e Control and check it before dispensing.**

## Layout
- `src/xmltree.js` – ordered XML parser/writer matching .NET XmlWriter output (CRLF, 2-space indent, `<X />`)
- `src/tdd.js` – protocol model: fluids, plates, wells, backfills; byte-identical round-trip
- `src/dispense.js` – dispense engine (volumes, rounding, normalization) matching D300e Control's run reports
- `src/cassette.js` – run plan: cassettes (T8+/D4+), dispense heads, load volumes (fitted on simulated runs)
- `src/experiment.js` – experiment layer (cell lines, PBS border, well roles, readouts) saved as
  `<name>.craft.json` next to the `.tdd`, and the experiment wizard (`buildExperiment`, rebuilds D3 exactly)
- `src/analysis.js` – plate-reader (e.g. CellTiter-Glo) analysis and the Excel workbook
- `tests/` – `npm test` (Node ≥ 20, no dependencies)
- `fixtures/reference/` – read-only protocol files saved by the real software (test oracle)
- `fixtures/reference/probes`, `fixtures/reference/reports/probes` – probe protocols and the simulated D300e runs of them
- `docs/` – format notes, spec extracted from the user guide, open questions

## Command line / Claude
`bin/d300craft design spec.json --out DIR` turns a JSON experiment description into a D300e protocol (.tdd),
its experiment file (.craft.json) and a bench plan (drugs to prepare, cassettes and per-head loads, cell
seeding, PBS, warnings). `bin/d300craft example` prints a spec; `plan` / `check` work on any .tdd.
Claude uses it through the skill `.claude/skills/d300-plate-design` (linked into ~/.claude/skills), so
"design synergy plates for these drugs on these cells" gives a checked plan. Designs go in `experiments/`
(not in git).

## Desktop app (Mac)
Tauri 2 shell (`crates/d300-app`) around the interface in `app/`; engine in Rust (`crates/d300-core`).
- Build: `cd crates/d300-app && cargo tauri build` → `target/release/bundle/macos/Tecan D300 Craft.app` and a `.dmg`
  (needs `cargo install tauri-cli --version "^2" --locked`).
- Every save is cross-checked: d300-core re-parses and re-writes the protocol and must reproduce it
  byte-identically, otherwise nothing is written.
- Browser version for development: `bin/serve.sh` → http://127.0.0.1:8931/app/

## Verification
- `npm test` (JS) and `cargo test` (Rust) — both include byte-identical round-trips of
  every protocol saved by D300e Control 4.0.1 and the full D3 run report (5752 dispense rows).
- `docs/format_notes.md` lists every behaviour confirmed against D300e Control and how.
