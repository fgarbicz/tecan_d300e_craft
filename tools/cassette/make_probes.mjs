// Probe protocols for fitting D300e's cassette / dispense-head / load-volume rules.
// Each fluid gets its own wells (no sharing) so its dispensed total is exactly n_wells × per-well volume
// (per-well volumes are on the 400 pL grid; the engine computes the exact values used for the fit).
// Usage: node tools/cassette/make_probes.mjs <outdir>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newProtocol, writeTdd } from '../../src/tdd.js';
import { newPlate, addFluid, setWell, addNormalization } from '../../src/ops.js';

const A = 50000, S = 10000; // assay nL, stock µM (10 mM)
const concFor = (v) => (v * S) / (A + v); // µM giving per-well volume v nL in an otherwise empty well

/** fluids: [{name, totalUL, plates:[...plate indices], wellsPerPlate?, classId?}] ; norm: [{classId,type,param,wells:n, plate}] */
function probe(name, { plates = 1, fluids, norm = [], dmso = 0.1 }) {
  const p = newProtocol();
  for (let i = 0; i < plates; i++) p.plates.push(newPlate({ plateType: 'Default384', name: `${name} ${i + 1}`, dmsoLimit: dmso }));
  const cursor = new Array(plates).fill(0); // next free well index per plate (row-major)
  const take = (pi) => { const k = cursor[pi]++; return [Math.floor(k / 24), k % 24]; };
  for (const f of fluids) {
    const fl = addFluid(p, { name: f.name, concentration: S, concentrationUnit: 'mM', classId: f.classId ?? 0 });
    const onPlates = f.plates ?? [0];
    // amounts per plate (µL): explicit f.perPlate, else the total split evenly
    const amounts = f.perPlate ?? onPlates.map(() => f.totalUL / onPlates.length);
    const maxWell = f.maxWellUL ?? 2;
    onPlates.forEach((pi, j) => {
      const perPlate = amounts[j] * 1000; // nL
      const n = f.wells ?? Math.max(1, Math.ceil(perPlate / (maxWell * 1000)));
      const v = perPlate / n;
      for (let i = 0; i < n; i++) { const [r, c] = take(pi); setWell(p.plates[pi], r, c, fl.id, concFor(v)); }
    });
  }
  for (const g of norm) {
    const wells = [];
    for (let i = 0; i < g.wells; i++) { const [r, c] = take(g.plate ?? 0); wells.push({ p: g.plate ?? 0, r, c }); }
    addNormalization(p, g.classId ?? 0, 'ToVolume', g.param, wells);
  }
  return p;
}

const P = {
  'probe-1-small': { fluids: [0.2, 1.0, 1.6, 1.8, 2.2, 3, 6, 12].map((t, i) => ({ name: `s${i + 1}`, totalUL: t })) },
  'probe-2-split': { fluids: [14, 16, 18, 19, 20, 21, 23, 26].map((t, i) => ({ name: `m${i + 1}`, totalUL: t })) },
  'probe-3-plates': { plates: 3, fluids: [9, 15, 24, 33].map((t, i) => ({ name: `p${i + 1}`, totalUL: t, plates: [0, 1, 2] })) },
  'probe-4-classes': { fluids: [[1, 1], [12, 1], [1, 4], [12, 4], [20, 1], [5, 2], [5, 3], [5, 0]].map(([t, c], i) => ({ name: `c${i + 1}`, totalUL: t, classId: c })) },
  'probe-5-norm40': { fluids: [{ name: 'n1', totalUL: 1 }], norm: [{ param: 1000, wells: 40 }] },
  'probe-6-norm120': { fluids: [{ name: 'n1', totalUL: 1 }], norm: [{ param: 1000, wells: 120 }] },
  'probe-7-norm300': { fluids: [{ name: 'n1', totalUL: 1 }], norm: [{ param: 1000, wells: 300 }] },
  'probe-8-tenfluids': { fluids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((t, i) => ({ name: `t${i + 1}`, totalUL: t })) },
  'probe-10-bounds': { fluids: [[20.4, 0], [20.8, 0], [41, 0], [44, 0], [200, 0], [201, 0], [250, 0], [21, 1], [30, 1]].map(([t, c], i) => ({ name: `x${i + 1}`, totalUL: t, classId: c, maxWellUL: 4 })) },
  'probe-11-packing': { plates: 3, fluids: [
    { name: 'k1', totalUL: 30, plates: [0, 1, 2], perPlate: [15, 10, 5] },
    { name: 'k2', totalUL: 210, plates: [0, 1, 2], maxWellUL: 4 },
    { name: 'k3', totalUL: 135, plates: [0, 1, 2], maxWellUL: 4 },
    { name: 'k4', totalUL: 36, plates: [0, 1, 2], perPlate: [14, 14, 8] },
  ] },
  'probe-9-big': { fluids: [40, 60, 90].map((t, i) => ({ name: `b${i + 1}`, totalUL: t })) },
};
for (const [name, spec] of Object.entries(P)) {
  writeFileSync(join(process.argv[2], `${name}.tdd`), writeTdd(probe(name, spec)));
  console.log('wrote', name);
}
