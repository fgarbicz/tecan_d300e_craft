// Run planning: which cassettes and dispense heads a protocol needs, and how much to load into each head.
// Fitted on D300e Control 4.0.1 simulated runs (fixtures/reference/probes + reports/probes, 2026-11-15) and
// the D3 run report. Everything marked UNVERIFIED is an extrapolation that no run has tested yet.
//
// Rules (CONFIRMED unless noted):
//  - T8+ cassette: 8 heads; a head dispenses at most 20 µL of one fluid (DMSO and aqueous alike).
//      load = dispensed / 0.87 + dead, dead 0.3 µL (DMSO) / 2.5 µL (aqueous), shown to 0.1 µL (half up);
//      minimum load 2.0 µL (DMSO) / 4.0 µL (aqueous; one datapoint).
//  - A fluid needing k = ⌈d / 20⌉ T8+ heads keeps whole plates per head when the plates, taken in run order
//    and packed next-fit into heads of ≤ 20 µL, fit in k heads (probe-3: 8+8 | 8; probe-11: 15 | 10+5;
//    D3 IDOTDO 8.7+8.7 | 8.7). Otherwise it is split equally across k heads, wells shared ("multiple").
//  - High-volume cassettes (D4+, 4 heads, on by default): used when a fluid would need more than 2 T8+ heads.
//      A D4+ head takes at most 200 µL; load = 1.25 × dispensed + 15 µL, shown to 1 µL (half up).
//      n = ⌊d / 200⌋ full D4+ heads, remainder r: r = 0 → n heads; r ≤ 40 µL → r goes to ⌈r/20⌉ T8+ heads
//      filled to 20 µL each and the D4+ heads share the rest equally (probe-10 201 µL → 20 T8+ + 181 D4+;
//      probe-11 210 → 20 + 190); r > 40 → n + 1 D4+ heads sharing equally (250 → 125 + 125; 300 → 150+150).
//      UNVERIFIED: aqueous fluids on D4+, remainders 20 < r ≤ 40, whole-plate packing on D4+.
//  - Normalization is planned like a fluid, one per fluid class, after all fluids (D3: "DMSO normalization").
//  - Head order: T8+ heads first (cassette 1, 2, …), then D4+ heads; within a type by the plate where the
//    head first dispenses, then fluid order, then the head's index within the fluid (probe-3, probe-11).

import { fluidClass } from './dispense.js';

// T8+ slope 1/0.87 (= 1.14943): fits all 45 DMSO per-head loads seen on fill screens to the 0.1 µL shown
// (grid search: slope 1.1494–1.1499 with 0.3 µL dead volume; 1.15 misses 5 of them).
export const T8 = { type: 'T8+', heads: 8, cap: 20, slope: 1 / 0.87, decimals: 1 };
export const D4 = { type: 'D4+', heads: 4, cap: 200, slope: 1.25, dead: 15, decimals: 0 };
const EPS = 1e-6;

// Round half away from zero: D4+ 1.25 × 150 + 15 = 202.5 → 203 (probe-7). (Was rounding with a +1e-9
// nudge and slope 1.15, which put 1.15 × 3 + 0.3 at 3.8 where the real software shows 3.7.)
const roundTo = (x, d) => { const m = 10 ** d; return Math.round(x * m) / m; };

/** Load volume (µL) for one head that dispenses `d` µL. */
export function headLoad(cassette, d, isDmso = true) {
  if (cassette.type === 'D4+') return roundTo(cassette.slope * d + cassette.dead, 0); // UNVERIFIED for aqueous
  const dead = isDmso ? 0.3 : 2.5, min = isDmso ? 2.0 : 4.0;
  return Math.max(min, roundTo(cassette.slope * d + dead, 1));
}

/** Dispensed µL per plate for every fluid and every normalization class, from computeProtocol() output. */
export function perPlateAmounts(protocol, computed) {
  const items = new Map(); // key -> {key, fluidId|null, classId, name, perPlate[]}
  const nPlates = computed.length;
  const get = (key, init) => { if (!items.has(key)) items.set(key, { ...init, perPlate: new Array(nPlates).fill(0) }); return items.get(key); };
  for (const f of protocol.fluids) get(`f${f.id}`, { key: `f${f.id}`, fluidId: f.id, classId: f.classId, name: f.name, order: 0 });
  // A well's normalization belongs to the class of the group it is in (one group per class per well).
  const normClass = new Map();
  for (const b of protocol.backfills) for (const w of b.wells) normClass.set(`${w.p}|${w.r},${w.c}`, b.classId);
  computed.forEach(({ wells }, p) => {
    for (const [k, r] of wells) {
      for (const x of r.fluids) if (x.volume > 0) get(`f${x.fluidId}`, {}).perPlate[p] += x.volume / 1000;
      if (r.normalization > 0) {
        const cls = normClass.get(`${p}|${k}`) ?? 0;
        get(`n${cls}`, { key: `n${cls}`, fluidId: null, classId: cls, name: `${fluidClass(cls).short} normalization`, order: 1 }).perPlate[p] += r.normalization / 1000;
      }
    }
  });
  return [...items.values()].filter((it) => it.perPlate.some((v) => v > 0))
    .sort((a, b) => (a.order || 0) - (b.order || 0) || (a.fluidId ?? a.classId) - (b.fluidId ?? b.classId));
}

/** First plate on which a head that starts at cumulative amount `from` (µL) dispenses. */
function firstPlateAt(perPlate, from) {
  let cum = 0;
  for (let p = 0; p < perPlate.length; p++) { cum += perPlate[p]; if (perPlate[p] > 0 && cum > from + EPS) return p; }
  return perPlate.length - 1;
}

/** Split one fluid's amounts into heads: [{cassette:T8|D4, amount, firstPlate}]. */
export function splitFluid(perPlate, { highVolume = true } = {}) {
  const d = perPlate.reduce((s, v) => s + v, 0);
  if (d <= EPS) return [];
  const kT = Math.ceil(d / T8.cap - EPS);
  if (kT <= 2 || !highVolume) return splitT8(perPlate, d, kT);
  // high-volume path
  const n = Math.floor(d / D4.cap + EPS), r = d - n * D4.cap;
  const heads = [];
  const equalD4 = (count, total, startAt) => { for (let j = 0; j < count; j++) heads.push({ cassette: D4, amount: total / count, firstPlate: firstPlateAt(perPlate, startAt + (j * total) / count) }); };
  if (r <= EPS) equalD4(n, d, 0);
  else if (r <= 2 * T8.cap + EPS && n > 0) {
    const t = Math.ceil(r / T8.cap - EPS);
    for (let j = 0; j < t; j++) heads.push({ cassette: T8, amount: T8.cap, firstPlate: firstPlateAt(perPlate, j * T8.cap) });
    equalD4(n, d - t * T8.cap, t * T8.cap);
  } else equalD4(n + 1, d, 0);
  return heads;
}

function splitT8(perPlate, d, k) {
  // next-fit whole-plate packing in run (plate) order
  const bins = [];
  for (let p = 0; p < perPlate.length; p++) {
    const v = perPlate[p]; if (v <= EPS) continue;
    const last = bins[bins.length - 1];
    if (last && last.amount + v <= T8.cap + EPS) last.amount += v;
    else bins.push({ amount: v, firstPlate: p });
  }
  if (bins.length <= k && bins.every((b) => b.amount <= T8.cap + EPS)) return bins.map((b) => ({ cassette: T8, ...b }));
  return Array.from({ length: k }, (_, j) => ({ cassette: T8, amount: d / k, firstPlate: firstPlateAt(perPlate, (j * d) / k) }));
}

/**
 * Plan the run. Returns { cassettes: [{type, index, heads: [{head, name, fluidId, classId, dispensed, load}]}],
 * fluids: [{name, fluidId, classId, dispensed, load, heads}] } (volumes in µL).
 */
export function planRun(protocol, computed, { highVolume = true } = {}) {
  const items = perPlateAmounts(protocol, computed);
  const heads = [];
  items.forEach((it, order) => {
    splitFluid(it.perPlate, { highVolume }).forEach((h, seg) => heads.push({ ...h, it, order, seg }));
  });
  const byType = (c) => heads.filter((h) => h.cassette === c).sort((a, b) => a.firstPlate - b.firstPlate || a.order - b.order || a.seg - b.seg);
  const cassettes = [];
  for (const c of [T8, D4]) {
    byType(c).forEach((h, i) => {
      if (i % c.heads === 0) cassettes.push({ type: c.type, index: cassettes.length + 1, heads: [] });
      const isDmso = fluidClass(h.it.classId).isDmso;
      cassettes[cassettes.length - 1].heads.push({ head: (i % c.heads) + 1, name: h.it.name, key: h.it.key, fluidId: h.it.fluidId, classId: h.it.classId,
        dispensed: h.amount, load: headLoad(c, h.amount, isDmso), firstPlate: h.firstPlate });
    });
  }
  const fluids = items.map((it) => {
    const hs = cassettes.flatMap((c) => c.heads.filter((h) => h.key === it.key).map((h) => ({ ...h, cassette: c.index, type: c.type })));
    return { name: it.name, fluidId: it.fluidId, classId: it.classId, dispensed: it.perPlate.reduce((s, v) => s + v, 0),
      load: hs.reduce((s, h) => s + h.load, 0), heads: hs };
  });
  return { cassettes, fluids };
}
