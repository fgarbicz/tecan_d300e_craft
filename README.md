# d300_designer

A Mac (and cross-platform) protocol designer for the Tecan D300e digital dispenser.
It reads and writes D300e Control 4.0.1 protocol files (`.tdd`) so that layouts designed
on the Mac open and run unchanged in D300e Control on the instrument PC.

Clean-room: built only from protocol files saved by D300e Control and the vendor user
guide. Tecan's software is not decompiled or redistributed. D300e Control in a Windows
VM is used as the reference ("oracle") for differential tests.

**Always open a generated protocol in D300e Control and check it before dispensing.**

## Layout
- `src/xmltree.js` – ordered XML parser/writer matching .NET XmlWriter output (CRLF, 2-space indent, `<X />`)
- `src/tdd.js` – protocol model: fluids, plates, wells, backfills; byte-identical round-trip
- `tests/` – `npm test` (Node ≥ 20, no dependencies)
- `fixtures/reference/` – read-only protocol files saved by the real software (test oracle)
- `fixtures/vm_exchange/` – VMware shared folder with the Windows VM (`\\vmware-host\Shared Folders\vm_exchange`)
- `docs/` – format notes, spec extracted from the user guide, open questions

## Desktop app (Mac)
Tauri 2 shell (`crates/d300-app`) around the interface in `app/`; engine in Rust (`crates/d300-core`).
- Build: `cd crates/d300-app && cargo tauri build` → `target/release/bundle/macos/D300 Designer.app` and a `.dmg`
  (needs `cargo install tauri-cli --version "^2" --locked`).
- Every save is cross-checked: d300-core re-parses and re-writes the protocol and must reproduce it
  byte-identically, otherwise nothing is written.
- Browser version for development: `bin/serve.sh` → http://127.0.0.1:8931/app/

## Verification
- `npm test` (JS, 66 tests) and `cargo test` (Rust, 51 tests) — both include byte-identical round-trips of
  every protocol saved by D300e Control 4.0.1 and the full D3 run report (5752 dispense rows).
- `docs/format_notes.md` lists every behaviour confirmed against D300e Control and how.
