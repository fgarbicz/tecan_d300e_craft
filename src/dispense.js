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
      // Nearest multiple of the band's increment like .NET Math.Round on v / inc in doubles: exact binary ties to
      // even, no tolerance (probe-26 A1: 60·50900/10000 = 305.39999999999998 → 305.2; probe-25 L13:
      // 136·50750/10000 = 690.2000000000000455 → 690.4; D3 1.01 nL → 1.00). (was: ties within 1e-9 to even)
      let r = roundHalfEvenStrict(v / inc) * inc;
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
    // The check starts at the first step: a well with k < 0.001 is sized at the bare fixed volume (probe-22l E14,
    // k = 0.000684: 34.185 → 34.0; probe-26 g3 0.01 µM: 0.25 → 0.24). (was: from the second step, for D3's
    // MEN-only wells — their top-up is now computed by iteratedTopUp, which never used this.)
    if (Math.abs(next - prev) / next < SIZING_TOLERANCE) return prev; // V_n was sized with T_(n−1)
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
        // Target and top-up come from iteratedTopUp (moving target); this target only seeds it.
        // (was: largest unrounded class volume, fixed sizing A + target, 0.49 rounding — hold-out 888/1007)
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
        const { n, t, sizing: totalSizing } = iteratedTopUp(x, base, b, A, totalBased, target, fluids, cls);
        // fluids of a normalized well are sized with the group's final target total (A + class target, or the total)
        const r = computeWell(x.req, fluids, x.plate, n, b.type === 'ToMaxVolume' ? A + t : totalSizing ?? (b.type === 'ToMaxTotalVolume' ? t : sizing));
        r.normalizationRequested = n;
        result[x.w.p].wells.set(x.key, r);
        continue;
      }
      if (b.type === 'ToAssayVolumePct') {
        const { n, sizing: pctSizing } = pctTopUp(x.req, fluids, b, A, b.param, cls);
        const r = computeWell(x.req, fluids, x.plate, n, pctSizing);
        r.normalizationRequested = n;
        result[x.w.p].wells.set(x.key, r);
        continue;
      }
      // (unused since every type has its own model; kept for reference: the earlier one-step rules)
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
 * Top-up for the "to volume / to highest / to total" normalization types, as D300e Control 4.0.1 computes it.
 * Fitted on probe-21 (single-fluid sweep, k = ΣC/S 1e-5…0.011; plate 2 "to 560 nL" pins the stop rule, plate 1
 * "to highest" the target) and checked on D3, T05 + two one-change copies and probe-20:
 *  - volumes are C·T/S per fluid, summed (this float order decides exact rounding ties: D3 N2, T05 A5);
 *  - the well starts from its fluids sized at the bare assay volume, V₀ = Σ C·A/S;
 *  - "highest" types: the target is the group's largest well, sized like any well but with the convergence check
 *    from the FIRST step (D3: k_max 0.00032 stays at Σ C·A/S; probe-21: k_max 0.011 takes one step), and it then
 *    takes one more step with every iteration of the well, t_V ← Σ C·(A + t_V)/S;
 *  - step i: N = t − V (class) or t − (A + V) (total); V ← Σ C·(A + N + V_all)/S;
 *  - stop when the well's fluid volume changed by < 0.1 % of N (|ΔV| / N, SIZING_TOLERANCE) and keep the
 *    PREVIOUS N; "total" types first take a step from V = 0 (N = t − A), so a well whose fluids add < 0.1 % of N
 *    gets the full t − A (probe-20: 0.38–0.66 nL of drug → 700 nL);
 *  - round N to the drop grid like .NET Math.Round (nearest, exact binary ties to even); none below 1 nL; ≥ 1 nL.
 * Result: probe-21 1320/1321 rows (L20 sits 0.0002 steps below a tie), D3 / T05 ×3 exact; probe-20 (not used to
 * derive it): to-highest 175/175, to-volume 66/66, to-total 58/66, to-highest-total 44/65 — OPEN: in both total
 * types some wells come out one 0.4 nL step low (K8 vs K9: similar wells, opposite sides), and under
 * to-highest-total empty wells get 290.4 = the largest well's DISPENSED total while others follow the exact one.
 * (was: start from the sized volumes, |ΔN|/N < 0.08 %, floor(steps + 0.49) for "highest": probe-21 1312/1321)
 */
function iteratedTopUp(x, base, b, A, totalBased, fixedTarget, fluids, cls) {
  const conc = (req, classOnly) => {
    const out = [];
    for (const [id, c] of req) { const f = fluids.get(id); if (!f || f.byVol || !c) continue; if (classOnly && f.classId !== b.classId) continue; out.push([c, stockInBase(f)]); }
    return out;
  };
  const vol = (cs, T) => { let v = 0; for (const [c, S] of cs) v += (c * T) / S; return v; };
  const exactOf = (y, classOnly) => (classOnly ? y.exactClassVol : y.exactAll); // snapshot taken before the group
  const highest = b.type === 'ToMaxVolume' || b.type === 'ToMaxTotalVolume';
  let tC = null, tV = 0;
  if (highest) {
    let best = -Infinity, bestY = null;
    for (const y of base) { const v = exactOf(y, !totalBased); if (v > best) { best = v; bestY = y; } }
    tC = conc(bestY.req, !totalBased);
    let prev = A;
    for (let n = 1; n <= 100; n++) { const next = A + vol(tC, prev); if (Math.abs(next - prev) / next < SIZING_TOLERANCE) break; prev = next; }
    tV = vol(tC, prev);
  }
  const cC = conc(x.req, !totalBased), cAll = conc(x.req, false);
  if (b.type === 'ToTotalVolume') return totalTopUp(cAll, vol, A, fixedTarget - A, cls);
  if (b.type === 'ToMaxTotalVolume') return maxTotalTopUp(tC, cAll, vol, A, tV, cls);
  let V = vol(cC, A), Vall = vol(cAll, A);
  let Nprev = null, Vprev = null, N = 0, t = 0;
  if (totalBased) { // "total" types: the current total starts at the bare assay volume, one step from V = 0 first
    const t0 = highest ? A + tV : fixedTarget;
    Nprev = t0 - A; Vprev = 0;
  }
  for (let it = 0; it < 100; it++) {
    t = highest ? (totalBased ? A + tV : tV) : fixedTarget;
    N = totalBased ? t - (A + V) : t - V;
    if (Nprev != null && Math.abs(V - Vprev) / Math.max(Math.abs(N), 1e-12) < SIZING_TOLERANCE) { N = Nprev; break; }
    Nprev = N; Vprev = V;
    const T = A + N + Vall;
    V = vol(cC, T); Vall = vol(cAll, T);
    if (highest) tV = vol(tC, A + tV);
  }
  if (!(N >= MIN_NORMALIZATION_VOLUME - 1e-9)) return { n: 0, t };
  let lower = 0;
  for (const [upper, inc] of cls.bands) {
    if (N <= upper || upper === Infinity) return { n: cleanFloat(Math.max(MIN_NORMALIZATION_VOLUME, lower, roundHalfEvenStrict(N / inc) * inc)), t };
    lower = upper;
  }
  return { n: N, t };
}

/**
 * "% of assay volume" (class volume = p × total), fitted on D3 plate 9 (308 wells, small volumes) and probe-25
 * (blind run, 768 wells up to 860 nL of drug): 1076/1076 top-ups and fluid volumes. Iteration from T₀ = A·(1 + p):
 *   Vᵢ = Σ C·Tᵢ/S (class), Nᵢ = p·Tᵢ − Vᵢ₋₁ (lagged; V₋₁ = V₀), Tᵢ₊₁ = A + Nᵢ + Vᵢ(all fluids)
 * stop at the first j ≥ 1 with |Vⱼ − Vⱼ₋₁| / Nⱼ < 0.1 % (at most 4), top-up Nⱼ₋₁, fluids sized at Tⱼ. A well whose
 * fluids already reach the target (top-up < 1 nL) gets none and is sized like an unnormalized well (probe-25 L19+).
 * (was: fluids at A·(1 + p), target p·A·(1 + p) — exact on D3, one step off on probe-25's largest top-ups.)
 */
function pctTopUp(req, fluids, b, A, p, cls) {
  const cC = [], cAll = [];
  for (const [id, c] of req) { const f = fluids.get(id); if (!f || f.byVol || !c) continue; cAll.push([c, stockInBase(f)]); if (f.classId === b.classId) cC.push([c, stockInBase(f)]); }
  const vol = (cs, T) => { let v = 0; for (const [c, S] of cs) v += (c * T) / S; return v; };
  const Ts = [], Vs = [], Ns = [];
  let T = A + A * p; // = A·(1 + p) in the float order D300e uses (probe-25 L13: 136·50750/10000 sits on a tie)
  for (let i = 0; i < 6; i++) {
    const V = vol(cC, T), N = p * T - (i ? Vs[i - 1] : V);
    Ts.push(T); Vs.push(V); Ns.push(N);
    T = A + N + vol(cAll, T);
  }
  let j = 4;
  for (let k = 1; k <= 4; k++) if (Math.abs(Vs[k] - Vs[k - 1]) / Math.max(Math.abs(Ns[k]), 1e-12) < SIZING_TOLERANCE) { j = k; break; }
  const N = Ns[j - 1];
  if (!(N >= MIN_NORMALIZATION_VOLUME - 1e-9)) return { n: 0, sizing: undefined };
  let lower = 0;
  for (const [upper, inc] of cls.bands) {
    if (N <= upper || upper === Infinity) return { n: cleanFloat(Math.max(MIN_NORMALIZATION_VOLUME, lower, roundHalfEvenStrict(N / inc) * inc)), sizing: Ts[0] };
    lower = upper;
  }
  return { n: N, sizing: Ts[0] };
}

/**
 * "To total volume" (gap = target total − A), fitted on probe-23 plate 1 (single-fluid k sweep, 330 wells:
 * top-ups 330/330, fluid volumes 329/330). A lagged iteration from V = 0, N = 0:
 *   Tᵢ = A + Nᵢ₋₁ + Vᵢ₋₁,  Vᵢ = Σ C·Tᵢ/S,  Nᵢ = gap − Vᵢ₋₁
 * stops at the first i with |Vᵢ − Vᵢ₋₁| / Nᵢ < 0.1 % and returns Nᵢ (at most 4 steps, i ≤ 3: the three
 * largest-k wells stop at i = 3 although their ratio is 0.10–0.11 %). Wells whose fluids add < 0.1 % of the gap
 * therefore get the whole gap. The fluids are dispensed as sized at step j = min(max(i, 1), 2), i.e. with Tⱼ.
 * The fluids' sizing step is independent of i: see below (probe-27b).
 */
function totalTopUp(cs, vol, A, gap, cls) {
  // the sequence (Tᵢ, Vᵢ, Nᵢ) for i = 0…3
  const Ts = [], Vs = [], Ns = [];
  let Vp = 0, Np = 0;
  for (let k = 0; k < 4; k++) { const T = A + Np + Vp, V = vol(cs, T), N = gap - Vp; Ts.push(T); Vs.push(V); Ns.push(N); Vp = V; Np = N; }
  let i = 3;
  for (let k = 0; k < 4; k++) if (Math.abs(Vs[k] - (k ? Vs[k - 1] : 0)) / Math.max(Math.abs(Ns[k]), 1e-12) < SIZING_TOLERANCE) { i = k; break; }
  // Fluid sizing: the well total Tⱼ of this same sequence is iterated like any well's total (computeWell) — stop
  // when it changes by < 0.1 % and keep the step before: T₁ if |T₂ − T₁| / T₂ < 0.1 % (≈ k < 0.001), else T₂.
  // probe-27b (blind, 2026-11-16; gaps 400 / 700 / 1000 nL, k 0.00075…0.001, 924 wells): the fluid is V₁ in every
  // well, also where the top-up has already moved on to N₂ and where |V₁ − V₀| is 0.112 % of N₀; probe-23: V₂ from
  // k = 0.00148 on. Independent of the top-up's stop step i.
  // (was: Ts[min(max(i, 1), 2)], then "first j with |Vⱼ − Vⱼ₋₁| / Nⱼ₋₁ < 0.1 %" — fitted on probe-23 E21 alone and
  //  refuted by probe-27b: 29 of 85 informative wells one 0.4 nL step low.)
  let j = 1;
  if (Math.abs(Ts[2] - Ts[1]) / Ts[2] >= SIZING_TOLERANCE) j = 2;
  const N = Ns[i], sizing = Ts[j];
  if (!(N >= MIN_NORMALIZATION_VOLUME - 1e-9)) return { n: 0, t: A + gap, sizing };
  let lower = 0;
  for (const [upper, inc] of cls.bands) {
    if (N <= upper || upper === Infinity) return { n: cleanFloat(Math.max(MIN_NORMALIZATION_VOLUME, lower, roundHalfEvenStrict(N / inc) * inc)), t: A + gap, sizing };
    lower = upper;
  }
  return { n: N, t: A + gap, sizing };
}

/**
 * "To highest total volume". Fitted on probe-23 plate 2 (single-fluid sweep, k = 1e-5 … 0.011, 331 wells) on
 * 2026-11-16 after probe-27b had pinned the "to total" rules it builds on; probe-20's two-fluid group is the check.
 *  - Target: the group's largest well. Its plain sizing (convergence check from the first step) gives a seed
 *    s = Σ C·T/S; the well is then sized like a "to total" well with gap s — T₁ = A + s + V₀, T₂ = A + (s − V₀) + V₁,
 *    T₂ if the total still moves by ≥ 0.1 % — and the target gap g is its fluid volume at that total
 *    (probe-23: s = 556.05, g = 556.2504; the well dispenses 556.4 nL, empty wells get 556.4 nL).
 *  - Every well: top-up N = g − X, where X runs through X₀ = V(A), X₁ = V(A + 2g), X₂ = V(T₂) with the lagged
 *    T₂ = A + (g − X₀) + V(A + g + X₀), and stops at the first step whose change is < 0.1 % of the top-up:
 *    |X₁ − X₀| / (g − X₀) → X₀;  |X₂ − X₁| / (g − X₁) → X₁;  else X₂ (no further step: wells with 27 nL of top-up
 *    still use X₂). On probe-23 the switches sit at k = 4.67e-4 | 4.88e-4 and 8.81e-4 | 9.19e-4, exactly where
 *    these two ratios cross 0.1 %. (X₁'s total A + 2g counts the first top-up twice — N₀ + N₁ + V₀ — which is what
 *    the reported volumes show: 15/15 wells of that band; g − V₁ fits 4.)
 *  - Fluids: sized at T₂.
 *  Result: probe-23 plate 2 660/665 rows, probe-20 1007/1007 (all five types). Left on probe-23: four fluid
 *  volumes 0.0004–0.006 steps below a rounding tie (G3, I19, K6, N4) and one top-up 0.013 steps above one (L8).
 *  Blind validation, probe-30 (three unseen groups; 50 µL one fluid, 20 µL two fluids, largest well with two
 *  fluids): 1222/1239 rows as predicted; with the T₂ sizing above 1232/1239 — plates 1 and 3 exact. OPEN on the
 *  20 µL plate (7 rows, 5 wells): three top-ups 0.012–0.025 steps from a tie in both directions (E12, H3, G23), one
 *  fluid 0.046 steps (E14), and I15 (k = 0.0179, top-up 44 nL), which matches one more step (X₃, T₃) although wells
 *  with larger relative changes (up to 0.7 % of the top-up) stay at step 2.
 * (was: the "to highest" class model with a moving target — fluids 305/331, top-ups 216/334 on that plate.)
 */
function maxTotalTopUp(cT, cAll, vol, A, s, cls) {
  const tT0 = vol(cT, A), tT1 = A + s + tT0, tT2 = A + (s - tT0) + vol(cT, tT1);
  const g = vol(cT, Math.abs(tT2 - tT1) / tT2 >= SIZING_TOLERANCE ? tT2 : tT1);
  const X0 = vol(cAll, A), T1 = A + g + X0, T2 = A + (g - X0) + vol(cAll, T1);
  const X1 = vol(cAll, A + 2 * g), X2 = vol(cAll, T2);
  const small = (d, n) => Math.abs(d) / Math.max(Math.abs(n), 1e-12) < SIZING_TOLERANCE;
  const X = small(X1 - X0, g - X0) ? X0 : small(X2 - X1, g - X1) ? X1 : X2;
  // fluids: always at T₂ (probe-30, blind: sizing at T₁ for the X₀ / X₁ bands left 10 fluid rows one step high;
  // on probe-23 the two totals round alike in those bands, so that run could not tell)
  // (was: T₂ only once the top-up used X₂, else T₁)
  const N = g - X, sizing = T2;
  if (!(N >= MIN_NORMALIZATION_VOLUME - 1e-9)) return { n: 0, t: A + g, sizing };
  let lower = 0;
  for (const [upper, inc] of cls.bands) {
    if (N <= upper || upper === Infinity) return { n: cleanFloat(Math.max(MIN_NORMALIZATION_VOLUME, lower, roundHalfEvenStrict(N / inc) * inc)), t: A + g, sizing };
    lower = upper;
  }
  return { n: N, t: A + g, sizing };
}

/** .NET Math.Round(double): nearest, ties (exactly .5 in binary) to even; no tolerance. */
function roundHalfEvenStrict(q) {
  const f = Math.floor(q), d = q - f;
  if (d === 0.5) return f % 2 === 0 ? f : f + 1;
  return d < 0.5 ? f : f + 1;
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

/**
 * Compounds: a diluted stock made by fluid shift/extend ("Drug - 1:30", RootFluidID = the original fluid) is the
 * same compound as its root. Returns { roots: [fluid], rootOf(id) → root fluid id }. Requested well values are
 * concentrations in the well, so the stock and its dilution add up on one compound axis.
 */
export function compounds(fluids) {
  const byId = new Map(fluids.map((f) => [f.id, f]));
  const rootId = (f) => { let x = f; for (let i = 0; i < 20 && x.rootFluidId != null && byId.has(x.rootFluidId) && x.rootFluidId !== x.id; i++) x = byId.get(x.rootFluidId); return x.id; };
  const map = new Map(fluids.map((f) => [f.id, rootId(f)]));
  return { roots: fluids.filter((f) => map.get(f.id) === f.id), rootOf: (id) => map.get(id) ?? id };
}
