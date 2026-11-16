// probe-32: blind check of "top-ups are planned from their UNROUNDED volumes" (fitted on probe-25 head 4).
// Three "% of assay volume" plates, one D4+ normalization head each. The percentage of each plate is tuned so that
// the dispensed and the unrounded top-up sums fall on opposite sides of a load tie (1.25·d + 15 = n + 0.5):
//   plates 1 and 2: unrounded BELOW the tie, dispensed above  → "unrounded" predicts n,     "dispensed" n + 1
//   plate 3:        unrounded ABOVE the tie, dispensed below  → "unrounded" predicts n + 1, "dispensed" n
// Usage: node tools/cassette/make_probe32.mjs <outdir>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newProtocol, writeTdd } from '../../src/tdd.js';
import { newPlate, addFluid, setWell, addNormalization } from '../../src/ops.js';
import { computeProtocol } from '../../src/dispense.js';

const out = process.argv[2];
let seed = 32;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const TIES = [194.0, 190.8, 197.2];
const WANT = ['rawBelow', 'rawBelow', 'rawAbove'];
const MARGIN = 0.0015; // µL on each side

function build(params) {
  const p = newProtocol();
  const f = addFluid(p, { name: 'pr1', concentration: 10000, concentrationUnit: 'mM', classId: 0 });
  seed = 32;
  params.forEach((pct, pi) => {
    const pl = newPlate({ plateType: 'Default384', name: `probe-32 ${pi + 1}`, dmsoLimit: 0.05 }); p.plates.push(pl);
    const wells = [];
    for (let r = 0; r < 16; r++) for (let c = 0; c < 24; c++) {
      if (rnd() < 0.8) setWell(pl, r, c, f.id, Number((20 * Math.pow(6, rnd())).toPrecision(5)));
      wells.push({ p: pi, r, c });
    }
    addNormalization(p, 0, 'ToAssayVolumePct', pct, wells);
  });
  return p;
}
const sums = (p) => computeProtocol(p).map(({ wells }) => { let d = 0, raw = 0; for (const w of wells.values()) { d += w.normalization || 0; raw += w.normalizationExact ?? w.normalization ?? 0; } return [d / 1000, raw / 1000]; });

const params = [0.0145, 0.014, 0.0145];
for (let pi = 0; pi < 3; pi++) {
  let lo = 0.004, hi = 0.03;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; params[pi] = mid; if (sums(build(params))[pi][0] < TIES[pi]) lo = mid; else hi = mid; }
  let found = false;
  for (let step = -6000; step <= 6000 && !found; step++) {
    params[pi] = Number((lo + step * 2e-8).toPrecision(7));
    const [d, raw] = sums(build(params))[pi], t = TIES[pi];
    // either orientation will do (which one is reachable depends on the plate's rounding pattern); WANT is a wish
    found = (raw < t - MARGIN && d > t + MARGIN && d < t + 0.03) || (raw > t + MARGIN && d < t - MARGIN && d > t - 0.03);
  }
  if (!found) throw new Error(`plate ${pi + 1}: no percentage found near ${lo}`);
}
const p = build(params);
console.log('params', params, 'dispensed / unrounded µL per plate', sums(p).map((x) => x.map((v) => +v.toFixed(4))));
writeFileSync(join(out, 'probe-32-rawplan.tdd'), writeTdd(p));
console.log('wrote probe-32-rawplan');
