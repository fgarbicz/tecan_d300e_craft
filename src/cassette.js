// Run planning: which cassettes and dispense heads a protocol needs, and how much to load into each head.
// Fitted on D300e Control 4.0.1 simulated runs (fixtures/reference/probes + reports/probes, 2026-11-15) and
// the D3 run report. Everything marked UNVERIFIED is an extrapolation that no run has tested yet.
//
// Rules (CONFIRMED unless noted):
//  - T8+ cassette: 8 heads; a head dispenses at most 20 µL of one fluid (DMSO and aqueous alike) — 10 µL while
//    the wells it still has to serve include one below 1 nL (guide p.109/112: "If any well has less than one nL,
//    then standard-volume cassettes dispensing 10 µL will be used"; bulk = all wells ≥ 1 nL → 20 µL).
//    probe-20/21/22a–o: sub-nL fluids never exceed 10 µL per head; bulk ones reach 20.
//      load = dispensed / 0.87 + dead, dead 0.3 µL (DMSO) / 2.5 µL (aqueous), shown to 0.1 µL (half up);
//      minimum load 2.0 µL (DMSO) / 4.0 µL (aqueous; one datapoint).
//  - A fluid needing k = ⌈d / cap⌉ T8+ heads on several plates is packed plate by plate (next-fit): a plate joins
//    the current head if it fits whole, otherwise it starts a new head, and a plate larger than the cap is cut
//    into heads filled to the cap in well order. If that needs ≤ k heads it is used (probe-3: 8+8 | 8; probe-11:
//    15 | 10+5; D3 IDOTDO 8.7+8.7 | 8.7; probe-22n/22l: 10×6 + 6.0 | 10 …); otherwise — and always for a single
//    plate — the fluid is split equally across k heads, wells shared ("multiple") (probe-22a 4 × 8.75; 22h/22o:
//    7 + 7 > 13 → 13 equal heads across the plate boundary).
//  - Cassette overflow: when a fluid's T8+ heads do not all fit in the cassette being filled, the heads that fit
//    are kept and the rest of its wells (in well order) is planned again for the next cassette — with the 20 µL
//    cap if no well below 1 nL is left (probe-22l: 8 heads at 10, then 3 × 18.3), and on a D4+ head if a D4+
//    cassette is in the run for another fluid and the rest needs > 2 T8+ heads (probe-21: z1 rest 55.2 µL on the
//    D4+ loaded for normalization). Without such a D4+ the rest stays on T8+ (22l), and a fluid's own sub-nL
//    wells never go to a D4+ (22d, 22g).
//  - High-volume cassettes (D4+, 4 heads, on by default): used when a fluid would need more than 2 T8+ heads.
//      A D4+ head takes at most 200 µL; load = 1.25 × dispensed + 15 µL, shown to 1 µL (half up).
//      n = ⌊d / 200⌋ full D4+ heads, remainder r: r = 0 → n heads; r ≤ 20 µL → one T8+ head filled to 20 µL
//      and the D4+ heads share the rest (probe-10 201 µL → 20 T8+ + 181 D4+; probe-11 210 → 20 + 190);
//      r > 20 → n + 1 D4+ heads (probe-13 230 → 115 + 115; 250 → 125 + 125; 300 → 150 + 150).
//      Aqueous fluids on D4+ use the same load formula (probe-13: 100 µL → 140).
//  - Splitting over plates: see fillPlan / packOrSplit below — T8+: plate-by-plate fill plan with plate-boundary
//    starts, else equal shares; D4+: whole plates next-fit in run order, then largest-first, then the fill plan,
//    then equal shares (probe-13, 19, 24, 25, 26, D3). Each cassette phase plans its fluids from the plate it
//    starts at (the plate where the previous cassette finished).
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
// Head counts ignore a few nL over the cap (probe-22c: 40 µL + one 0.5 nL well per 4 heads → 4 heads, not 5).
const TOL = 0.005;

// Round half away from zero: D4+ 1.25 × 150 + 15 = 202.5 → 203 (probe-7). (Was rounding with a +1e-9
// nudge and slope 1.15, which put 1.15 × 3 + 0.3 at 3.8 where the real software shows 3.7.)
const roundTo = (x, d) => { const m = 10 ** d; return Math.round(x * m) / m; };

/** Unrounded load of one head (µL); the T8+ minimum applies before any rounding. */
function headLoadExact(cassette, d, isDmso = true) {
  if (cassette.type === 'D4+') return cassette.slope * d + cassette.dead;
  return Math.max(isDmso ? 2.0 : 4.0, cassette.slope * d + (isDmso ? 0.3 : 2.5));
}
/** Load volume (µL) for one head that dispenses `d` µL. */
export function headLoad(cassette, d, isDmso = true) {
  // D4+: 1.25 × the head's exact dispensed volume + 15, half up. probe-27a (blind, 2026-11-16): 12 heads placed
  // 0.004–0.04 µL below a .5 tie (single-plate fluids, a ToVolume normalization head, two-plate heads, equal shares
  // of 2 and 3) all show the lower value: 149.96 → 202.45 → 202, 119.58 → 164, 86.78 → 123, 190.76 → 253,
  // 158.796 → 213. "Dispensed to 0.1 µL first" (which would give 203, 165, 124, 254) is refuted.
  // OPEN (one head): probe-25 head 4, a "% of assay volume" normalization head of 193.996 µL, was loaded as 258
  // (257.495 → 257 here). Hypothesis: D300e plans that head from top-up volumes of another iteration step than the
  // ones it dispenses; a sum ≥ 194.004 µL (+8 nL over 349 wells) would give 258.
  // (was 2026-11-16 morning: whole-plate heads from d rounded to 0.1 µL, equal shares exact — fitted on that head.)
  if (cassette.type === 'D4+') return roundTo(cassette.slope * d + cassette.dead, 0); // UNVERIFIED for aqueous
  const dead = isDmso ? 0.3 : 2.5, min = isDmso ? 2.0 : 4.0;
  return Math.max(min, roundTo(cassette.slope * d + dead, 1));
}

/** Dispensed µL per plate for every fluid and every normalization class, from computeProtocol() output. */
export function perPlateAmounts(protocol, computed) {
  const items = new Map(); // key -> {key, fluidId|null, classId, name, perPlate[]}
  const nPlates = computed.length;
  const get = (key, init) => { if (!items.has(key)) items.set(key, { ...init, perPlate: new Array(nPlates).fill(0), wells: [] }); return items.get(key); };
  // dispense order: plate by plate, row-major within a plate (probe-22l report: heads take A02 … I05, I07 …)
  const well = (p, k, nL) => { const [r, c] = k.split(',').map(Number); return { p, r, c, v: nL / 1000, sub: nL < 1 - 1e-9 }; };
  for (const f of protocol.fluids) get(`f${f.id}`, { key: `f${f.id}`, fluidId: f.id, classId: f.classId, name: f.name, order: 0 });
  // A well's normalization belongs to the class of the group it is in (one group per class per well).
  const normClass = new Map();
  for (const b of protocol.backfills) for (const w of b.wells) normClass.set(`${w.p}|${w.r},${w.c}`, b.classId);
  computed.forEach(({ wells }, p) => {
    for (const [k, r] of wells) {
      for (const x of r.fluids) if (x.volume > 0) { const it = get(`f${x.fluidId}`, {}); it.perPlate[p] += x.volume / 1000; it.wells.push(well(p, k, x.volume)); }
      if (r.normalization > 0) {
        const cls = normClass.get(`${p}|${k}`) ?? 0;
        const it = get(`n${cls}`, { key: `n${cls}`, fluidId: null, classId: cls, name: `${fluidClass(cls).short} normalization`, order: 1 });
        it.perPlate[p] += r.normalization / 1000; it.wells.push(well(p, k, r.normalization));
      }
    }
  });
  for (const it of items.values()) it.wells.sort((a, b) => a.p - b.p || a.r - b.r || a.c - b.c);
  return [...items.values()].filter((it) => it.perPlate.some((v) => v > 0))
    .sort((a, b) => (a.order || 0) - (b.order || 0) || (a.fluidId ?? a.classId) - (b.fluidId ?? b.classId));
}

/** T8+ cap (µL) for a run of wells: 10 if any is below 1 nL, else 20 (guide p.109/112). */
export const t8Cap = (wells) => (wells && wells.some((w) => w.sub) ? T8_SUB_CAP : T8.cap);
const T8_SUB_CAP = 10;

/**
 * Split one fluid's amounts into heads: [{cassette: T8|D4, amount, plates:Set}].
 * `wells` (optional, in dispense order) decides the T8+ cap; without it the 20 µL bulk cap is used.
 */
export function splitFluid(perPlate, { highVolume = true, wells = null, start = 0 } = {}) {
  const d = perPlate.reduce((s, v) => s + v, 0);
  if (d <= EPS) return [];
  const cap = t8Cap(wells);
  const kT = Math.max(1, Math.ceil((d - TOL) / cap));
  // a fluid with sub-nL wells stays on standard cassettes (a D4+ cannot dispense < 1 nL; probe-22b/d/e/j)
  if (kT <= 2 || !highVolume || cap < T8.cap) return packOrSplit(perPlate, 0, d, kT, T8, false, cap, start);
  const n = Math.floor(d / D4.cap + EPS), r = d - n * D4.cap;
  if (r <= EPS) return packOrSplit(perPlate, 0, d, n, D4, true, D4.cap, start);
  if (r <= T8.cap + EPS && n > 0) {
    // the first 20 µL (in run order) on one T8+ head, the rest on n D4+ heads
    return [{ cassette: T8, amount: T8.cap, plates: platesIn(perPlate, 0, T8.cap) }, ...packOrSplit(perPlate, T8.cap, d - T8.cap, n, D4, true)];
  }
  return packOrSplit(perPlate, 0, d, n + 1, D4, true, D4.cap, start);
}

/** Plates whose dispenses fall in the cumulative range [from, to). */
function platesIn(perPlate, from, to) {
  const out = new Set(); let cum = 0;
  perPlate.forEach((v, p) => { if (v > EPS && cum < to - EPS && cum + v > from + EPS) out.add(p); cum += v; });
  return out;
}

/**
 * k heads for the amounts starting at cumulative `offset`.
 * T8+: plate-by-plate next-fit (plates cut into cap-sized heads when larger than the cap) if the fluid is on
 * several plates and that needs ≤ k heads; else k equal shares. D4+: whole plates next-fit, then largest-first,
 * then equal shares.
 */
function packOrSplit(perPlate, offset, total, k, cas, tryLargestFirst, cap = cas.cap, start = 0) {
  // the part of each plate that belongs to this group (after `offset`)
  let cum = 0; const part = perPlate.map((v) => { const a = Math.max(0, Math.min(v, cum + v - offset)); cum += v; return a; });
  // plates in run order, from the plate the cassette phase starts at (probe-24: the D4+ cassette starts at plate 4)
  const n = part.length, ord = Array.from({ length: n }, (_, i) => (start + i) % n);
  const items = part.map((v, p) => ({ v, p })).filter((x) => x.v > EPS);   // whole-plate packings: plate order
  const itemsRun = ord.map((p) => ({ v: part[p], p })).filter((x) => x.v > EPS); // fill plan: run order
  const equal = () => {
    if (!start) return Array.from({ length: k }, (_, j) => ({ cassette: cas, amount: total / k, equalShare: true, plates: platesIn(perPlate, offset + (j * total) / k, offset + ((j + 1) * total) / k) }));
    const rot = ord.map((p) => part[p]); // cumulative over the rotated order, mapped back to plate numbers
    return Array.from({ length: k }, (_, j) => ({ cassette: cas, amount: total / k, equalShare: true, plates: new Set([...platesIn(rot, (j * total) / k, ((j + 1) * total) / k)].map((i) => ord[i])) }));
  };
  if (cas === T8) return fillPlan(itemsRun, total, k, cap, T8) || equal();
  const nextFit = [];
  for (const it of itemsRun) { // whole plates in run order (probe-25: D4+ phase from plate 3 → plates 3+1 | 2)
    const b = nextFit.at(-1);
    if (b && b.amount + it.v <= cap + TOL) { b.amount += it.v; b.plates.add(it.p); continue; }
    nextFit.push({ amount: it.v, plates: new Set([it.p]) });
  }
  const fits = (bins) => bins.length <= k && bins.every((b) => b.amount <= cap + TOL);
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
  if (cas === D4) { const g = fillPlan(itemsRun, total, k, cap, D4); if (g) return g; } // probe-24 normalization
  return equal();
}

/**
 * Heads for one fluid, plates in run order (T8+: probe-24 and all earlier probes; D4+: after whole-plate
 * next-fit and largest-first, probe-24's normalization):
 *  - a plate joins the current head if it fits whole;
 *  - otherwise a new head starts at the plate boundary if the rest still fits in the remaining heads
 *    (⌈rest / cap⌉ ≤ heads left of k); if not, the current head is filled to the cap across the boundary;
 *  - a plate larger than the cap fills heads to the cap.
 * Used only if at least one head was started at a plate boundary that way; otherwise (and for a single plate)
 * the fluid is split equally across k heads (returns null).
 * probe-24 d2 [5.9 ×4] → 5.9 | 10 | 7.6; d1 [7.8, 7.8, 3.9, 3.9] → 7.8 | 7.8 | 7.8; probe-22n 10×6 + 6 | 10…;
 * probe-22o / 22h: no boundary start possible → equal; D3 IDOTDO 8.7+8.7 | 8.7; probe-11 k4 [14,14,8] → 18 | 18.
 */
function fillPlan(items, total, k, cap, cas) {
  const bins = []; let cur = null, used = 0, resets = 0;
  for (const it of items) {
    let rest = it.v;
    if (cur && cur.amount + rest <= cap + TOL) { cur.amount += rest; cur.plates.add(it.p); cur.parts[it.p] = (cur.parts[it.p] || 0) + rest; used += rest; continue; }
    if (cur) {
      const after = total - used, left = k - bins.length;
      if (Math.ceil((after - TOL) / cap) <= left) { resets++; cur = null; }
      else { const take = cap - cur.amount; cur.amount = cap; cur.plates.add(it.p); cur.parts[it.p] = (cur.parts[it.p] || 0) + take; used += take; rest -= take; cur = null; }
    }
    while (rest > cap + TOL) { bins.push({ amount: cap, plates: new Set([it.p]), parts: { [it.p]: cap } }); used += cap; rest -= cap; }
    if (rest > EPS) { cur = { amount: rest, plates: new Set([it.p]), parts: { [it.p]: rest } }; bins.push(cur); used += rest; }
  }
  if (!resets || bins.length > k) return null;
  return bins.map((b) => ({ cassette: cas, ...b }));
}

/** The wells left after the first `offset` µL (a well split at the boundary keeps its remaining part). */
function wellsAfter(wells, offset) {
  const out = []; let cum = 0;
  for (const w of wells) {
    const end = cum + w.v;
    if (end > offset + EPS) out.push(cum >= offset - EPS ? w : { ...w, v: end - offset });
    cum = end;
  }
  return out;
}
const perPlateOf = (wells, nPlates) => { const a = new Array(nPlates).fill(0); for (const w of wells) a[w.p] += w.v; return a; };

/**
 * Plan the run. Returns { cassettes: [{type, index, heads: [{head, name, fluidId, classId, dispensed, load}]}],
 * fluids: [{name, fluidId, classId, dispensed, load, heads}] } (volumes in µL).
 */
export function planRun(protocol, computed, { highVolume = true } = {}) {
  const items = perPlateAmounts(protocol, computed);
  const nPlates = computed.length;
  const heads = []; // {cassette, amount, plates, it, order, seg, done}
  const add = (it, order, list, seg0) => list.forEach((h, j) => heads.push({ ...h, it, order, seg: seg0 + j, done: false }));
  items.forEach((it, order) => add(it, order, splitFluid(it.perPlate, { highVolume, wells: it.wells }), 0));
  // Run simulation: phases by cassette type (the type fluid 1 needs first), cassettes filled with the heads the
  // run needs first, starting at the plate where the previous cassette finished.
  const firstOf = (hs) => hs.reduce((a, b) => (b.order < a.order || (b.order === a.order && b.seg < a.seg) ? b : a));
  const firstType = heads.length ? firstOf(heads).cassette : T8;
  const types = firstType === D4 ? [D4, T8] : [T8, D4];
  const cassettes = [];
  let current = 0;
  for (let pass = 0; pass < 8 && heads.some((h) => !h.done); pass++) {
    for (const c of types) {
      if (current) { // fluids on this cassette type only are planned from the plate the phase starts at
        // (probe-24/25: D4+ after T8+; probe-26: T8+ after D4+, g3 from plate 3 → 10 | 10 | 9.4 | 5.8)
        for (const it of items) {
          const own = heads.filter((h) => h.it === it);
          if (!own.length || own.some((h) => h.done || h.cassette !== c)) continue;
          const seg0 = Math.max(...own.map((h) => h.seg)) + 1, order = own[0].order;
          for (const h of own) heads.splice(heads.indexOf(h), 1);
          add(it, order, splitFluid(it.perPlate, { highVolume, wells: it.wells, start: current }), seg0);
        }
      }
      for (;;) {
        const remaining = heads.filter((h) => !h.done && h.cassette === c).sort((a, b) => a.order - b.order || a.seg - b.seg);
        if (!remaining.length) break;
        const order = [current, ...Array.from({ length: nPlates }, (_, p) => p).filter((p) => p !== current)];
        const chosen = [];
        for (const p of order) {
          for (const h of remaining) if (chosen.length < c.heads && !chosen.includes(h) && h.plates.has(p)) chosen.push(h);
          if (chosen.length >= c.heads) break;
        }
        for (const h of chosen) h.done = true;
        const visited = order.filter((p) => chosen.some((h) => h.plates.has(p)));
        if (visited.length) current = visited.at(-1);
        const cas = { type: c.type, index: cassettes.length + 1, heads: [] };
        chosen.forEach((h, i) => {
          const isDmso = fluidClass(h.it.classId).isDmso;
          cas.heads.push({ head: i + 1, name: h.it.name, key: h.it.key, fluidId: h.it.fluidId, classId: h.it.classId,
            dispensed: h.amount, load: headLoad(c, h.amount, isDmso), plates: [...h.plates].sort((a, b) => a - b) });
        });
        cassettes.push(cas);
        if (c === D4) { // D4+ overflow: what the next D4+ cassette gets is planned again (probe-24: 2 × 191.2)
          for (const it of new Set(chosen.map((h) => h.it))) {
            const left = heads.filter((h) => !h.done && h.it === it && h.cassette === D4);
            if (!left.length || left.some((h) => !h.parts)) continue;
            const rest = new Array(nPlates).fill(0);
            for (const h of left) for (const [p, v] of Object.entries(h.parts)) rest[+p] += v;
            const d = rest.reduce((a, b) => a + b, 0), k = Math.max(1, Math.ceil((d - TOL) / D4.cap));
            const seg0 = Math.max(...heads.filter((h) => h.it === it).map((h) => h.seg)) + 1, order = left[0].order;
            for (const h of left) heads.splice(heads.indexOf(h), 1);
            add(it, order, packOrSplit(rest, 0, d, k, D4, true, D4.cap, current), seg0);
          }
          continue;
        }
        // T8+ overflow: re-plan what is left of every fluid that got some, but not all, of its heads in this cassette
        if (c !== T8) continue;
        for (const it of new Set(chosen.map((h) => h.it))) {
          const left = heads.filter((h) => !h.done && h.it === it && h.cassette === T8);
          if (!left.length) continue;
          const usedAmount = heads.filter((h) => h.done && h.it === it && h.cassette === T8).reduce((s, h) => s + h.amount, 0);
          const rest = wellsAfter(it.wells, usedAmount);
          for (const h of left) heads.splice(heads.indexOf(h), 1);
          const d4InRun = heads.some((h) => h.cassette === D4 && h.it !== it);
          const seg0 = Math.max(...heads.filter((h) => h.it === it).map((h) => h.seg)) + 1;
          add(it, heads.find((h) => h.it === it)?.order ?? items.indexOf(it), splitFluid(perPlateOf(rest, nPlates), { highVolume: highVolume && d4InRun, wells: rest }), seg0);
        }
      }
    }
  }
  const fluids = items.map((it) => {
    const hs = cassettes.flatMap((c) => c.heads.filter((h) => h.key === it.key).map((h) => ({ ...h, cassette: c.index, type: c.type })));
    // Per-fluid total as the run report's "Loaded Volume" shows it: the unrounded head loads added up and rounded
    // once — to 1 µL when a D4+ head is involved, else 0.1 µL (probe-27a e2: 2 × 202.45 = 404.9 → 405, not
    // 202 + 202; probe-23 normalization 391, not 166 + 226). 61 of 64 fluid rows of the archived completed runs;
    // the 3 misses are T8+-only fluids 0.1 µL low (probe-22l z1, probe-24 d3 and d4). The pre-run summary shows the
    // same total to 0.1 µL for fluids (202.4, 404.9, 640.5) and to 1 µL for normalization.
    // (was: sum of the head loads as shown, 43 of 64)
    const isDmso = fluidClass(it.classId).isDmso;
    const exact = hs.reduce((s, h) => s + headLoadExact(h.type === 'D4+' ? D4 : T8, h.dispensed, isDmso), 0);
    const load = hs.some((h) => h.type === 'D4+') ? roundTo(exact, 0) : roundTo(exact, 1);
    return { name: it.name, fluidId: it.fluidId, classId: it.classId, dispensed: it.perPlate.reduce((s, v) => s + v, 0), load, heads: hs };
  });
  return { cassettes, fluids };
}
