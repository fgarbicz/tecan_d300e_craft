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
