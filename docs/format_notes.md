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
