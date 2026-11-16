// probe-27: blind validation of two rules that were each fitted on one datapoint (2026-11-16).
//  27a — D4+ load at an exact .5: every head dispenses d = tie − 0.004…0.04 µL, where 1.25·tie + 15 = n + 0.5.
//        "d to 0.1 µL first" gives n + 1, "exact d" gives n. Head kinds: single-plate fluids, a normalization
//        head, two-plate heads (parts that round differently per plate), equal shares (2 and 3 heads).
//  27b — "to total volume" fluid sizing step: single-fluid sweeps, k = 0.00075…0.00100, gaps 400 / 700 / 1000 nL.
// Usage: node tools/cassette/make_probe27.mjs <outdir>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newProtocol, writeTdd } from '../../src/tdd.js';
import { newPlate, addFluid, setWell, addNormalization } from '../../src/ops.js';
import { computeWell } from '../../src/dispense.js';

const A = 50000, S = 10000;
const out = process.argv[2];

/** Concentration (µM) for which the engine dispenses exactly v nL of a 10 mM DMSO fluid alone in a 50 µL well. */
function concForVolume(fluid, plate, v) {
  const fl = new Map([[fluid.id, fluid]]);
  const base = (v * S) / (A + v);
  const vol = (c) => computeWell(new Map([[fluid.id, c]]), fl, plate, 0).fluids[0].volume;
  // the engine's iterated sizing is not the exact solution: bisect for the lowest c that reaches v, then step in
  let lo = base * 0.99, hi = base * 1.01;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (vol(mid) >= v - 1e-9) hi = mid; else lo = mid; }
  const c = Number((hi * (1 + 2e-6)).toPrecision(9)); // a little inside the 0.4 nL step, 9 digits as typed
  if (Math.abs(vol(c) - v) > 1e-9) throw new Error(`no concentration gives ${v} nL (got ${vol(c)})`);
  return c;
}

{ // ---------- 27a ----------
  const p = newProtocol();
  for (let i = 0; i < 3; i++) p.plates.push(newPlate({ plateType: 'Default384', name: `probe-27a ${i + 1}`, dmsoLimit: 0.1 }));
  const cursor = [0, 0, 0];
  const take = (pi) => { const k = cursor[pi]++; return [Math.floor(k / 24), k % 24]; };
  // [name, [[plate, wells, nL per well], …]]
  const F = [
    ['h1', [[0, 50, 2999.2]]],          // 149.96  (tie 150.0)
    ['h2', [[0, 50, 2391.6]]],          // 119.58  (tie 119.6)
    ['h3', [[0, 50, 1735.6]]],          // 86.78   (tie 86.8)
    ['h4', [[0, 50, 3815.2]]],          // 190.76  (tie 190.8)
    ['e2', [[0, 100, 2999.2]]],         // 299.92 → 2 equal heads of 149.96
    ['e3', [[1, 110, 4330.8]]],         // 476.388 → 3 equal heads of 158.796 (tie 158.8)
    ['m1', [[1, 25, 2999.2], [2, 25, 2999.2]]], // 74.98 + 74.98 = 149.96
    ['m2', [[1, 25, 2000.8], [2, 25, 3997.6]]], // 50.02 + 99.94 = 149.96 (per-plate 0.1 rounding: 149.9)
  ];
  for (const [name, parts] of F) {
    const f = addFluid(p, { name, concentration: S, concentrationUnit: 'mM', classId: 0 });
    for (const [pi, n, v] of parts) { const c = concForVolume(f, p.plates[pi], v); for (let i = 0; i < n; i++) { const [r, col] = take(pi); setWell(p.plates[pi], r, col, f.id, c); } }
  }
  const wells = []; for (let i = 0; i < 100; i++) { const [r, c] = take(1); wells.push({ p: 1, r, c }); }
  addNormalization(p, 0, 'ToVolume', 1499.6, wells); // 149.96 µL normalization on plate 2
  writeFileSync(join(out, 'probe-27a-d4ties.tdd'), writeTdd(p));
  console.log('wrote probe-27a-d4ties');
}

{ // ---------- 27b ----------
  const p = newProtocol();
  const f = addFluid(p, { name: 'tt', concentration: S, concentrationUnit: 'mM', classId: 0 });
  [400, 700, 1000].forEach((gap, pi) => {
    const pl = newPlate({ plateType: 'Default384', name: `probe-27b ${pi + 1}`, dmsoLimit: 0.1 });
    p.plates.push(pl);
    const wells = []; let i = 0; const n = 14 * 22;
    for (let r = 1; r <= 14; r++) for (let c = 1; c <= 22; c++, i++) {
      const k = 0.00075 + (0.00025 * i) / (n - 1);
      setWell(pl, r, c, f.id, Number((k * S).toPrecision(7)));
      wells.push({ p: pi, r, c });
    }
    addNormalization(p, 0, 'ToTotalVolume', A + gap, wells);
  });
  writeFileSync(join(out, 'probe-27b-totalstep.tdd'), writeTdd(p));
  console.log('wrote probe-27b-totalstep');
}
