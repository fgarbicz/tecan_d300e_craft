// probe-30: blind validation of the "to highest total" model (src/dispense.js maxTotalTopUp), which was fitted on
// probe-23 plate 2 (one 10 mM fluid, 50 µL, largest well k = 0.011). Three groups it has not seen:
//  plate 1 — 50 µL, one fluid, largest well k = 0.004, dense in the two switch bands, 12 empty wells in the group
//  plate 2 — 20 µL wells, two fluids (10 mM + 1 mM) in random mixtures, largest well k ≈ 0.02
//  plate 3 — 50 µL, the largest well holds two fluids; the others one or two, k up to 0.008
// Usage: node tools/cassette/make_probe30.mjs <outdir>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newProtocol, writeTdd } from '../../src/tdd.js';
import { newPlate, addFluid, setWell, addNormalization } from '../../src/ops.js';

const out = process.argv[2];
let seed = 20261116;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const sig = (x) => Number(x.toPrecision(6));

const p = newProtocol();
const f1 = addFluid(p, { name: 'ht1', concentration: 10000, concentrationUnit: 'mM', classId: 0 });
const f2 = addFluid(p, { name: 'ht2', concentration: 1000, concentrationUnit: 'mM', classId: 0 });
const grid = []; for (let r = 1; r <= 14; r++) for (let c = 1; c <= 22; c++) grid.push([r, c]);

{ // plate 1
  const pl = newPlate({ plateType: 'Default384', name: 'probe-30 1', dmsoLimit: 0.1 }); p.plates.push(pl);
  const wells = [];
  const ks = [];
  for (let i = 0; i < 70; i++) ks.push(1e-5 * Math.pow(400, i / 69));               // log sweep 1e-5 … 0.004
  for (let i = 0; i < 60; i++) ks.push(3.0e-4 + (1.3e-3 - 3.0e-4) * (i / 59));       // dense across both switches
  for (let i = 0; i < 40; i++) ks.push(1.3e-3 + (3.9e-3 - 1.3e-3) * (i / 39));
  ks.push(0.004);
  ks.forEach((k, i) => { const [r, c] = grid[i]; setWell(pl, r, c, f1.id, sig(k * 10000)); wells.push({ p: 0, r, c }); });
  for (let i = 0; i < 12; i++) { const [r, c] = grid[ks.length + i]; wells.push({ p: 0, r, c }); } // empty wells
  addNormalization(p, 0, 'ToMaxTotalVolume', undefined, wells);
}
{ // plate 2: 20 µL, two fluids
  const pl = newPlate({ plateType: 'Default384', name: 'probe-30 2', dmsoLimit: 0.1, assayVolume: 20000 }); p.plates.push(pl);
  const wells = [];
  for (let i = 0; i < 180; i++) {
    const [r, c] = grid[i];
    const k = i === 0 ? 0.02 : 2e-5 * Math.pow(900, rnd());            // total k, 2e-5 … 0.018
    const share = i === 0 ? 1 : rnd() < 0.3 ? 1 : rnd() < 0.5 ? 0 : rnd(); // part of k on ht1
    if (share > 0) setWell(pl, r, c, f1.id, sig(k * share * 10000));
    if (share < 1) setWell(pl, r, c, f2.id, sig(k * (1 - share) * 1000));
    wells.push({ p: 1, r, c });
  }
  addNormalization(p, 0, 'ToMaxTotalVolume', undefined, wells);
}
{ // plate 3: the largest well has two fluids
  const pl = newPlate({ plateType: 'Default384', name: 'probe-30 3', dmsoLimit: 0.1 }); p.plates.push(pl);
  const wells = [];
  for (let i = 0; i < 180; i++) {
    const [r, c] = grid[i];
    const k = i === 7 ? 0.008 : 1e-5 * Math.pow(700, rnd());
    const share = i === 7 ? 0.6 : rnd() < 0.4 ? 1 : rnd();
    if (share > 0) setWell(pl, r, c, f1.id, sig(k * share * 10000));
    if (share < 1) setWell(pl, r, c, f2.id, sig(k * (1 - share) * 1000));
    wells.push({ p: 2, r, c });
  }
  addNormalization(p, 0, 'ToMaxTotalVolume', undefined, wells);
}
writeFileSync(join(out, 'probe-30-maxtotal.tdd'), writeTdd(p));
console.log('wrote probe-30-maxtotal');
