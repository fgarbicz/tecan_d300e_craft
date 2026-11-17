// probe-33: reusing a partly used T8+ cassette (2026-11-17).
// Question: can a protocol make D300e Control leave the first heads of a cassette free, so the drugs go on
// heads 4–8 of a cassette whose heads 1–3 were used in an earlier run? Head assignment is decided by D300e at
// Run time (heads are filled from head 1, in fluid order — probe-3/11/13/15), so the only lever is the fluid list.
//   33a  control: three drugs f1–f3                           → expected heads 1, 2, 3
//   33b  three fluids d1–d3 with NO wells, then f1–f3          → do fluids without wells take a head?
//   33c  three dummy fluids d1–d3 with ONE 10 nL well each, then f1–f3 → dummies on 1–3, drugs on 4–6?
//   33d  as 33c with seven drugs f1–f7 (10 heads, 2 cassettes) → f1–f5 on cassette 1 heads 4–8, f6–f7 on cassette 2?
// Drugs: 10 mM DMSO stocks, 4 wells × 1 µL each (4 µL per drug, one T8+ head). Dummy wells sit in row P.
// Usage: node tools/cassette/make_probe33.mjs <outdir>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newProtocol, writeTdd } from '../../src/tdd.js';
import { newPlate, addFluid, setWell } from '../../src/ops.js';

const A = 50000, S = 10000; // assay nL, stock µM (10 mM)
const concFor = (v) => (v * S) / (A + v); // µM giving per-well volume v nL in an otherwise empty well
const out = process.argv[2];
if (!out) throw new Error('usage: make_probe33.mjs <outdir>');

function probe(name, { dummies = 0, dummyWells = 0, drugs = 3 }) {
  const p = newProtocol();
  const pl = newPlate({ plateType: 'Default384', name, dmsoLimit: 10 });
  p.plates.push(pl);
  for (let i = 0; i < dummies; i++) {
    const d = addFluid(p, { name: `d${i + 1}`, concentration: S, concentrationUnit: 'mM', classId: 0 });
    for (let w = 0; w < dummyWells; w++) setWell(pl, 15, 23 - i, d.id, concFor(10)); // P24, P23, P22
  }
  let k = 0;
  for (let i = 0; i < drugs; i++) {
    const f = addFluid(p, { name: `f${i + 1}`, concentration: S, concentrationUnit: 'mM', classId: 0 });
    for (let w = 0; w < 4; w++, k++) setWell(pl, Math.floor(k / 24), k % 24, f.id, concFor(1000));
  }
  writeFileSync(join(out, `${name}.tdd`), writeTdd(p));
  console.log('wrote', name);
}

probe('probe-33a-control', {});
probe('probe-33b-emptyfluids', { dummies: 3 });
probe('probe-33c-dummy3', { dummies: 3, dummyWells: 1 });
probe('probe-33d-dummy3-7drugs', { dummies: 3, dummyWells: 1, drugs: 7 });

// 33e (run with: FILLED head 1, SKIP heads 2 and 3): five one-head drugs f1–f5, then g1 = 36 µL (two heads).
// Unskipped: f1–f5 on heads 1–5, g1 on 6–7. After the skips f2–f5 sit on heads 4–7 and g1 has one head left on
// cassette 1 → does g1 split across cassettes (head 8 + cassette 2), move whole to cassette 2, or get re-planned?
{
  const p = newProtocol();
  const pl = newPlate({ plateType: 'Default384', name: 'probe-33e-straddle', dmsoLimit: 10 });
  p.plates.push(pl);
  let k = 0;
  for (let i = 0; i < 5; i++) {
    const f = addFluid(p, { name: `f${i + 1}`, concentration: S, concentrationUnit: 'mM', classId: 0 });
    for (let w = 0; w < 4; w++, k++) setWell(pl, Math.floor(k / 24), k % 24, f.id, concFor(1000));
  }
  const g = addFluid(p, { name: 'g1', concentration: S, concentrationUnit: 'mM', classId: 0 });
  for (let w = 0; w < 18; w++, k++) setWell(pl, Math.floor(k / 24), k % 24, g.id, concFor(2000));
  writeFileSync(join(out, 'probe-33e-straddle.tdd'), writeTdd(p));
  console.log('wrote probe-33e-straddle');
}
