// Concentration-gradient ("dose map") colouring, shared by the app (plate-map layer "Doses", exported figure)
// and the CLI (BASE_dosemap.svg next to the plan). Pure: no DOM.
//
// Each drug keeps its own hue (the app's fluid colour) and gets a sequential ramp from near-white (lowest
// concentration used anywhere in the protocol) through the hue to a darkened hue (highest), on a log scale,
// so the same colour means the same concentration on every plate. A well with two drugs is drawn as two
// halves (left = the drug listed first in the protocol), three or more as pie slices; a synergy matrix
// therefore shows one gradient across the columns (left halves) and one down the rows (right halves).

import { wellKey, wellName } from './tdd.js';
import { unitKind, unitLabel, scrapWellValues, compounds, toDisplay } from './dispense.js';

export const DRUG_PALETTE = ['#2f6fde', '#d9480f', '#2b8a3e', '#ae3ec9', '#e8590c', '#1098ad', '#c2255c', '#5c940d', '#f08c00', '#3b5bdb', '#862e9c', '#0b7285'];
// a diluted stock (fluid shift / extend) is the same drug as its root: same colour
export const fluidColor = (f) => { const id = f.rootFluidId != null ? f.rootFluidId : f.id; return DRUG_PALETTE[((id % DRUG_PALETTE.length) + DRUG_PALETTE.length) % DRUG_PALETTE.length]; };

/** Display unit of a fluid's well values (as the app shows them). */
export function wellUnitOf(protocol, f) {
  const s = protocol.settings || {};
  if (f.byVol) return s.VolumeUnit || 'nL';
  return unitKind(f.concentrationUnit) === 'mass' ? s.MassConcentrationUnit || 'ng_mL' : s.MolarityConcentrationUnit || 'µM';
}

/**
 * Scrap-well test when there is no experiment file: every drug in the well sits within 1 % of the value the
 * scrap-well tool would place (one priming volume of stock; D3's hand-made scrap well: 0.6 vs 0.599 µM).
 * Returns (pi, key) → boolean.
 */
export function scrapBySignature(protocol) {
  const cache = new Map();
  return (pi, key) => {
    const p = protocol.plates[pi], m = p && p.wells.get(key);
    if (!m || !m.size) return false;
    if (!cache.has(pi)) cache.set(pi, new Map(scrapWellValues(protocol.fluids, p)));
    const sv = cache.get(pi);
    for (const [id, v] of m) { const s = sv.get(id); if (!(s > 0) || Math.abs(v - s) > 0.01 * s) return false; }
    return true;
  };
}

const hex2 = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const toHex = (c) => '#' + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, f) => a.map((x, i) => x + (b[i] - x) * f);
const WHITE = [255, 255, 255], INK = [20, 24, 36];

/** Ramp colour of a hue at t ∈ [0,1]: 0 = pale tint, 0.7 = the hue itself, 1 = hue darkened by 40 %. */
export function rampColor(hue, t) {
  t = Math.max(0, Math.min(1, t));
  const c = hex2(hue), pale = mix(WHITE, c, 0.2); // was 0.12: lowest level too close to an empty well
  return toHex(t <= 0.7 ? mix(pale, c, t / 0.7) : mix(c, INK, ((t - 0.7) / 0.3) * 0.4));
}
/** CSS linear-gradient of a ramp (for legends). */
export const rampCss = (hue, dir = '90deg') => `linear-gradient(${dir}, ${[0, 0.25, 0.5, 0.7, 0.85, 1].map((t) => `${rampColor(hue, t)} ${t * 100}%`).join(', ')})`;

/** Distinct values, ascending, merging values within 1e-9 relative (floating-point noise of dilution series). */
function distinct(values) {
  const v = [...values].sort((a, b) => a - b), out = [];
  for (const x of v) if (!out.length || Math.abs(x - out[out.length - 1]) > 1e-9 * Math.max(Math.abs(x), 1e-300)) out.push(x);
  return out;
}

/**
 * Per-drug scales over the whole protocol (or only `plateIdx` when given):
 * Map fluidId → { fluid, color, unit, levels:[ascending], min, max, t(v), colorOf(v), plates:Set }.
 * `skip(pi, key)` leaves wells out of the scale (scrap wells: one high-concentration well that only exists to
 * use up a dispense head would otherwise squeeze the real series into the pale end). Their colour clamps to
 * the darkest step.
 */
export function drugScales(protocol, { plateIdx = null, skip = null, unitOf = null } = {}) {
  // one scale per compound: a diluted stock (fluid shift/extend, RootFluidID) shares its root drug's scale
  const { roots, rootOf } = compounds(protocol.fluids);
  const vals = new Map(), plates = new Map();
  protocol.plates.forEach((p, pi) => {
    if (plateIdx != null && pi !== plateIdx) return;
    for (const [key, m] of p.wells) for (const [fid, v] of m) {
      if (skip && skip(pi, key)) continue;
      if (!(v > 0) || !Number.isFinite(v)) continue;
      const id = rootOf(fid);
      if (!vals.has(id)) { vals.set(id, []); plates.set(id, new Set()); }
      vals.get(id).push(v); plates.get(id).add(pi);
    }
  });
  const out = new Map();
  for (const f of roots) {
    if (!vals.has(f.id)) continue;
    const levels = distinct(vals.get(f.id)), min = levels[0], max = levels[levels.length - 1];
    const lmin = Math.log(min), span = Math.log(max) - lmin;
    const t = (v) => (span > 0 ? Math.max(0, Math.min(1, (Math.log(v) - lmin) / span)) : 1);
    const color = fluidColor(f);
    const ids = protocol.fluids.filter((x) => rootOf(x.id) === f.id).map((x) => x.id);
    out.set(f.id, { fluid: f, ids, color, unit: unitOf ? unitOf(f) : wellUnitOf(protocol, f), levels, min, max, t, colorOf: (v) => rampColor(color, t(v)), plates: plates.get(f.id) });
  }
  return out;
}

/** Drugs of a well in protocol order, restricted to `onlyId` when given: [{ id, v, color }]. */
export function wellDoses(m, scales, onlyId = null) {
  if (!m || !m.size) return [];
  const out = [];
  for (const [id, sc] of scales) {
    if (onlyId != null && id !== onlyId && !(sc.ids || []).includes(onlyId)) continue;
    let v = 0; for (const x of sc.ids || [id]) if (m.get(x) > 0) v += m.get(x);
    if (v > 0) out.push({ id, v, color: sc.colorOf(v) });
  }
  return out;
}

/** CSS background of a well: one colour, two halves, or pie slices; null when the well has none of the drugs. */
export function wellBackground(m, scales, onlyId = null) {
  const d = wellDoses(m, scales, onlyId);
  if (!d.length) return null;
  if (d.length === 1) return d[0].color;
  if (d.length === 2) return `linear-gradient(90deg, ${d[0].color} 50%, ${d[1].color} 50%)`;
  return `conic-gradient(${d.map((x, i) => `${x.color} ${(i * 360) / d.length}deg ${((i + 1) * 360) / d.length}deg`).join(', ')})`;
}

const short = (v) => (v === 0 ? '0' : Math.abs(v) >= 1000 || Math.abs(v) < 0.01 ? v.toExponential(1).replace('e+', 'e') : +v.toPrecision(3) + '');
const escX = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** SVG of a well: circle; two drugs → left / right half-discs; more → pie slices clockwise from 12 o'clock. */
function wellSvg(cx, cy, r, colors) {
  const f = (x) => +x.toFixed(2);
  if (colors.length === 1) return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="${colors[0]}"/>`;
  if (colors.length === 2) {
    const top = `M${f(cx)},${f(cy - r)}`, bot = `${f(cx)},${f(cy + r)}`;
    return `<path d="${top} A${f(r)},${f(r)} 0 0 0 ${bot} Z" fill="${colors[0]}"/><path d="${top} A${f(r)},${f(r)} 0 0 1 ${bot} Z" fill="${colors[1]}"/>`;
  }
  const n = colors.length, pt = (i) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / n; return `${f(cx + r * Math.cos(a))},${f(cy + r * Math.sin(a))}`; };
  return colors.map((c, i) => `<path d="M${f(cx)},${f(cy)} L${pt(i)} A${f(r)},${f(r)} 0 0 1 ${pt(i + 1)} Z" fill="${c}"/>`).join('');
}

/**
 * Dose-map figure (SVG string). One row per plate: an overview map (all drugs, split wells) followed by one map
 * per drug used on that plate; one colour bar per drug at the bottom with every concentration level ticked.
 * opts: { title, plates: [indices] (default all), roleOf(pi, r, c) → experiment role ('pbs' wells tinted,
 *   'vehicle' wells dotted) }
 */
export function doseMapSvg(protocol, { title = 'Dose map', plates = null, roleOf = null, unitOf = null } = {}) {
  // marked scrap in the experiment file, or (plates with none marked) recognised by the priming-value signature
  const isScrap = scrapTestFromRoles(protocol, roleOf);
  const scales = drugScales(protocol, { skip: isScrap, unitOf });
  const inUnit = (sc, v) => toDisplay(v, sc.unit); // levels are printed in the drug's display unit
  const idx = (plates || protocol.plates.map((_, i) => i)).filter((i) => protocol.plates[i]);
  const maxCols = Math.max(...idx.map((i) => protocol.plates[i].cols), 1), maxRows = Math.max(...idx.map((i) => protocol.plates[i].rows), 1);
  const cell = maxCols > 24 ? 5 : maxCols > 12 ? 9 : 15, r = cell * 0.42;
  const mapW = 16 + maxCols * cell, mapH = 14 + maxRows * cell, gap = 22, label = 18;
  const perRow = 1 + Math.max(1, ...idx.map((pi) => [...scales.values()].filter((s) => s.plates.has(pi)).length));
  const left = 24, top = 66;
  const rowH = label + mapH + gap;
  const legendY = top + idx.length * rowH + 6, legendRowH = 52;
  const W = Math.max(left + perRow * (mapW + gap), 520), H = legendY + Math.max(1, scales.size) * legendRowH + 16;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, Helvetica, Arial, sans-serif">`;
  s += `<rect width="${W}" height="${H}" fill="#ffffff"/>`;
  s += `<text x="${left}" y="22" font-size="15" font-weight="600" fill="#1d2433">${escX(title)}</text>`;
  s += `<text x="${left}" y="38" font-size="11" fill="#5b6475">Colour = concentration, log scale; the same colour is the same concentration on every plate.</text>`;
  s += `<text x="${left}" y="52" font-size="11" fill="#5b6475">Two drugs in a well: left half = first drug, right half = second. Dashed ring: scrap well (not on the scale)${roleOf ? '; grey dot: vehicle' : ''}.</text>`;
  const plateMap = (x, y, p, pi, fn, head) => {
    let t = `<text x="${x}" y="${y + 12}" font-size="11" font-weight="600" fill="#1d2433">${escX(head)}</text>`;
    const oy = y + label;
    t += `<rect x="${x}" y="${oy}" width="${16 + p.cols * cell}" height="${14 + p.rows * cell}" rx="4" fill="#f6f7f9" stroke="#d7dbe2"/>`;
    const step = p.cols > 24 ? 4 : p.cols > 12 ? 2 : 1;
    for (let c = 0; c < p.cols; c += step) t += `<text x="${x + 16 + c * cell + cell / 2}" y="${oy + 10}" font-size="${cell > 8 ? 7 : 5}" text-anchor="middle" fill="#8a93a3">${c + 1}</text>`;
    for (let rr = 0; rr < p.rows; rr += step) t += `<text x="${x + 8}" y="${oy + 14 + rr * cell + cell / 2 + 2.5}" font-size="${cell > 8 ? 7 : 5}" text-anchor="middle" fill="#8a93a3">${wellName(rr, 0).replace(/\d+$/, '')}</text>`;
    for (let rr = 0; rr < p.rows; rr++) for (let c = 0; c < p.cols; c++) {
      const cx = x + 16 + c * cell + cell / 2, cy = oy + 14 + rr * cell + cell / 2;
      const cols = fn(p.wells.get(wellKey(rr, c)));
      const role = isScrap(pi, wellKey(rr, c)) ? 'scrap' : roleOf ? roleOf(pi, rr, c) : null;
      if (cols.length) t += wellSvg(cx, cy, r, cols);
      else t += `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="${role === 'pbs' ? '#dfe7f5' : '#e6e8ec'}"/>`;
      if (role === 'scrap' && cols.length) t += `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="none" stroke="#1d2433" stroke-width="0.9" stroke-dasharray="1.5 1"/>`;
      if (role === 'vehicle') t += `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${(r * 0.35).toFixed(2)}" fill="#8a93a3"/>`;
    }
    return t;
  };
  idx.forEach((pi, row) => {
    const p = protocol.plates[pi], y = top + row * rowH, name = `Plate ${pi + 1}${p.name ? ' · ' + p.name : ''}`;
    s += plateMap(left, y, p, pi, (m) => wellDoses(m, scales).map((d) => d.color), name + ' — all drugs');
    let k = 1;
    for (const [id, sc] of scales) {
      if (!sc.plates.has(pi)) continue;
      s += plateMap(left + k * (mapW + gap), y, p, pi, (m) => wellDoses(m, scales, id).map((d) => d.color), sc.fluid.name || `Fluid ${id}`);
      k++;
    }
  });
  // legends: one bar per drug with a tick per level
  let ly = legendY, gi = 0;
  const barW = Math.min(360, W - left - 220);
  for (const [id, sc] of scales) {
    const gid = `g${gi++}`;
    s += `<defs><linearGradient id="${gid}">${[0, 0.25, 0.5, 0.7, 0.85, 1].map((t) => `<stop offset="${t}" stop-color="${rampColor(sc.color, t)}"/>`).join('')}</linearGradient></defs>`;
    s += `<text x="${left}" y="${ly + 12}" font-size="11" font-weight="600" fill="#1d2433">${escX(sc.fluid.name || 'Fluid ' + id)}</text>`;
    s += `<text x="${left}" y="${ly + 26}" font-size="10" fill="#5b6475">${escX(unitLabel(sc.unit))}, ${sc.levels.length} level${sc.levels.length === 1 ? '' : 's'}</text>`;
    const bx = left + 150;
    s += `<rect x="${bx}" y="${ly + 4}" width="${barW}" height="10" rx="2" fill="url(#${gid})"/>`;
    const every = Math.ceil(sc.levels.length / Math.max(2, Math.floor(barW / 34)));
    sc.levels.forEach((v, i) => {
      const tx = bx + sc.t(v) * barW;
      s += `<line x1="${tx.toFixed(1)}" y1="${ly + 14}" x2="${tx.toFixed(1)}" y2="${ly + 19}" stroke="#1d2433" stroke-width="0.8"/>`;
      if (i % every === 0 || i === sc.levels.length - 1) s += `<text x="${tx.toFixed(1)}" y="${ly + 30}" font-size="9" text-anchor="middle" fill="#333">${short(inUnit(sc, v))}</text>`;
    });
    ly += legendRowH;
  }
  if (!scales.size) s += `<text x="${left}" y="${legendY + 14}" font-size="11" fill="#5b6475">No drugs placed yet.</text>`;
  return s + '</svg>';
}

/** The gradients as data (for the plan / Claude): [{ drug, unit, levels, min, max, foldRange, plates (1-based) }]. */
export function doseLevels(protocol, { skip = scrapBySignature(protocol), unitOf = null } = {}) {
  return [...drugScales(protocol, { skip, unitOf }).values()].map((sc) => ({
    drug: sc.fluid.name || `Fluid ${sc.fluid.id}`, unit: unitLabel(sc.unit), levels: sc.levels.map((v) => +toDisplay(v, sc.unit).toPrecision(4)),
    min: +toDisplay(sc.min, sc.unit).toPrecision(4), max: +toDisplay(sc.max, sc.unit).toPrecision(4), foldRange: +(sc.max / sc.min).toPrecision(3), plates: [...sc.plates].sort((a, b) => a - b).map((p) => p + 1) }));
}
/** Plain-text summary of the gradients: one line per drug. */
export function doseSummary(protocol, opts = {}) {
  return doseLevels(protocol, opts).map((d) => `${d.drug}: ${d.levels.length} level(s), ${short(d.min)}–${short(d.max)} ${d.unit} (${d.foldRange}-fold) on plate(s) ${d.plates.join(', ')}` +
    (d.levels.length > 1 ? ` (${d.levels.map(short).join(', ')})` : ''));
}
/**
 * Scrap test: wells marked scrap in the experiment file; on plates where none are marked (files from elsewhere),
 * the priming-value signature — so a real dose that happens to sit near the priming value is never dropped from
 * the scale when the experiment file says where the scrap wells are.
 * roleOf(pi, r, c) → role, or null without an experiment file.
 */
export function scrapTestFromRoles(protocol, roleOf) {
  const sig = scrapBySignature(protocol), marked = new Map();
  const hasMarked = (pi) => {
    if (!roleOf) return false;
    if (!marked.has(pi)) { const p = protocol.plates[pi]; let any = false; for (const key of p.wells.keys()) { const [r, c] = key.split(',').map(Number); if (roleOf(pi, r, c) === 'scrap') { any = true; break; } } marked.set(pi, any); }
    return marked.get(pi);
  };
  return (pi, key) => {
    if (hasMarked(pi)) { const [r, c] = key.split(',').map(Number); return roleOf(pi, r, c) === 'scrap'; }
    return sig(pi, key);
  };
}
/** Same, from an experiment file (meta) and experiment.js wellRole. */
export function scrapTest(protocol, meta, wellRoleFn) {
  return scrapTestFromRoles(protocol, meta && wellRoleFn ? (pi, r, c) => wellRoleFn(meta, protocol.plates[pi], pi, r, c) : null);
}
