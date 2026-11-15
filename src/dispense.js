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
// The ClassID -> class mapping is UNVERIFIED except that ClassID 0 holds DMSO drug stocks
// in the reference file (and the plate DMSO limit applies to it).
export const FLUID_CLASSES = {
  0: { key: 'dmso', label: 'DMSO', isDmso: true, minVolume: 0.013, bands: [[0.017, 0.013], [3.6, 0.02], [Infinity, 0.4]], unverifiedId: false },
  1: { key: 'aqueous', label: 'Aqueous + surfactant', isDmso: false, minVolume: 0.011, bands: [[3.6, 0.011], [Infinity, 0.56]], unverifiedId: true },
  2: { key: 'aqueous_glycerol', label: 'Aqueous + glycerol', isDmso: false, minVolume: 0.012, bands: [[3.6, 0.012], [Infinity, 0.6]], unverifiedId: true },
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
      let r = Math.round(v / inc) * inc;
      if (r < lower) r = lower;
      return { volume: cleanFloat(r), belowMin: false };
    }
    lower = upper;
  }
  return { volume: v, belowMin: false };
}
const cleanFloat = (x) => Number(x.toPrecision(12));

// ---------- per-well computation ----------
/**
 * Compute one well.
 * @param {Map<number,number>} requests  fluidId -> requested value (base conc units, or nL for ByVol fluids)
 * @param {Map<number,object>} fluids    fluidId -> fluid model (from tdd.js)
 * @param {object} plate                 plate model (assayVolume = additional volume A, dmsoLimit fraction)
 * @param {number} normalization         extra DMSO-class volume (nL) from backfill, already rounded
 */
export function computeWell(requests, fluids, plate, normalization = 0) {
  const A = plate.assayVolume;
  const warnings = [];
  let k = 0; // Σ C_i / S_i over concentration-mode fluids
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
  const vTotalExact = fixed / (1 - k);
  const out = [];
  for (const it of items) {
    const cls = fluidClass(it.f.classId);
    const exact = it.mode === 'vol' ? it.req : (it.req * vTotalExact) / it.S;
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
  // UNVERIFIED: whether the check is > or >= and whether it uses rounded volumes.
  if (plate.dmsoLimit != null && dmsoFraction > plate.dmsoLimit + 1e-12) warnings.push({ code: 'dmso_limit', dmsoFraction, limit: plate.dmsoLimit });
  return { fluids: out, totalVolume, dmsoFraction, warnings, normalization, classVolumes: classVolumes(out) };
}

function classVolumes(out) {
  const m = new Map();
  for (const x of out) m.set(x.classId, (m.get(x.classId) || 0) + x.volume);
  return m;
}

/** Valid concentration range for a fluid on a plate (guide p.23/25: one-drop minimum to DMSO limit). */
export function validRange(fluid, plate) {
  const cls = fluidClass(fluid.classId);
  const S = stockInBase(fluid), A = plate.assayVolume;
  const min = (S * cls.minVolume) / (A + cls.minVolume);
  const max = cls.isDmso && plate.dmsoLimit ? S * plate.dmsoLimit : S * MAX_VOLUME_PER_FLUID_PER_WELL / (A + MAX_VOLUME_PER_FLUID_PER_WELL);
  return { min, max };
}

// ---------- whole protocol ----------
/**
 * Compute every well of every plate, including normalization (backfill) blocks.
 * Normalization semantics (guide p.32-34, INFERRED mapping to XML):
 *   ToMaxVolume      : each selected well is topped up with class fluid to the highest
 *                      class volume among the block's selected wells (UNVERIFIED: scope is the
 *                      whole block across its plates, not per plate).
 *   ToAssayVolumePct : class volume brought to Param × total well volume (total includes N).
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
      return { w, key, plate, req: plate.wells.get(key) || emptyReq, classVol: (r.classVolumes && r.classVolumes.get(b.classId)) || 0 };
    });
    const target = b.type === 'ToMaxVolume' ? Math.max(0, ...base.map((x) => x.classVol)) : null;
    for (const x of base) {
      let n = 0;
      if (b.type === 'ToMaxVolume') n = target - x.classVol;
      else if (b.type === 'ToAssayVolumePct') n = solvePctNormalization(x, b.param, fluids, b.classId);
      else continue; // UNVERIFIED other types: leave unnormalized
      let rounded = n >= MIN_NORMALIZATION_VOLUME ? roundVolume(n, cls).volume : 0;
      const r = computeWell(x.req, fluids, x.plate, rounded);
      r.normalizationRequested = n;
      if (n > 0 && n < MIN_NORMALIZATION_VOLUME) r.warnings.push({ code: 'normalization_below_min', requested: n });
      result[x.w.p].wells.set(x.key, r);
    }
  }
  return result;
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
