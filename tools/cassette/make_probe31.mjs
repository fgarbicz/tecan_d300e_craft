// probe-31: blind check of "'% of assay volume' heads are planned from the next-step top-ups" (fitted on probe-25
// head 4). Three plates, each one D4+ normalization head. On every plate the percentage is tuned so that the
// DISPENSED top-ups add up to just below a load tie (1.25·d + 15 = n + 0.5) and the PLANNED ones (next iteration
// step) to just above it: "planned" predicts n + 1, "dispensed" predicts n.
// Usage: node tools/cassette/make_probe31.mjs <outdir>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newProtocol, writeTdd } from '../../src/tdd.js';
import { newPlate, addFluid, setWell, addNormalization } from '../../src/ops.js';
import { computeProtocol } from '../../src/dispense.js';

const out = process.argv[2];
let seed = 31;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const TIES = [194.0, 197.2, 190.8]; // µL with 1.25·d + 15 = x.5 (the planned − dispensed gap needs ≥ 1.4 % normalization)
const START = [0.0152, 0.0125, 0.0106];

function build(params) {
  const p = newProtocol();
  const f = addFluid(p, { name: 'pc1', concentration: 10000, concentrationUnit: 'mM', classId: 0 });
  seed = 31;
  params.forEach((pct, pi) => {
    const pl = newPlate({ plateType: 'Default384', name: `probe-31 ${pi + 1}`, dmsoLimit: 0.05 }); p.plates.push(pl);
    const wells = [];
    for (let r = 0; r < 16; r++) for (let c = 0; c < 24; c++) {
      // drug in most wells: 20 … 120 µM (100 … 600 nL) — the planned − dispensed gap grows with the drug volume
      if (rnd() < 0.8) setWell(pl, r, c, f.id, Number((20 * Math.pow(6, rnd())).toPrecision(5)));
      wells.push({ p: pi, r, c });
    }
    addNormalization(p, 0, 'ToAssayVolumePct', pct, wells);
  });
  return p;
}
const sums = (p) => computeProtocol(p).map(({ wells }) => { let d = 0, pl = 0; for (const w of wells.values()) { d += w.normalization || 0; pl += w.normalizationPlanned ?? w.normalization ?? 0; } return [d / 1000, pl / 1000]; });

// tune each plate's percentage (6 significant digits): bisect until the dispensed sum is near the tie, then scan
// for a value with dispensed < tie − 0.006 and planned > tie + 0.006
const params = [...START];
for (let pi = 0; pi < 3; pi++) {
  let lo = 0.004, hi = 0.03;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; params[pi] = mid; if (sums(build(params))[pi][0] < TIES[pi] - 0.02) lo = mid; else hi = mid; }
  let found = false;
  for (let step = -3000; step <= 3000 && !found; step++) {
    params[pi] = Number((lo + step * 5e-8).toPrecision(6));
    const [d, pl] = sums(build(params))[pi];
    if (d < TIES[pi] - 0.006 && pl > TIES[pi] + 0.006 && pl < TIES[pi] + 0.06) found = true;
  }
  if (!found) { params[pi] = lo; throw new Error(`plate ${pi + 1}: no percentage found near ${lo}: ${sums(build(params))[pi]}`); }
}
const p = build(params);
console.log('params', params, 'dispensed / planned µL per plate', sums(p).map((x) => x.map((v) => +v.toFixed(4))));
writeFileSync(join(out, 'probe-31-pctplan.tdd'), writeTdd(p));
console.log('wrote probe-31-pctplan');
