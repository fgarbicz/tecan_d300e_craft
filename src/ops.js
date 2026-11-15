// Design operations (pure-ish: they mutate the protocol passed in; the UI snapshots for undo).
// Semantics from the user guide; see docs/spec_from_user_guide.md (§ numbers below).

import { wellKey, splitKey } from './tdd.js';
import { validRange } from './dispense.js';

// Plate-type strings confirmed in protocol files: Default48, Default96, Default384, Default1536.
export const PLATE_TYPES = {
  Default48: { rows: 6, cols: 8, label: '48-well' },
  Default96: { rows: 8, cols: 12, label: '96-well' },
  Default384: { rows: 16, cols: 24, label: '384-well' },
  Default1536: { rows: 32, cols: 48, label: '1536-well' },
};

export function newPlate(template = {}) {
  const type = template.plateType || 'Default384';
  const dims = PLATE_TYPES[type] || { rows: template.rows, cols: template.cols };
  return {
    plateType: type, rows: dims.rows, cols: dims.cols, name: template.name || '',
    assayVolume: template.assayVolume ?? 50000, dmsoLimit: template.dmsoLimit ?? 0.01,
    dontShake: template.dontShake ?? true, // new 384-well plates default to DontShake=True (T01) deionize: template.deionize ?? true,
    promptPlateLoad: template.promptPlateLoad ?? true, wells: new Map(), randomize: null,
  };
}

export function addFluid(protocol, fields) {
  const id = protocol.fluids.reduce((m, f) => Math.max(m, f.id), -1) + 1;
  const f = { id, name: fields.name || `Fluid ${id + 1}`, byVol: !!fields.byVol, concentration: fields.concentration ?? 10000,
    concentrationUnit: fields.concentrationUnit || 'mM', maxVolume: fields.maxVolume ?? 1000, maxVolumeUnit: fields.maxVolumeUnit || 'nL',
    classId: fields.classId ?? 0 };
  if (fields.color != null) f.color = fields.color;
  protocol.fluids.push(f);
  return f;
}

/** Remove a fluid and every well value that uses it. */
export function removeFluid(protocol, id) {
  protocol.fluids = protocol.fluids.filter((f) => f.id !== id);
  for (const p of protocol.plates) for (const [k, m] of p.wells) { m.delete(id); if (!m.size) p.wells.delete(k); }
}

// ---------- well values ----------
export function setWell(plate, r, c, fluidId, value) {
  const k = wellKey(r, c);
  let m = plate.wells.get(k);
  if (!value) { if (m) { m.delete(fluidId); if (!m.size) plate.wells.delete(k); } return; }
  if (!m) { m = new Map(); plate.wells.set(k, m); }
  m.set(fluidId, value);
}

/** Wells in `cells` that already hold `fluidId` (guide §3.1: ask Replace/Cancel). */
export function conflicts(plate, cells, fluidId) {
  return cells.filter(([r, c]) => plate.wells.get(wellKey(r, c))?.has(fluidId));
}

export function setValue(plate, cells, fluidId, value) {
  for (const [r, c] of cells) setWell(plate, r, c, fluidId, value);
}

export function clearWells(plate, cells, fluidId = null) {
  for (const [r, c] of cells) {
    const k = wellKey(r, c);
    if (fluidId == null) plate.wells.delete(k);
    else setWell(plate, r, c, fluidId, 0);
  }
}

// ---------- titration levels (§3.4) ----------
/**
 * @param {object} o
 *  mode: 'highLow' | 'high' | 'low'
 *  high, low, levels
 *  distribution: 'log' | 'linear' | 'halfLog' | 'thirdLog' | 'quarterLog' | 'dilution'
 *  factor (for 'dilution', e.g. 2 for 1:2), increment (for 'linear' in high/low modes)
 * Returns levels ordered high -> low.
 */
export function titrationLevels(o) {
  const n = o.levels;
  if (!(n >= 1)) throw new Error('Number of levels must be at least 1');
  if (o.mode === 'highLow') {
    if (!(o.high > o.low)) throw new Error('Highest must be greater than lowest');
    if (n === 1) return [o.high];
    if (o.distribution === 'linear') return range(n).map((i) => o.high - ((o.high - o.low) * i) / (n - 1));
    if (!(o.low > 0)) throw new Error('Logarithmic titration needs a lowest value above 0');
    const ratio = Math.pow(o.high / o.low, 1 / (n - 1));
    return range(n).map((i) => (i === n - 1 ? o.low : o.high / Math.pow(ratio, i)));
  }
  const ratio = stepRatio(o);
  const start = o.mode === 'high' ? o.high : o.low;
  if (!(start > 0)) throw new Error('Start value must be above 0');
  let vals;
  if (o.distribution === 'linear') {
    const inc = o.increment;
    if (!(inc > 0)) throw new Error('Linear titration needs an increment above 0');
    vals = range(n).map((i) => (o.mode === 'high' ? start - inc * i : start + inc * i));
    if (vals.some((v) => v <= 0)) throw new Error('Linear titration reaches 0 or below; reduce the increment or the number of levels');
  } else {
    vals = range(n).map((i) => (o.mode === 'high' ? start / Math.pow(ratio, i) : start * Math.pow(ratio, i)));
  }
  return o.mode === 'high' ? vals : vals.reverse();
}

function stepRatio(o) {
  switch (o.distribution) {
    case 'halfLog': return Math.sqrt(10); // UNVERIFIED: 1/2 Log = 10^(1/2) per step
    case 'thirdLog': return Math.cbrt(10);
    case 'quarterLog': return Math.pow(10, 0.25);
    case 'log': return 10;
    case 'dilution': if (!(o.factor > 1)) throw new Error('Dilution factor must be greater than 1'); return o.factor;
    case 'linear': return null;
    default: throw new Error(`Unknown distribution ${o.distribution}`);
  }
}
const range = (n) => Array.from({ length: n }, (_, i) => i);

// ---------- titration placement (§3.4 titration pattern) ----------
/**
 * Order the selected cells for a titration.
 * direction: 'rows' (levels advance along a row, left->right then next row) |
 *            'cols' (levels advance down a column, top->bottom then next column)
 * highFirst: true = highest level at the start corner.
 * Replicates: consecutive wells in this order hold the same level
 * (UNVERIFIED: the guide's pattern graphics; check with T04).
 */
export function orderCells(cells, direction = 'rows') {
  const s = [...cells];
  return direction === 'rows' ? s.sort((a, b) => a[0] - b[0] || a[1] - b[1]) : s.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

export function applyTitration(plate, cells, fluidId, levels, { replicates = 1, direction = 'rows', highFirst = true, replicateLayout = 'adjacent' } = {}) {
  if (cells.length % replicates) throw new Error(`The number of selected wells (${cells.length}) must be a multiple of replicates (${replicates})`);
  const nLevels = cells.length / replicates;
  if (levels.length !== nLevels) throw new Error(`Selection gives ${nLevels} levels but ${levels.length} values were supplied`);
  const ordered = orderCells(cells, direction);
  const lv = highFirst ? levels : [...levels].reverse();
  ordered.forEach(([r, c], i) => {
    // adjacent: replicates sit next to each other (L1 L1 L1 L2 L2 L2 ...)
    // series:   whole series repeats (L1 L2 ... Ln L1 L2 ...)
    const level = replicateLayout === 'adjacent' ? Math.floor(i / replicates) : i % nLevels;
    setWell(plate, r, c, fluidId, lv[level]);
  });
}

// ---------- fluid shift / extend (§3.6) ----------
const DILUTIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900,
  1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000];

/** Suggest a shift (one diluted fluid covers the range) or extension (stock + diluted). INFERRED rule, fits both guide examples. */
export function suggestShift(fluid, plate, high, low) {
  const { min, max } = validRange(fluid, plate);
  if (low >= min * (1 - 1e-9)) return null;
  const need = min / low;
  const d = DILUTIONS.find((x) => x >= need * (1 - 1e-9));
  if (!d) return { kind: 'impossible' };
  const dilutedMax = max / d;
  return high <= dilutedMax * (1 + 1e-9) ? { kind: 'shift', factor: d } : { kind: 'extend', factor: d };
}

// Saved by D300e Control as <RootFluidID> and <DilutionFactor> right after <Name> (T01, fluid "Fluid 1 - 1:300").
export function dilutedFluid(protocol, fluid, factor) {
  const f = addFluid(protocol, { ...fluid, name: `${fluid.name} - 1:${factor}`, concentration: fluid.concentration / factor, color: undefined });
  f.rootFluidId = fluid.rootFluidId ?? fluid.id;
  f.dilutionFactor = (fluid.dilutionFactor ?? 1) * factor;
  return f;
}

// ---------- synergy (§4.1) ----------
/**
 * Build synergy plates.
 * spec: {
 *   type: 'ABC' | 'AxEach',
 *   fluids: [{ fluidId, levels: [high->low values], includeZero, order: 'highFirst'|'lowFirst' }],
 *            // ABC: fluids[0] down rows, fluids[1] across columns, fluids[2..] combinations
 *            // AxEach: fluids[0] primary (rows), each of fluids[1..] crossed separately (columns)
 *   plate: template plate fields (plateType, assayVolume, dmsoLimit),
 *   excludedRows: Set, excludedCols: Set,
 *   layout: 'single' | 'multiple' | 'multipleBreaks' | 'noEmpty', gridOrder: 'rows'|'cols'
 * }
 * Returns new plates (not yet added to the protocol).
 */
export function buildSynergy(spec) {
  const tmpl = newPlate(spec.plate);
  const rowsAvail = range(tmpl.rows).filter((r) => !spec.excludedRows?.has(r));
  const colsAvail = range(tmpl.cols).filter((c) => !spec.excludedCols?.has(c));
  const axis = (f) => {
    let v = [...f.levels];
    // Include "0": 0 is the LAST (lowest) of the requested levels, i.e. N levels = N-1 nonzero + 0.
    // Confirmed with fixtures/reference/t06-synergy.tdd: 6 levels 50→0.05 log = 50, 8.89, 1.58, 0.281, 0.05, 0.
    // Callers pass the nonzero levels (see synergyLevels()).
    if (f.includeZero) v.push(0);
    return f.order === 'lowFirst' ? v.reverse() : v;
  };
  const [A, ...rest] = spec.fluids;
  const grids = []; // each grid: {rowFluid, rowVals, colFluid, colVals, extras: [[id,val],...]}
  if (spec.type === 'AxEach') {
    for (const B of rest) grids.push({ rowFluid: A.fluidId, rowVals: axis(A), colFluid: B.fluidId, colVals: axis(B), extras: [] });
  } else {
    const B = rest[0];
    if (!B) throw new Error('Synergy needs at least two fluids');
    const others = rest.slice(1);
    // Combinations of fluids 3+, odometer order with the 3rd fluid varying fastest (INFERRED,
    // consistent with "plate breaks keep titration sequences together").
    const vals = others.map(axis);
    const total = vals.reduce((p, v) => p * v.length, 1);
    const idx = new Array(others.length).fill(0);
    const combos = [];
    for (let n = 0; n < total; n++) {
      combos.push(others.map((f, i) => [f.fluidId, vals[i][idx[i]]]));
      for (let i = 0; i < idx.length; i++) { idx[i]++; if (idx[i] < vals[i].length) break; idx[i] = 0; }
    }
    for (const extras of combos) grids.push({ rowFluid: A.fluidId, rowVals: axis(A), colFluid: B.fluidId, colVals: axis(B), extras });
  }
  const gh = grids[0].rowVals.length, gw = grids[0].colVals.length;
  if (gh > rowsAvail.length || gw > colsAvail.length) throw new Error(`Synergy grid ${gh}×${gw} does not fit the ${rowsAvail.length}×${colsAvail.length} available wells`);

  const plates = [];
  const fresh = () => { const p = newPlate({ name: 'Synergy', ...spec.plate }); plates.push(p); return p; }; // plate named "Synergy" (T06)
  const putGrid = (plate, g, cellAt) => {
    for (let i = 0; i < gh; i++) for (let j = 0; j < gw; j++) {
      const [r, c] = cellAt(i, j);
      setWell(plate, r, c, g.rowFluid, g.rowVals[i]);
      setWell(plate, r, c, g.colFluid, g.colVals[j]);
      for (const [id, v] of g.extras) setWell(plate, r, c, id, v);
    }
  };

  if (spec.layout === 'noEmpty') {
    // Fill all available wells along columns from A1 (or rows), no gaps (§4.1 option 1).
    const slots = spec.gridOrder === 'rows'
      ? rowsAvail.flatMap((r) => colsAvail.map((c) => [r, c]))
      : colsAvail.flatMap((c) => rowsAvail.map((r) => [r, c]));
    let plate = fresh(), s = 0;
    for (const g of grids) for (let i = 0; i < gh; i++) for (let j = 0; j < gw; j++) {
      if (s === slots.length) { plate = fresh(); s = 0; }
      const [r, c] = slots[s++];
      setWell(plate, r, c, g.rowFluid, g.rowVals[i]);
      setWell(plate, r, c, g.colFluid, g.colVals[j]);
      for (const [id, v] of g.extras) setWell(plate, r, c, id, v);
    }
    return plates;
  }

  // grid slots on a plate (packed in available rows/cols)
  const perCol = Math.floor(rowsAvail.length / gh), perRow = Math.floor(colsAvail.length / gw);
  const capacity = spec.layout === 'single' ? 1 : perCol * perRow;
  const slotOrigins = [];
  if (spec.gridOrder === 'cols') { for (let x = 0; x < perRow; x++) for (let y = 0; y < perCol; y++) slotOrigins.push([y, x]); }
  else { for (let y = 0; y < perCol; y++) for (let x = 0; x < perRow; x++) slotOrigins.push([y, x]); }

  let perPlate = capacity;
  if (spec.layout === 'multipleBreaks' && spec.type !== 'AxEach') {
    // INFERRED: largest prefix product of the levels of fluids 3, 4, ... that fits (§4.1, fits both guide examples)
    const counts = spec.fluids.slice(2).map((f) => axis(f).length);
    let prod = 1; perPlate = 1;
    for (const n of counts) { prod *= n; if (prod <= capacity) perPlate = prod; else break; }
  }
  let plate = null;
  grids.forEach((g, gi) => {
    const slot = gi % perPlate;
    if (slot === 0) plate = fresh();
    const [gy, gx] = slotOrigins[slot];
    putGrid(plate, g, (i, j) => [rowsAvail[gy * gh + i], colsAvail[gx * gw + j]]);
  });
  return plates;
}

/** Levels for one synergy axis as D300e Control computes them: with Include "0", the N requested
 *  levels are N-1 titrated values (high→low) plus 0. Returns the nonzero levels. */
export function synergyLevels({ levels, includeZero, ...titration }) {
  const n = includeZero ? levels - 1 : levels;
  if (n < 1) throw new Error('Synergy needs at least 2 levels when "0" is included');
  return titrationLevels({ ...titration, levels: n });
}

// ---------- normalization (§3.7 / §5) ----------
// XML type names confirmed with fixtures/reference/t05-normalize.tdd.
export const NORMALIZE_TYPES = {
  ToMaxVolume: 'Fluid class: to highest class volume',
  ToVolume: 'Fluid class: to specified volume (nL)',
  ToAssayVolumePct: 'Fluid class: to % of total volume',
  ToMaxTotalVolume: 'Total volume: to highest total volume',
  ToTotalVolume: 'Total volume: to specified total volume (nL)',
};
export const NORMALIZE_PARAM = { ToVolume: 'nL', ToAssayVolumePct: '%', ToTotalVolume: 'nL' };

/** Add a normalization group. "only one group for each fluid class" per well: the well is removed from other groups of that class. */
export function addNormalization(protocol, classId, type, param, wells) {
  const keys = new Set(wells.map((w) => `${w.p},${w.r},${w.c}`));
  for (const b of protocol.backfills) if (b.classId === classId) b.wells = b.wells.filter((w) => !keys.has(`${w.p},${w.r},${w.c}`));
  protocol.backfills = protocol.backfills.filter((b) => b.wells.length);
  const b = { classId, type, wells: [...wells] };
  if (param != null) b.param = param;
  protocol.backfills.push(b);
  return b;
}

export function removeNormalization(protocol, wells) {
  const keys = new Set(wells.map((w) => `${w.p},${w.r},${w.c}`));
  for (const b of protocol.backfills) b.wells = b.wells.filter((w) => !keys.has(`${w.p},${w.r},${w.c}`));
  protocol.backfills = protocol.backfills.filter((b) => b.wells.length);
}

// ---------- plates ----------
export function removePlate(protocol, index) {
  protocol.plates.splice(index, 1);
  for (const b of protocol.backfills) b.wells = b.wells.filter((w) => w.p !== index).map((w) => (w.p > index ? { ...w, p: w.p - 1 } : w));
  protocol.backfills = protocol.backfills.filter((b) => b.wells.length);
}

export function replicatePlate(protocol, index) {
  const src = protocol.plates[index];
  const copy = { ...src, wells: new Map([...src.wells].map(([k, m]) => [k, new Map(m)])), _order: src._order && [...src._order] };
  protocol.plates.push(copy);
  const ni = protocol.plates.length - 1;
  for (const b of protocol.backfills) {
    const add = b.wells.filter((w) => w.p === index).map((w) => ({ ...w, p: ni }));
    b.wells.push(...add);
  }
  return ni;
}

export function clearPlate(protocol, index) {
  protocol.plates[index].wells.clear();
  removeNormalization(protocol, protocol.backfills.flatMap((b) => b.wells.filter((w) => w.p === index)));
}

// ---------- copy / paste (§3.9) ----------
export function copyWells(plate, cells) {
  const r0 = Math.min(...cells.map((x) => x[0])), c0 = Math.min(...cells.map((x) => x[1]));
  return cells.map(([r, c]) => ({ dr: r - r0, dc: c - c0, fluids: new Map(plate.wells.get(wellKey(r, c)) || []) }));
}

export function pasteWells(plate, clip, r0, c0) {
  let truncated = 0;
  for (const { dr, dc, fluids } of clip) {
    const r = r0 + dr, c = c0 + dc;
    if (r >= plate.rows || c >= plate.cols) { truncated++; continue; }
    const k = wellKey(r, c);
    if (fluids.size) plate.wells.set(k, new Map(fluids)); else plate.wells.delete(k); // overwrite without warning
  }
  return { truncated };
}

/** Tab-separated grid for Excel (one block per fluid), guide Appendix B style (UNVERIFIED exact format). */
export function plateToTsv(plate, fluid) {
  const lines = [];
  lines.push(['', ...range(plate.cols).map((c) => c + 1)].join('\t'));
  for (let r = 0; r < plate.rows; r++) {
    const row = [String.fromCharCode(65 + (r % 26))];
    for (let c = 0; c < plate.cols; c++) { const v = plate.wells.get(wellKey(r, c))?.get(fluid.id); row.push(v ? String(v) : ''); }
    lines.push(row.join('\t'));
  }
  return lines.join('\n');
}

export { wellKey, splitKey };
