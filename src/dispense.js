// Dispense-volume engine: requested concentrations -> per-well dispense volumes,
// rounded to the dispenser's droplet increments, dispensed concentrations, DMSO %,
// normalization (backfill) volumes and warnings.
//
// Rules come from the vendor user guide (docs/spec_from_user_guide.md §6-§8):
//   V_total = A + ΣV_i + ΣV_vol + N        (A = plate "additional volume" = <AssayVolume>)
//   V_i     = C_i · V_total / S_i          (solved exactly, then rounded per fluid class)
//   C_disp  = S_i · V_i,rounded / V_total,rounded
// Verified against the guide's p.89 report example (tests/dispense.test.js).
// Items marked UNVERIFIED must be confirmed against D300e Control (docs/vm_test_plan.md).

import { splitKey } from './tdd.js';

// ---------- units ----------
// Factors to the protocol base units: µM for molarity, ng/mL for mass, nL for volume.
export const MOLARITY_UNITS = { M: 1e6, mM: 1e3, 'µM': 1, nM: 1e-3, pM: 1e-6 };
export const MASS_UNITS = { mg_mL: 1e6, 'µg_mL': 1e3, ng_mL: 1, pg_mL: 1e-3 };
export const VOLUME_UNITS = { 'µL': 1e3, nL: 1, pL: 1e-3 };
export const unitLabel = (u) => u.replace('_', '/');

export function unitKind(u) {
  if (u in MOLARITY_UNITS) return 'molarity';
  if (u in MASS_UNITS) return 'mass';
  if (u in VOLUME_UNITS) return 'volume';
  throw new Error(`Unknown unit "${u}"`);
}

// UNVERIFIED (docs/format_notes.md): <Concentration> is stored in the protocol base unit
// (µM / ng/mL) and <ConcentrationUnit> is only the display unit.
export function stockInBase(fluid) {
  return fluid.concentration;
}
export const toDisplay = (valueInBase, unit) => valueInBase / ({ ...MOLARITY_UNITS, ...MASS_UNITS, ...VOLUME_UNITS }[unit]);
export const fromDisplay = (value, unit) => value * ({ ...MOLARITY_UNITS, ...MASS_UNITS, ...VOLUME_UNITS }[unit]);

// ---------- fluid classes ----------
// Increments from the guide, Appendix E (p.109-110), standard-volume cassettes; volumes in nL.
// ClassID -> class CONFIRMED with fixtures/reference/t10-classes.tdd (one fluid per class, saved by D300e
// Control 4.0.1). Master-mix classes (group "Master Mix") are dispensed by volume; only ID 12 is known.
const AQ = { isDmso: false, minVolume: 0.011, bands: [[3.6, 0.011], [Infinity, 0.56]] };
const AQG = { isDmso: false, minVolume: 0.012, bands: [[3.6, 0.012], [Infinity, 0.6]] };
export const FLUID_CLASSES = {
  0: { key: 'dmso', group: 'DMSO', label: 'DMSO', short: 'DMSO', isDmso: true, minVolume: 0.013, bands: [[0.017, 0.013], [3.6, 0.02], [Infinity, 0.4]] },
  1: { key: 'aq_tween20', group: 'Aqueous', label: 'Aqueous+Tween 20', short: 'a+Tw', ...AQ },
  2: { key: 'aq_brij35', group: 'Aqueous', label: 'Aqueous+Brij 35', short: 'a+B', ...AQ },
  3: { key: 'aq_tritonx100', group: 'Aqueous', label: 'Aqueous+Triton X100', short: 'a+TX', ...AQ },
  4: { key: 'aq_tween20_gly', group: 'Aqueous', label: 'Aqueous+Tween 20+glycerol', short: 'a+Tw+g', ...AQG },
  5: { key: 'aq_brij35_gly', group: 'Aqueous', label: 'Aqueous+Brij 35+glycerol', short: 'a+B+g', ...AQG },
  6: { key: 'aq_tritonx100_gly', group: 'Aqueous', label: 'Aqueous+Triton X100+glycerol', short: 'a+TX+g', ...AQG },
  12: { key: 'mm_brilliant2_sybr', group: 'Master Mix', label: 'Brilliant II SYBR Green qRT-PCR 1-Step Master Mix', short: 'B2SG', byVolumeOnly: true, ...AQG }, // UNVERIFIED increments
};
export const MAX_VOLUME_PER_FLUID_PER_WELL = 10000; // nL (10 µL), p.109-110
export const MIN_NORMALIZATION_VOLUME = 1; // nL, p.109-110 ("normalization and bulk dispense")

export const fluidClass = (classId) => FLUID_CLASSES[classId] || FLUID_CLASSES[0];

/** Round a requested volume (nL) to the nearest dispensable volume for a fluid class.
 *  Returns 0 for requests below half the minimum droplet (with a warning flag). */
export function roundVolume(v, cls) {
  if (v <= 0) return { volume: 0, belowMin: false };
  if (v < cls.minVolume) {
    // UNVERIFIED: whether sub-minimum requests round up to one drop or are dropped.
    return { volume: v >= cls.minVolume / 2 ? cls.minVolume : 0, belowMin: true };
  }
  let lower = 0;
  for (const [upper, inc] of cls.bands) {
    if (v <= upper || upper === Infinity) {
      // Nearest multiple of the band's increment (UNVERIFIED: tie and band-edge handling).
      // Nearest multiple, ties to even (.NET Math.Round default). Confirmed on the D3 run report:
      // 1.01 nL → 1.00 nL (50.5 × 20 pL → 50). (was: Math.round, ties up)
      let r = roundHalfEven(v / inc) * inc;
      if (r < lower) r = lower;
      return { volume: cleanFloat(r), belowMin: false };
    }
    lower = upper;
  }
  return { volume: v, belowMin: false };
}
const cleanFloat = (x) => Number(x.toPrecision(12));

/**
 * Normalization (backfill) volume as D300e Control 4.0.1 computes it. Derived from the run report of the
 * D3 protocol (fixtures/reference/reports/), which it reproduces for all 536 normalized wells:
 *  - nothing is added when target − ROUNDED current volume < 1 nL (minimum normalization dispense);
 *  - otherwise N = target − EXACT current volume (exact volumes to 0.1 pL), floored to the 400 pL grid
 *    (also below 3.6 nL), and never less than 1 nL.
 * (The guide's older p.89 example rounded to the nearest step: 99.9 → 100 nL.)
 */
export function normalizationVolume(target, currentRounded, currentExact, cls, grid = 0.4, mode = 'floor') {
  if (!(target - currentRounded >= MIN_NORMALIZATION_VOLUME - 1e-9)) return 0;
  const gap = target - Math.round(currentExact * 1e4) / 1e4;
  const n = (mode === 'nearest' ? roundHalfEven(gap / grid) : Math.floor(gap / grid + 1e-9)) * grid;
  return cleanFloat(Math.max(MIN_NORMALIZATION_VOLUME, n));
}

/** "To highest class volume" top-up: nothing below 1 nL; otherwise the gap on the class's drop grid (0.02 nL up to
 *  3.6 nL, then 0.4 nL), rounded up only from 0.51 of a step: floor(steps + 0.49). D3 and T05 bracket the
 *  switch between 0.5084 (down) and 0.5115 (up) of a step; an exact half (T05: 505.0 nL) goes down. Min 1 nL. */
export const TOPUP_ROUND_OFFSET = 0.49;
export function maxVolumeTopUp(gap, cls) {
  if (!(gap >= MIN_NORMALIZATION_VOLUME - 1e-9)) return 0;
  let lower = 0;
  for (const [upper, inc] of cls.bands) {
    if (gap <= upper || upper === Infinity) return cleanFloat(Math.max(MIN_NORMALIZATION_VOLUME, lower, Math.floor(gap / inc + TOPUP_ROUND_OFFSET) * inc));
    lower = upper;
  }
  return gap;
}

/** Largest dispensable volume ≤ v on the class's increment grid. */
export function floorVolume(v, cls) {
  if (v < cls.minVolume) return 0;
  let lower = 0;
  for (const [upper, inc] of cls.bands) {
    if (v <= upper || upper === Infinity) return cleanFloat(Math.max(lower, Math.floor(v / inc + 1e-9) * inc));
    lower = upper;
  }
  return v;
}
export function roundHalfEven(q) {
  const f = Math.floor(q), d = q - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(q);
}

// ---------- per-well computation ----------
/**
 * Compute one well.
 * @param {Map<number,number>} requests  fluidId -> requested value (base conc units, or nL for ByVol fluids)
 * @param {Map<number,object>} fluids    fluidId -> fluid model (from tdd.js)
 * @param {object} plate                 plate model (assayVolume = additional volume A, dmsoLimit fraction)
 * @param {number} normalization         extra DMSO-class volume (nL) from backfill, already rounded
 */
/**
 * @param {number|null} sizingTotal  For wells in a normalization group, D300e Control sizes every fluid
 *   with a fixed well volume = additional volume + the group's target (C·sizingTotal/S, not iterated);
 *   see computeProtocol(). Otherwise volumes solve C = S·V/V_total iteratively (guide Appendix D).
 */
export function computeWell(requests, fluids, plate, normalization = 0, sizingTotal = null) {
  const A = plate.assayVolume;
  const warnings = [];
  let k = 0; // Σ C_i / S_i over concentration-mode fluids
  // Fluid volumes are sized with the normalization volume included in the well total (D3 run report,
  // plate 9: Kynurenin 50 µM → 126.4 nL with 378.4 nL normalization; 125.2 nL without).
  let fixed = A + normalization; // volume-mode fluids add fixed volumes
  const items = [];
  for (const [id, req] of requests) {
    if (!req) continue;
    const f = fluids.get(id);
    if (!f) { warnings.push({ code: 'unknown_fluid', fluidId: id }); continue; }
    if (f.byVol) { fixed += req; items.push({ id, f, mode: 'vol', req }); }
    else {
      const S = stockInBase(f);
      if (!(S > 0)) { warnings.push({ code: 'no_stock', fluidId: id }); continue; }
      if (req >= S) warnings.push({ code: 'above_stock', fluidId: id });
      k += req / S; items.push({ id, f, mode: 'conc', req, S });
    }
  }
  if (k >= 1) {
    warnings.push({ code: 'no_solution' });
    return { fluids: [], totalVolume: NaN, dmsoFraction: NaN, warnings, normalization };
  }
  // D300e Control does not solve V_total = fixed / (1 − k) exactly. It iterates V_i = C_i·T/S_i with
  // T = fixed + ΣV_i, starting from V = 0, and stops once the well total changes by less than 0.1 %
  // (relative to the new total); the fluids are sized with the total of the step before the last.
  // Fitted on simulated run reports: probe-17 (120 single-fluid wells, k = ΣC/S from 0.015 to 0.095 at
  // 50 and 10 µL: 2 steps below k ≈ 0.032, 3 above, the switch where k²/(1+k+k²) crosses 0.1 %, which an
  // absolute nL tolerance cannot fit at both volumes) and probe-15 (two-fluid wells at k = 0.02: 2 steps).
  // (was: a fixed three steps, T = fixed·(1 + k + k²), which agrees only for k between ~0.032 and ~0.25;
  // before that: the exact solution fixed / (1 − k).)
  const vTotalExact = iteratedTotal(fixed, k);
  const out = [];
  for (const it of items) {
    const cls = fluidClass(it.f.classId);
    const exact = it.mode === 'vol' ? it.req : sizingTotal != null ? (it.req * sizingTotal) / it.S : (it.req * vTotalExact) / it.S;
    const { volume, belowMin } = roundVolume(exact, cls);
    if (belowMin) warnings.push({ code: 'below_min_volume', fluidId: it.id, requestedVolume: exact });
    if (volume > MAX_VOLUME_PER_FLUID_PER_WELL) warnings.push({ code: 'above_max_volume', fluidId: it.id, volume });
    out.push({ fluidId: it.id, mode: it.mode, requested: it.req, exactVolume: exact, volume, classId: it.f.classId, S: it.S });
  }
  const totalVolume = cleanFloat(A + normalization + out.reduce((s, x) => s + x.volume, 0));
  let dmsoVol = normalization; // normalization fluid is DMSO class here (UNVERIFIED for non-DMSO classes)
  for (const x of out) {
    if (x.mode === 'conc') x.dispensed = (x.S * x.volume) / totalVolume;
    if (fluidClass(x.classId).isDmso) dmsoVol += x.volume;
  }
  const dmsoFraction = totalVolume > 0 ? dmsoVol / totalVolume : 0;
  // DMSO limit, as D300e Control 4.0.1 flags it ("DMSO limit exceeded"): on the UNROUNDED (sized) volumes,
  // with a 0.1 % relative tolerance: exact DMSO fraction > limit × 1.001. Fitted on probe-12/14/15/16
  // (limits 0.1–10 %, 10 and 50 µL, one- and two-fluid wells; the first flagged and last unflagged wells
  // bracket 1.000999–1.001001 × limit). Normalized wells use the dispensed (rounded) top-up.
  // (was: the rounded fraction compared at 3 decimals of %, which flagged D3 plate 7-9 wells at 1.0005 %
  // that D300e accepts.)
  let exactDmso = normalization, exactTotal = A + normalization;
  for (const x of out) { exactTotal += x.exactVolume; if (fluidClass(x.classId).isDmso) exactDmso += x.exactVolume; }
  const exactFraction = exactTotal > 0 ? exactDmso / exactTotal : 0;
  if (plate.dmsoLimit != null && exactFraction > plate.dmsoLimit * (1 + DMSO_LIMIT_TOLERANCE)) warnings.push({ code: 'dmso_limit', dmsoFraction, limit: plate.dmsoLimit });
  return { fluids: out, totalVolume, dmsoFraction, warnings, normalization, classVolumes: classVolumes(out), exactClassVolumes: classVolumes(out, 'exactVolume') };
}

/** Well total used to size the fluids (see computeWell): fixed-point iteration with a 0.1 % stop. */
export const SIZING_TOLERANCE = 1e-3;
export const DMSO_LIMIT_TOLERANCE = 1e-3; // relative, see computeWell
export function iteratedTotal(fixed, k) {
  let prev = fixed; // T_0: no fluid volume yet
  for (let n = 1; n <= 100; n++) {
    const next = fixed + k * prev; // T_n = fixed + V_n, V_n = k·T_(n−1)
    // The check starts at the second step: at least two steps are always taken (D3 report: MEN-only wells,
    // k = 0.0003, need V_2 = k·A·(1 + k) for their DMSO top-up to floor to 1.0 nL rather than 1.2 nL).
    if (n >= 2 && Math.abs(next - prev) / next < SIZING_TOLERANCE) return prev; // V_n was sized with T_(n−1)
    prev = next;
  }
  return prev;
}

function classVolumes(out, field = 'volume') {
  const m = new Map();
  for (const x of out) m.set(x.classId, (m.get(x.classId) || 0) + x[field]);
  return m;
}

/** Valid concentration range for a fluid on a plate (guide p.23/25: one-drop minimum to DMSO limit).
 *  sharedBy: number of fluids sharing the DMSO limit — the Synergy wizard divides it evenly
 *  (confirmed: 10 mM, 1 %: 1 fluid 100 µM, 2 fluids 50 µM (T06), 3 fluids 33.3 µM (T07)). */
export function validRange(fluid, plate, sharedBy = 1) {
  const cls = fluidClass(fluid.classId);
  const S = stockInBase(fluid), A = plate.assayVolume;
  const min = (S * cls.minVolume) / (A + cls.minVolume);
  const max = cls.isDmso && plate.dmsoLimit ? (S * plate.dmsoLimit) / sharedBy : S * MAX_VOLUME_PER_FLUID_PER_WELL / (A + MAX_VOLUME_PER_FLUID_PER_WELL);
  return { min, max };
}

// ---------- whole protocol ----------
/**
 * Compute every well of every plate, including normalization (backfill) blocks.
 * Normalization semantics (guide p.32-34, INFERRED mapping to XML):
 *   ToMaxVolume      : class volume topped up to the highest class volume in the group
 *   ToVolume         : class volume topped up to Param nL
 *   ToAssayVolumePct : class volume brought to Param × total well volume (total includes N)
 *   ToMaxTotalVolume : total well volume topped up to the highest total in the group
 *   ToTotalVolume    : total well volume topped up to Param nL
 *   (group scope = the whole block across its plates: UNVERIFIED)
 *   Volumes < 1 nL are not normalized (minimum normalization dispense 1 nL).
 */
export function computeProtocol(protocol) {
  const fluids = new Map(protocol.fluids.map((f) => [f.id, f]));
  const result = protocol.plates.map((plate) => {
    const wells = new Map();
    for (const [key, req] of plate.wells) wells.set(key, computeWell(req, fluids, plate, 0));
    return { plate, wells };
  });
  const emptyReq = new Map();
  for (const b of protocol.backfills) {
    const cls = fluidClass(b.classId);
    const sel = b.wells.filter((w) => result[w.p]);
    const base = sel.map((w) => {
      const plate = result[w.p].plate, key = `${w.r},${w.c}`;
      const r = result[w.p].wells.get(key) || computeWell(emptyReq, fluids, plate, 0);
      return { w, key, plate, req: plate.wells.get(key) || emptyReq,
        classVol: (r.classVolumes && r.classVolumes.get(b.classId)) || 0,
        exactClassVol: (r.exactClassVolumes && r.exactClassVolumes.get(b.classId)) || 0,
        exactAll: (r.fluids || []).reduce((s, f) => s + f.exactVolume, 0) }; // unnormalized, before any well of the group is updated
    });
    // Type names confirmed in fixtures/reference/t05-normalize.tdd (one row per UI option).
    // "Total" volume = additional volume + every dispensed fluid (all classes), before normalization.
    for (const x of base) {
      const r = result[x.w.p].wells.get(x.key);
      x.totalVol = r && Number.isFinite(r.totalVolume) ? r.totalVolume : x.plate.assayVolume;
    }
    const maxClass = Math.max(0, ...base.map((x) => x.classVol));
    const maxExactClass = Math.max(0, ...base.map((x) => x.exactClassVol));
    const maxTotal = Math.max(0, ...base.map((x) => x.totalVol));
    for (const x of base) {
      // Target of the group, and the fixed well volume used to size the fluids of a normalized well.
      // Derived from the D3 run report (fixtures/reference/reports/): ToMaxVolume plates 1-2 and
      // ToAssayVolumePct plates 7-9 reproduce every dispensed volume with sizing = A + class target.
      const A = x.plate.assayVolume;
      let target, sizing, totalBased = false;
      switch (b.type) {
        // Target = the largest UNROUNDED class volume of the group (fluids sized as usual, no normalization);
        // every well's fluids are then sized with the fixed total A + target. Fitted on D3 plates 1-2 (616
        // wells) and T05 row A plus two one-change copies (72 wells): 688/688 top-ups.
        // (was: target = largest rounded class volume, iterative sizing incl. N, top-up floored — 637/688)
        case 'ToMaxVolume': target = maxExactClass; sizing = A + target; break;
        case 'ToVolume': target = b.param; sizing = A + target; break; // UNVERIFIED sizing
        // Fluids are sized with a fixed well volume A·(1+p); the class target is p × that volume, and the
        // top-up rounds to nearest (ties to even). Fitted on the D3 report, plate 9 (308 normalized wells).
        case 'ToAssayVolumePct': sizing = A * (1 + b.param); target = b.param * sizing; break;
        case 'ToMaxTotalVolume': target = maxTotal; sizing = target; totalBased = true; break; // UNVERIFIED sizing
        case 'ToTotalVolume': target = b.param; sizing = target; totalBased = true; break; // UNVERIFIED sizing
        default: continue; // unknown type: leave unnormalized
      }
      if (b.type !== 'ToAssayVolumePct') {
        const { n, t } = iteratedTopUp(x, base, b, A, totalBased, target, fluids, cls, result);
        // fluids of a normalized well are sized with the group's final target total (A + class target, or the total)
        const r = computeWell(x.req, fluids, x.plate, n, b.type === 'ToMaxVolume' ? A + t : b.type === 'ToMaxTotalVolume' ? t : sizing);
        r.normalizationRequested = n;
        result[x.w.p].wells.set(x.key, r);
        continue;
      }
      // The gap uses the volumes as sized for this group: iterative for ToMaxVolume, A·(1+p) for % of total.
      const r0 = computeWell(x.req, fluids, x.plate, 0, sizing);
      const cr = (r0.classVolumes && r0.classVolumes.get(b.classId)) || 0;
      const ce = (r0.exactClassVolumes && r0.exactClassVolumes.get(b.classId)) || 0;
      const curRounded = totalBased ? r0.totalVolume : cr;
      const curExact = totalBased ? r0.totalVolume - cr + ce : ce;
      // Rounding of the top-up: floor for ToMaxVolume (plates 1-2), nearest for % of total (plate 9).
      const n = b.type === 'ToMaxVolume' ? maxVolumeTopUp(target - curExact, cls)
        : normalizationVolume(target, curRounded, curExact, cls, 0.4, b.type === 'ToAssayVolumePct' ? 'nearest' : 'floor');
      const r = computeWell(x.req, fluids, x.plate, n, sizing);
      r.normalizationRequested = target - curExact;
      result[x.w.p].wells.set(x.key, r);
    }
  }
  return result;
}

/**
 * Top-up for the "to volume / to highest / to total" normalization types, as D300e Control 4.0.1 computes it
 * (fitted on D3, T05 + two copies, probe-20 and probe-21; see docs/format_notes.md):
 *  - k = Σ C/S of the well's fluids (class fluids for class types, all fluids for total types);
 *  - start from the well's unnormalized volumes (V) and, for the "highest" types, the group's largest well's
 *    unnormalized volume as target t;
 *  - step: N = t − V (class) or t − (A + V) (total); stop when N changed by < 0.08 % (relative to the new N)
 *    and keep the previous N; otherwise V ← k·(A + N + V) and, for "highest" types, the target's own well
 *    ← k_max·(A + its volume) — the target moves with the iteration;
 *  - round N on the drop grid: "to highest class volume" with floor(steps + 0.49) (D3: 15.4034 → 15.2), the
 *    others to nearest (ties even); nothing below 1 nL; at least 1 nL.
 *  Matches every top-up of D3 and T05 (+ copies); probe-20/21 hold-outs: to-highest 498/505, to-volume 392/396,
 *  to-total 52/66, to-highest-total 44/65 (each miss one 0.4 nL step).
 */
const TOPUP_TOLERANCE = 0.0008;
function iteratedTopUp(x, base, b, A, totalBased, fixedTarget, fluids, cls, result) {
  const kOf = (req, classOnly) => { let k = 0; for (const [id, c] of req) { const f = fluids.get(id); if (!f || f.byVol || !c) continue; if (classOnly && f.classId !== b.classId) continue; k += c / stockInBase(f); } return k; };
  const exactOf = (y, classOnly) => (classOnly ? y.exactClassVol : y.exactAll); // snapshot taken before the group
  const highest = b.type === 'ToMaxVolume' || b.type === 'ToMaxTotalVolume';
  let km = 0, tV = 0;
  if (highest) {
    for (const y of base) { const v = exactOf(y, !totalBased); if (v > tV) { tV = v; km = kOf(y.req, !totalBased); } }
  }
  const k = kOf(x.req, !totalBased), kAll = kOf(x.req, false);
  let V = exactOf(x, !totalBased), Vall = exactOf(x, false);
  let Nprev = null, N = 0, t = 0;
  for (let it = 0; it < 100; it++) {
    t = highest ? (totalBased ? A + tV : tV) : fixedTarget;
    N = totalBased ? t - (A + V) : t - V;
    if (Nprev != null && Math.abs(N - Nprev) / Math.max(Math.abs(N), 1e-12) < TOPUP_TOLERANCE) { N = Nprev; break; }
    Nprev = N;
    const T = A + N + Vall;
    V = k * T; Vall = kAll * T;
    if (highest) tV = km * (A + tV);
  }
  if (!(N >= MIN_NORMALIZATION_VOLUME - 1e-9)) return { n: 0, t };
  let lower = 0;
  for (const [upper, inc] of cls.bands) {
    if (N <= upper || upper === Infinity) return { n: cleanFloat(Math.max(MIN_NORMALIZATION_VOLUME, lower, (b.type === 'ToMaxVolume' ? Math.floor(N / inc + 0.49) : roundHalfEven(N / inc)) * inc)), t };
    lower = upper;
  }
  return { n: N, t };
}

function solvePctNormalization(x, p, fluids, classId) {
  // Find N >= 0 with classVol(N) + N = p · V_total(N); fixed-point iteration (guide: "iteratively").
  let n = 0;
  for (let i = 0; i < 50; i++) {
    const r = computeWell(x.req, fluids, x.plate, n);
    if (!Number.isFinite(r.totalVolume)) return 0;
    const cv = (r.classVolumes && r.classVolumes.get(classId)) || 0;
    // exact (unrounded) update: N = (p·(V_total − N) − cv) / (1 − p)
    const next = Math.max(0, (p * (r.totalVolume - n) - cv) / (1 - p));
    if (Math.abs(next - n) < 1e-9) return next;
    n = next;
  }
  return n;
}

/** Totals per fluid across the protocol (for the run summary / cassette loading). */
export function fluidTotals(computed) {
  const totals = new Map();
  for (const { wells } of computed) for (const r of wells.values()) {
    for (const x of r.fluids) {
      const t = totals.get(x.fluidId) || { volume: 0, wells: 0, minVolume: Infinity };
      t.volume += x.volume; t.wells += x.volume > 0 ? 1 : 0; if (x.volume > 0) t.minVolume = Math.min(t.minVolume, x.volume);
      totals.set(x.fluidId, t);
    }
  }
  return totals;
}

export { splitKey };

// ---------- priming / scrap well (guide Appendix F, p.113) ----------
// "it is recommended that the first plate using a fluid includes a well with volume of 30 nL or
// greater ... Since plate dispense order can vary, it is recommended that all plates follow this
// recommendation. ... consider dedicating one 'scrap' well on each plate to a larger dispense volume.
// This same well can be used for all fluids on the plate."
export const PRIMING_VOLUME = 30; // nL

/** For each plate, the fluids used on it whose largest dispense is < 30 nL. */
export function primingIssues(protocol, computed) {
  return computed.map(({ wells }, p) => {
    const maxVol = new Map();
    for (const r of wells.values()) for (const x of r.fluids) maxVol.set(x.fluidId, Math.max(maxVol.get(x.fluidId) || 0, x.volume));
    const lacking = [...maxVol.entries()].filter(([, v]) => v > 0 && v < PRIMING_VOLUME - 1e-9).map(([fluidId, maxVolume]) => ({ fluidId, maxVolume }));
    return { plate: p, lacking };
  });
}

/** Concentrations (protocol units) that give ≥ 30 nL of each listed fluid when all share one well.
 *  Rounded UP to 3 significant digits so the values are readable, as in hand-made protocols. */
export function scrapWellValues(fluids, plate, volume = PRIMING_VOLUME) {
  const total = plate.assayVolume + volume * fluids.length;
  return fluids.map((f) => {
    if (f.byVol) return [f.id, volume];
    const exact = (stockInBase(f) * volume) / total;
    const mag = Math.pow(10, Math.floor(Math.log10(exact)) - 2);
    return [f.id, Math.ceil(exact / mag - 1e-9) * mag];
  });
}
