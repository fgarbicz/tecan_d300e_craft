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
  // Packing rule for multi-plate splits (next-fit vs largest-first vs balanced), T8+ and D4+, plus D4+
  // remainders between 20 and 40 µL and an aqueous fluid big enough for D4+.
  'probe-13-packing2': { plates: 4, fluids: [
    { name: 'q1', totalUL: 34, plates: [0, 1, 2, 3], perPlate: [5, 16, 4, 9] },
    { name: 'q2', totalUL: 340, plates: [0, 1, 2, 3], perPlate: [50, 160, 40, 90], maxWellUL: 4 },
    { name: 'q3', totalUL: 280, plates: [0, 1, 2], perPlate: [120, 60, 100], maxWellUL: 4 },
    { name: 'q4', totalUL: 230, plates: [3], maxWellUL: 4 },
    { name: 'q5', totalUL: 100, plates: [3], maxWellUL: 4, classId: 1 },
  ] },
  'probe-9-big': { fluids: [40, 60, 90].map((t, i) => ({ name: `b${i + 1}`, totalUL: t })) },
};
for (const [name, spec] of Object.entries(P)) {
  writeFileSync(join(process.argv[2], `${name}.tdd`), writeTdd(probe(name, spec)));
  console.log('wrote', name);
}

// DMSO-limit probe: one DMSO fluid, 1 % limit, wells around the limit (single fluid per well), so the
// real software's warning threshold and rounding can be read off its tooltips / warnings.
{
  const p = newProtocol();
  const pl = newPlate({ plateType: 'Default384', name: 'probe-12-dmso 1', dmsoLimit: 0.01 });
  p.plates.push(pl);
  const f = addFluid(p, { name: 'd1', concentration: 10000, concentrationUnit: 'mM', classId: 0 });
  // target per-well volumes (nL) on the 0.4 nL grid around 505.05 nL (= exactly 1 % of 50.5 µL)
  const vols = [500, 504.4, 504.8, 505.2, 505.6, 506.0, 506.4, 507.2, 510, 515.2, 520, 550, 600];
  vols.forEach((v, i) => setWell(pl, 1, 1 + i, f.id, (v * 10000) / (50000 + v)));
  writeFileSync(join(process.argv[2], 'probe-12-dmso.tdd'), writeTdd(p));
  console.log('wrote probe-12-dmso');
}

// Fine DMSO-limit probe: 504.4 nL of d1 (10 mM) + a small top-up of d2 (1 mM, 0.02 nL grid) so the actual DMSO
// fraction steps by ~0.00005 % around 1.001 % — separates "rounded % vs limit+0.001" from "fraction > limit·1.001"
// and requested-vs-actual volumes.
{
  const p = newProtocol();
  const pl = newPlate({ plateType: 'Default384', name: 'probe-14-dmsofine 1', dmsoLimit: 0.01 });
  p.plates.push(pl);
  const d1 = addFluid(p, { name: 'd1', concentration: 10000, concentrationUnit: 'mM', classId: 0 });
  const d2 = addFluid(p, { name: 'd2', concentration: 1000, concentrationUnit: 'mM', classId: 0 });
  const A = 50000;
  for (let i = 0; i <= 22; i++) {
    const f = 0.010009 + i * 0.0000005; // 1.0009 % … 1.0020 %
    const vd = (f * A) / (1 - f), x = vd - 504.4, T = A + vd;
    const r = 2 + Math.floor(i / 12), c = 1 + (i % 12) * 2;
    setWell(pl, r, c, d1.id, (504.4 * 10000) / T);
    setWell(pl, r, c, d2.id, (x * 1000) / T);
  }
  writeFileSync(join(process.argv[2], 'probe-14-dmsofine.tdd'), writeTdd(p));
  console.log('wrote probe-14-dmsofine');
}

// DMSO threshold, three plates that separate the candidate rules (relative ×1.0011, absolute +0.0011 %-points,
// or a volume excess of ~0.55 nL): 2 % limit / 50 µL, 1 % / 10 µL, 0.5 % / 50 µL. Fraction steps ~0.0001 %.
{
  const p = newProtocol();
  const d1 = addFluid(p, { name: 'd1', concentration: 10000, concentrationUnit: 'mM', classId: 0 });
  const d2 = addFluid(p, { name: 'd2', concentration: 1000, concentrationUnit: 'mM', classId: 0 });
  const plates = [[0.02, 50000, 2.0003, 2.0040, 0.0001], [0.01, 10000, 1.0004, 1.0080, 0.0002], [0.005, 50000, 0.50020, 0.50170, 0.00005]];
  plates.forEach(([lim, A, f0, f1, step], pi) => {
    const pl = newPlate({ plateType: 'Default384', name: `probe-15 ${pi + 1}`, dmsoLimit: lim, assayVolume: A });
    p.plates.push(pl);
    let i = 0;
    for (let fp = f0; fp <= f1 + 1e-12; fp += step, i++) {
      const f = fp / 100, vd = (f * A) / (1 - f), T = A + vd;
      const base = Math.floor((vd - 2) / 0.4) * 0.4, x = vd - base;
      const r = 1 + Math.floor(i / 22), c = 1 + (i % 22);
      setWell(pl, r, c, d1.id, (base * 10000) / T);
      setWell(pl, r, c, d2.id, (x * 1000) / T);
    }
  });
  writeFileSync(join(process.argv[2], 'probe-15-dmsorule.tdd'), writeTdd(p));
  console.log('wrote probe-15-dmsorule');
}

// DMSO threshold curve: limits 0.1, 0.25, 5, 10 % (50 µL), actual fraction from the limit up to +0.4 % relative.
{
  const p = newProtocol();
  const d1 = addFluid(p, { name: 'd1', concentration: 10000, concentrationUnit: 'mM', classId: 0 });
  const d2 = addFluid(p, { name: 'd2', concentration: 1000, concentrationUnit: 'mM', classId: 0 });
  [0.001, 0.0025, 0.05, 0.1].forEach((lim, pi) => {
    const A = 50000;
    const pl = newPlate({ plateType: 'Default384', name: `probe-16 ${pi + 1}`, dmsoLimit: lim, assayVolume: A });
    p.plates.push(pl);
    for (let i = 0; i < 44; i++) {
      const f = lim * (1 + 0.0001 * i), vd = (f * A) / (1 - f), T = A + vd;
      const base = Math.max(0, Math.floor((vd - 2) / 0.4) * 0.4), x = vd - base;
      const r = 1 + Math.floor(i / 22), c = 1 + (i % 22);
      if (base > 0) setWell(pl, r, c, d1.id, (base * 10000) / T);
      setWell(pl, r, c, d2.id, (x * 1000) / T);
    }
  });
  writeFileSync(join(process.argv[2], 'probe-16-dmsocurve.tdd'), writeTdd(p));
  console.log('wrote probe-16-dmsocurve');
}

// Volume-solve convergence: single DMSO fluid per well, k = C/S from 0.015 to 0.095, at A = 50 µL and 10 µL.
// D300e iterates V = C·(A + V)/S from V = 0 and stops once the change is small; this pins the tolerance and
// whether it is absolute (nL) or relative (the two well volumes separate the two).
{
  const p = newProtocol();
  const d1 = addFluid(p, { name: 'd1', concentration: 10000, concentrationUnit: 'mM', classId: 0 });
  [[50000, 0.015, 0.045], [10000, 0.02, 0.095]].forEach(([A, k0, k1], pi) => {
    const pl = newPlate({ plateType: 'Default384', name: `probe-17 ${pi + 1}`, dmsoLimit: 0.2, assayVolume: A });
    p.plates.push(pl);
    const n = 60;
    for (let i = 0; i < n; i++) {
      const k = k0 + ((k1 - k0) * i) / (n - 1);
      setWell(pl, 1 + Math.floor(i / 22), 1 + (i % 22), d1.id, k * 10000);
    }
  });
  writeFileSync(join(process.argv[2], 'probe-17-converge.tdd'), writeTdd(p));
  console.log('wrote probe-17-converge');
}

// Guide p.89 example (100 µL, 2 % limit): two 10 mM fluids at 50 µM in one well (exact-tie case 505.0 nL),
// and 50 µM + 0.0013 µM.
{
  const p = newProtocol();
  const a = addFluid(p, { name: 'g1', concentration: 10000, concentrationUnit: 'mM', classId: 0 });
  const b = addFluid(p, { name: 'g2', concentration: 10000, concentrationUnit: 'mM', classId: 0 });
  const pl = newPlate({ plateType: 'Default384', name: 'probe-18 1', dmsoLimit: 0.02, assayVolume: 100000 });
  p.plates.push(pl);
  setWell(pl, 0, 8, a.id, 50); setWell(pl, 0, 8, b.id, 50);
  setWell(pl, 0, 7, a.id, 50); setWell(pl, 0, 7, b.id, 0.0013);
  setWell(pl, 1, 1, a.id, 60); setWell(pl, 1, 1, b.id, 60); // scrap-sized
  writeFileSync(join(process.argv[2], 'probe-18-guide89.tdd'), writeTdd(p));
  console.log('wrote probe-18-guide89');
}

// D4+ over several plates where neither next-fit nor largest-first fits: 3 × 130 µL → expect 2 heads × 195.
{
  const p = newProtocol();
  const f = addFluid(p, { name: 'e1', concentration: 10000, concentrationUnit: 'mM', classId: 0 });
  for (let pi = 0; pi < 3; pi++) {
    const pl = newPlate({ plateType: 'Default384', name: `probe-19 ${pi + 1}`, dmsoLimit: 0.1 });
    p.plates.push(pl);
    for (let i = 0; i < 26; i++) setWell(pl, 1 + Math.floor(i / 22), 1 + (i % 22), f.id, concFor(5000)); // 26 × 5 µL = 130 µL
  }
  writeFileSync(join(process.argv[2], 'probe-19-d4equal.tdd'), writeTdd(p));
  console.log('wrote probe-19-d4equal');
}
// T05 with one change each, to separate the rounding tie from the DMSO limit in row A ("to highest class volume").
{
  const { parseTdd } = await import('../../src/tdd.js');
  const { readFileSync } = await import('node:fs');
  const base = readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'reference', 't05-normalize.tdd'), 'utf8');
  const a = parseTdd(base); a.plates[0].dmsoLimit = 0.02; delete a.plates[0]._dmsoText;
  writeFileSync(join(process.argv[2], 't05-lim2.tdd'), writeTdd(a));
  const b = parseTdd(base); b.plates[0].wells.get('0,9').set(0, 90);
  writeFileSync(join(process.argv[2], 't05-a10-90.tdd'), writeTdd(b));
  console.log('wrote t05 variants');
}

// Hold-out for the normalization rules: random (seeded) concentrations of two DMSO fluids in groups of every
// type, a "to highest class volume" group spanning both plates. Not used for fitting.
{
  let seed = 20261115; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const p = newProtocol();
  const a = addFluid(p, { name: 'h1', concentration: 10000, concentrationUnit: 'mM', classId: 0 });
  const b = addFluid(p, { name: 'h2', concentration: 1000, concentrationUnit: 'mM', classId: 0 });
  for (let pi = 0; pi < 2; pi++) p.plates.push(newPlate({ plateType: 'Default384', name: `probe-20 ${pi + 1}`, dmsoLimit: 0.02 }));
  const groups = [['ToMaxVolume', undefined, [[0, 1, 4], [1, 1, 4]]], ['ToVolume', 600, [[0, 5, 7]]], ['ToAssayVolumePct', 0.012, [[0, 8, 10]]],
    ['ToMaxTotalVolume', undefined, [[1, 5, 7]]], ['ToTotalVolume', 50700, [[1, 8, 10]]]];
  for (const [type, param, ranges] of groups) {
    const wells = [];
    for (const [pi, r0, r1] of ranges) for (let r = r0; r <= r1; r++) for (let c = 1; c < 23; c++) {
      const u = rnd();
      if (u > 0.15) setWell(p.plates[pi], r, c, a.id, +(Math.exp(Math.log(0.01) + rnd() * Math.log(80 / 0.01))).toPrecision(5)); // 0.01–80 µM
      if (u > 0.6) setWell(p.plates[pi], r, c, b.id, +(Math.exp(Math.log(0.001) + rnd() * Math.log(5 / 0.001))).toPrecision(5));
      wells.push({ p: pi, r, c });
    }
    addNormalization(p, 0, type, param, wells);
  }
  writeFileSync(join(process.argv[2], 'probe-20-normholdout.tdd'), writeTdd(p));
  console.log('wrote probe-20-normholdout');
}

// Top-up as a function of k = C/S (single fluid per well): plate 1 "to highest class volume" with one fixed
// largest well (k = 0.011), plate 2 "to specified volume" 560 nL (known target). k sweeps 1e-5 … 0.0105.
{
  const p = newProtocol();
  const f = addFluid(p, { name: 'z1', concentration: 10000, concentrationUnit: 'mM', classId: 0 });
  for (let pi = 0; pi < 2; pi++) p.plates.push(newPlate({ plateType: 'Default384', name: `probe-21 ${pi + 1}`, dmsoLimit: 0.03 }));
  const n = 330, ks = Array.from({ length: n }, (_, i) => (i < 110 ? 1e-5 * Math.pow(1e-3 / 1e-5, i / 109) : 1e-3 + ((0.0105 - 1e-3) * (i - 110)) / (n - 111)));
  for (let pi = 0; pi < 2; pi++) {
    const wells = [];
    ks.forEach((k, i) => { const r = Math.floor(i / 22), c = 1 + (i % 22); setWell(p.plates[pi], r, c, f.id, +(k * 10000).toPrecision(6)); wells.push({ p: pi, r, c }); });
    if (pi === 0) { setWell(p.plates[0], 15, 23, f.id, 110); wells.push({ p: 0, r: 15, c: 23 }); }
    addNormalization(p, 0, pi === 0 ? 'ToMaxVolume' : 'ToVolume', pi === 0 ? undefined : 560, wells);
  }
  writeFileSync(join(process.argv[2], 'probe-21-normsweep.tdd'), writeTdd(p));
  console.log('wrote probe-21-normsweep');
}
