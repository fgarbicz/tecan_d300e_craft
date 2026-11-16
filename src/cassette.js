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
//      n = ⌊d / 200⌋ full D4+ heads, remainder r: r = 0 → n heads; r ≤ 20 µL → one T8+ head filled to 20 µL
//      and the D4+ heads share the rest (probe-10 201 µL → 20 T8+ + 181 D4+; probe-11 210 → 20 + 190);
//      r > 20 → n + 1 D4+ heads (probe-13 230 → 115 + 115; 250 → 125 + 125; 300 → 150 + 150).
//      Aqueous fluids on D4+ use the same load formula (probe-13: 100 µL → 140).
//  - Splitting over plates: whole plates per head, packed next-fit in plate order; for D4+ heads, if that
//    needs too many heads, largest-first (first-fit decreasing) packing (probe-13 [50,160,40,90] → 160+40 |
//    90+50; the real D3 run: 265 µL normalization head = 144.5 + 2×22.4 + 3×3.5); otherwise an equal split.
//    T8+ goes straight from next-fit to the equal split (probe-13 [5,16,4,9] → 17 | 17).
//  - Normalization is planned like a fluid, one per fluid class, after all fluids (D3: "DMSO normalization").
//  - Run order: all cassettes of the type that fluid 1 needs first (probe-15: D4+ first), then the other type.
//    A cassette is filled with the heads needed first, scanning plates from the plate where the previous
//    cassette finished, then plate 1, 2, …; within a plate in fluid order (probe-3, 11, 13, 15).

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

/** Split one fluid's amounts into heads: [{cassette:T8|D4, amount, plates:Set}]. */
export function splitFluid(perPlate, { highVolume = true } = {}) {
  const d = perPlate.reduce((s, v) => s + v, 0);
  if (d <= EPS) return [];
  const kT = Math.ceil(d / T8.cap - EPS);
  if (kT <= 2 || !highVolume) return packOrSplit(perPlate, 0, d, kT, T8, false);
  const n = Math.floor(d / D4.cap + EPS), r = d - n * D4.cap;
  if (r <= EPS) return packOrSplit(perPlate, 0, d, n, D4, true);
  if (r <= T8.cap + EPS && n > 0) {
    // the first 20 µL (in run order) on one T8+ head, the rest on n D4+ heads
    return [{ cassette: T8, amount: T8.cap, plates: platesIn(perPlate, 0, T8.cap) }, ...packOrSplit(perPlate, T8.cap, d - T8.cap, n, D4, true)];
  }
  return packOrSplit(perPlate, 0, d, n + 1, D4, true);
}

/** Plates whose dispenses fall in the cumulative range [from, to). */
function platesIn(perPlate, from, to) {
  const out = new Set(); let cum = 0;
  perPlate.forEach((v, p) => { if (v > EPS && cum < to - EPS && cum + v > from + EPS) out.add(p); cum += v; });
  return out;
}

/** k heads for the amounts starting at cumulative `offset`: whole plates if they pack, else equal shares. */
function packOrSplit(perPlate, offset, total, k, cas, tryLargestFirst) {
  // the part of each plate that belongs to this group (after `offset`)
  let cum = 0; const part = perPlate.map((v) => { const a = Math.max(0, Math.min(v, cum + v - offset)); cum += v; return a; });
  const items = part.map((v, p) => ({ v, p })).filter((x) => x.v > EPS);
  const nextFit = [];
  for (const it of items) { const b = nextFit.at(-1); if (b && b.amount + it.v <= cas.cap + EPS) { b.amount += it.v; b.plates.add(it.p); } else nextFit.push({ amount: it.v, plates: new Set([it.p]) }); }
  const fits = (bins) => bins.length <= k && bins.every((b) => b.amount <= cas.cap + EPS);
  if (fits(nextFit)) return nextFit.map((b) => ({ cassette: cas, ...b }));
  if (tryLargestFirst) {
    const bins = [];
    // ties: the later plate first (D3: the 265 µL head, the one that also dispensed plate 9)
    for (const it of [...items].sort((a, b) => b.v - a.v || b.p - a.p)) {
      const b = bins.find((x) => x.amount + it.v <= cas.cap + EPS);
      if (b) { b.amount += it.v; b.plates.add(it.p); } else bins.push({ amount: it.v, plates: new Set([it.p]) });
    }
    if (fits(bins)) return bins.map((b) => ({ cassette: cas, ...b }));
  }
  return Array.from({ length: k }, (_, j) => ({ cassette: cas, amount: total / k, plates: platesIn(perPlate, offset + (j * total) / k, offset + ((j + 1) * total) / k) }));
}

/**
 * Plan the run. Returns { cassettes: [{type, index, heads: [{head, name, fluidId, classId, dispensed, load}]}],
 * fluids: [{name, fluidId, classId, dispensed, load, heads}] } (volumes in µL).
 */
export function planRun(protocol, computed, { highVolume = true } = {}) {
  const items = perPlateAmounts(protocol, computed);
  const nPlates = computed.length;
  const heads = [];
  items.forEach((it, order) => {
    splitFluid(it.perPlate, { highVolume }).forEach((h, seg) => heads.push({ ...h, it, order, seg }));
  });
  // Run simulation: phases by cassette type (the type fluid 1 needs first), cassettes filled with the heads the
  // run needs first, starting at the plate where the previous cassette finished.
  const firstType = heads.length ? heads.reduce((a, b) => (b.order < a.order || (b.order === a.order && b.seg < a.seg) ? b : a)).cassette : T8;
  const types = firstType === D4 ? [D4, T8] : [T8, D4];
  const cassettes = [];
  let current = 0;
  for (const c of types) {
    const remaining = heads.filter((h) => h.cassette === c).sort((a, b) => a.order - b.order || a.seg - b.seg);
    while (remaining.length) {
      const order = [current, ...Array.from({ length: nPlates }, (_, p) => p).filter((p) => p !== current)];
      const chosen = [];
      for (const p of order) {
        for (const h of remaining) if (chosen.length < c.heads && !chosen.includes(h) && h.plates.has(p)) chosen.push(h);
        if (chosen.length >= c.heads) break;
      }
      for (const h of chosen) remaining.splice(remaining.indexOf(h), 1);
      const visited = order.filter((p) => chosen.some((h) => h.plates.has(p)));
      if (visited.length) current = visited.at(-1);
      const cas = { type: c.type, index: cassettes.length + 1, heads: [] };
      chosen.forEach((h, i) => {
        const isDmso = fluidClass(h.it.classId).isDmso;
        cas.heads.push({ head: i + 1, name: h.it.name, key: h.it.key, fluidId: h.it.fluidId, classId: h.it.classId,
          dispensed: h.amount, load: headLoad(c, h.amount, isDmso), plates: [...h.plates].sort((a, b) => a - b) });
      });
      cassettes.push(cas);
    }
  }
  const fluids = items.map((it) => {
    const hs = cassettes.flatMap((c) => c.heads.filter((h) => h.key === it.key).map((h) => ({ ...h, cassette: c.index, type: c.type })));
    return { name: it.name, fluidId: it.fluidId, classId: it.classId, dispensed: it.perPlate.reduce((s, v) => s + v, 0),
      load: hs.reduce((s, h) => s + h.load, 0), heads: hs };
  });
  return { cassettes, fluids };
}
