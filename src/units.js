// Per-drug display units. The .tdd keeps every well value in the protocol's base unit (µM for molar stocks,
// ng/mL for mass stocks) — D300e Control has one unit per protocol. Which unit a person wants to READ and TYPE for
// a given drug (nM for a potent one, µM or mM for others) is a preference kept in the experiment file:
// meta.drugUnits = { [root fluid id]: 'nM' }. A diluted stock (fluid shift / extend) follows its root drug.
import { MOLARITY_UNITS, MASS_UNITS, VOLUME_UNITS, unitKind, unitLabel, toDisplay, fromDisplay, compounds } from './dispense.js';

/** Units a drug's doses can be shown in (same kind as its stock). */
export function unitsFor(f) {
  if (f.byVol) return Object.keys(VOLUME_UNITS);
  let kind = 'molarity'; try { kind = unitKind(f.concentrationUnit); } catch { /* unknown → molar */ }
  return Object.keys(kind === 'mass' ? MASS_UNITS : MOLARITY_UNITS);
}
/** The protocol-wide unit D300e Control would use for this fluid. */
export function protocolUnit(protocol, f) {
  const s = protocol?.settings || {};
  if (f.byVol) return s.VolumeUnit || 'nL';
  let kind = 'molarity'; try { kind = unitKind(f.concentrationUnit); } catch { /* unknown → molar */ }
  return kind === 'mass' ? s.MassConcentrationUnit || 'ng_mL' : s.MolarityConcentrationUnit || 'µM';
}
/** Display unit for the well values (doses) of fluid f. */
export function drugUnit(meta, protocol, f) {
  const def = protocolUnit(protocol, f);
  if (!f || f.byVol || !meta?.drugUnits) return def;
  const u = meta.drugUnits[compounds(protocol.fluids).rootOf(f.id)];
  return u && unitsFor(f).includes(u) ? u : def;
}
export function setDrugUnit(meta, protocol, f, unit) {
  if (!unitsFor(f).includes(unit)) throw new Error(`${unitLabel(unit)} is not a unit for ${f.name}`);
  const root = compounds(protocol.fluids).rootOf(f.id);
  meta.drugUnits = { ...(meta.drugUnits || {}) };
  if (unit === protocolUnit(protocol, f)) delete meta.drugUnits[root]; else meta.drugUnits[root] = unit;
}
/** A unit function for a protocol + experiment file: f → unit. */
export const unitOfFn = (meta, protocol) => (f) => drugUnit(meta, protocol, f);
/** Base value → number in the display unit, and back. */
export const shown = (v, unit) => toDisplay(v, unit);
export const typed = (x, unit) => fromDisplay(x, unit);
/** The unit in which a typical value reads best (0.1–1000): e.g. 0.0005 µM → nM. */
export function niceUnit(valueInBase, kind = 'molarity') {
  const table = kind === 'mass' ? MASS_UNITS : MOLARITY_UNITS;
  let best = kind === 'mass' ? 'ng_mL' : 'µM', score = Infinity;
  for (const [u, k] of Object.entries(table)) { const x = valueInBase / k; const s = x >= 0.1 && x < 1000 ? 0 : Math.abs(Math.log10(x / 10)); if (s < score) { score = s; best = u; } }
  return best;
}
