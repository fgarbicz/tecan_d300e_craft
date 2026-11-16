// Experiment layer: everything the drug printer does not need but the experiment does — cell lines, the
// evaporation-barrier border (PBS), well roles, plate readouts (e.g. CellTiter-Glo) — plus the experiment
// wizard that builds whole designs (matrix × partners × plate replicates) in one step.
//
// The .tdd stays exactly what D300e Control reads and writes. The experiment layer lives in a sidecar file
// next to it ("<name>.craft.json"), holding a fingerprint of the .tdd so a protocol re-saved elsewhere is
// detected. Plate entries in meta.plates are index-aligned with protocol.plates; every operation that
// adds, removes or reorders plates must call the matching meta helper below (tested).

import { wellKey, splitKey, wellName } from './tdd.js';
import { newPlate, titrationLevels, addNormalization, setWell } from './ops.js';
import { computeProtocol, PRIMING_VOLUME, stockInBase } from './dispense.js';

export const META_VERSION = 1;
export const ROLE = { PBS: 'pbs', SCRAP: 'scrap', BLANK: 'blank', EXCLUDE: 'exclude' };
export const ROLE_LABEL = {
  pbs: 'PBS / medium barrier (no cells)', scrap: 'Scrap (priming) well', blank: 'Blank (medium, no cells)', exclude: 'Excluded from analysis',
  vehicle: 'Vehicle control (cells, no drug)', treated: 'Treated', empty: 'Empty',
};
export const CELL_LINE_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c', '#5c940d'];

export function newPlateMeta() { return { roles: {}, cellLines: {}, readout: null, notes: '' }; }

export function newMeta(protocol) {
  return {
    version: META_VERSION, app: 'Tecan D300 Craft',
    experiment: { title: '', date: '', notes: '', assay: 'CellTiter-Glo' },
    settings: { borderPBS: true, borderDepth: 1 },
    cellLines: [],
    plates: (protocol?.plates || []).map(() => newPlateMeta()),
    tdd: null,
  };
}

/** Make meta consistent with a protocol (after load, or when a sidecar is missing/stale). Never throws. */
export function reconcileMeta(meta, protocol) {
  const m = meta && meta.version ? meta : newMeta(protocol);
  m.settings = { borderPBS: true, borderDepth: 1, ...(m.settings || {}) };
  m.experiment = { title: '', date: '', notes: '', assay: 'CellTiter-Glo', ...(m.experiment || {}) };
  m.cellLines = Array.isArray(m.cellLines) ? m.cellLines : [];
  m.plates = Array.isArray(m.plates) ? m.plates : [];
  while (m.plates.length < protocol.plates.length) m.plates.push(newPlateMeta());
  if (m.plates.length > protocol.plates.length) m.plates.length = protocol.plates.length;
  for (const p of m.plates) { p.roles ||= {}; p.cellLines ||= {}; p.readout ??= null; p.notes ??= ''; }
  return m;
}

// ---------- fingerprint ----------
/** 64-bit FNV-1a of the protocol content that matters for the experiment (fluids + wells + plates),
 *  ignoring revisions and the thumbnail, which change on every save. Hex string. */
export function protocolFingerprint(protocol) {
  const parts = [];
  for (const f of protocol.fluids) parts.push(`F${f.id}|${f.name}|${f.concentration}|${f.classId}|${f.byVol}`);
  protocol.plates.forEach((p, i) => {
    parts.push(`P${i}|${p.plateType}|${p.assayVolume}|${p.dmsoLimit}`);
    for (const k of [...p.wells.keys()].sort()) parts.push(`${k}:${[...p.wells.get(k)].map(([id, v]) => `${id}=${v}`).join(',')}`);
  });
  let h = 0xcbf29ce484222325n; const P = 0x100000001b3n, M = (1n << 64n) - 1n;
  for (const ch of new TextEncoder().encode(parts.join('\n'))) { h ^= BigInt(ch); h = (h * P) & M; }
  return h.toString(16).padStart(16, '0');
}

// ---------- serialization ----------
export function serializeMeta(meta, protocol, tddName) {
  const m = structuredClone(meta);
  m.tdd = { name: tddName, fingerprint: protocolFingerprint(protocol), savedAt: new Date().toISOString() };
  return JSON.stringify(m, null, 2) + '\n';
}

/** Parse a sidecar. Returns { meta, stale } — stale when the .tdd changed since the sidecar was saved. */
export function parseMeta(text, protocol) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || raw.version == null) throw new Error('Not a D300 Craft experiment file');
  if (raw.version > META_VERSION) throw new Error(`Experiment file version ${raw.version} is newer than this app (${META_VERSION})`);
  const stale = !!(raw.tdd?.fingerprint && raw.tdd.fingerprint !== protocolFingerprint(protocol));
  return { meta: reconcileMeta(raw, protocol), stale };
}
export const sidecarName = (tddName) => tddName.replace(/\.tdd$/i, '') + '.craft.json';

// ---------- plate bookkeeping (mirror protocol plate operations) ----------
export function metaRemovePlate(meta, index) { meta.plates.splice(index, 1); }
export function metaReplicatePlate(meta, index) {
  const src = meta.plates[index] || newPlateMeta();
  meta.plates.push({ ...structuredClone(src), readout: null }); // the copy has not been measured
}
export function metaAddPlate(meta) { meta.plates.push(newPlateMeta()); }
export function metaClearPlate(meta, index) { meta.plates[index] = { ...newPlateMeta(), cellLines: meta.plates[index]?.cellLines || {} }; }
/** Copy annotations of wells (cell line, explicit role) for a well copy/paste. */
export function metaCopyWells(meta, plateIndex, cells) {
  const pm = meta.plates[plateIndex] || newPlateMeta();
  const r0 = Math.min(...cells.map((x) => x[0])), c0 = Math.min(...cells.map((x) => x[1]));
  return cells.map(([r, c]) => ({ dr: r - r0, dc: c - c0, role: pm.roles[wellKey(r, c)] ?? null, cellLine: pm.cellLines[wellKey(r, c)] ?? null }));
}
export function metaPasteWells(meta, plateIndex, clip, r0, c0, rows, cols) {
  const pm = meta.plates[plateIndex];
  for (const { dr, dc, role, cellLine } of clip) {
    const r = r0 + dr, c = c0 + dc; if (r >= rows || c >= cols) continue;
    const k = wellKey(r, c);
    if (role) pm.roles[k] = role; else delete pm.roles[k];
    if (cellLine) pm.cellLines[k] = cellLine; else delete pm.cellLines[k];
  }
}

// ---------- roles ----------
export function borderCells(rows, cols, depth = 1) {
  const out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (r < depth || c < depth || r >= rows - depth || c >= cols - depth) out.push([r, c]);
  }
  return out;
}
export const isBorder = (r, c, rows, cols, depth = 1) => r < depth || c < depth || r >= rows - depth || c >= cols - depth;

/**
 * Role of a well. Explicit roles (pbs/scrap/blank/exclude) win. Otherwise: a border well with the PBS
 * setting on and no fluid is 'pbs'; a well with a cell line is 'treated' if any fluid is dispensed into
 * it, else 'vehicle'; wells without cells are 'empty'.
 */
export function wellRole(meta, plate, plateIndex, r, c) {
  const pm = meta.plates[plateIndex] || newPlateMeta();
  const k = wellKey(r, c);
  if (pm.roles[k]) return pm.roles[k];
  const fluids = plate.wells.get(k);
  const hasDrug = !!(fluids && [...fluids.values()].some((v) => v > 0));
  const depth = meta.settings.borderDepth || 1;
  if (meta.settings.borderPBS && !hasDrug && isBorder(r, c, plate.rows, plate.cols, depth)) return 'pbs';
  if (pm.cellLines[k]) return hasDrug ? 'treated' : 'vehicle';
  return hasDrug ? 'treated' : 'empty';
}

/** Assign a cell line to cells (null clears). PBS / scrap / blank wells are skipped unless force. */
export function assignCellLine(meta, plate, plateIndex, cells, cellLineId, { force = false } = {}) {
  const pm = meta.plates[plateIndex];
  let skipped = 0;
  for (const [r, c] of cells) {
    const k = wellKey(r, c);
    if (!cellLineId) { delete pm.cellLines[k]; continue; }
    const role = wellRole(meta, plate, plateIndex, r, c);
    if (!force && (role === 'pbs' || role === 'scrap' || role === 'blank')) { skipped++; continue; }
    pm.cellLines[k] = cellLineId;
  }
  return { skipped };
}

export function setRole(meta, plateIndex, cells, role) {
  const pm = meta.plates[plateIndex];
  for (const [r, c] of cells) { const k = wellKey(r, c); if (role) pm.roles[k] = role; else delete pm.roles[k]; if (role === 'pbs' || role === 'blank' || role === 'scrap') delete pm.cellLines[k]; }
}

export function addCellLine(meta, name) {
  const id = `cl${(meta.cellLines.reduce((m, x) => Math.max(m, +String(x.id).slice(2) || 0), 0) + 1)}`;
  const cl = { id, name: name.trim() || id, color: CELL_LINE_COLORS[meta.cellLines.length % CELL_LINE_COLORS.length], notes: '' };
  meta.cellLines.push(cl);
  return cl;
}
export function removeCellLine(meta, id) {
  meta.cellLines = meta.cellLines.filter((x) => x.id !== id);
  for (const p of meta.plates) for (const k of Object.keys(p.cellLines)) if (p.cellLines[k] === id) delete p.cellLines[k];
}

// ---------- experiment wizard ----------
/**
 * Build a drug-combination experiment: the primary drug titrated along one axis, crossed with each
 * partner drug along the other, every block repeated on `plateReplicates` plates. Mirrors how
 * "2026.08.28 synergy D3" was built by hand in D300e Control (tests/experiment.test.js rebuilds it exactly).
 *
 * spec = {
 *   plate: { plateType, assayVolume (nL), dmsoLimit (fraction), dontShake, deionize, promptPlateLoad, name },
 *   border: number of edge rows/cols left for PBS (0 = none),
 *   primary: { fluidId, high, factor, levels, includeZero, replicates },   // along columns
 *   partners: [{ fluidId, high, factor, levels, includeZero, replicates,   // along rows
 *               normalization: { type: 'ToMaxVolume'|'ToAssayVolumePct'|null, param, scope: 'block'|'plate' } }],
 *   plateReplicates, scrap: true (separate ≥30 nL priming well per fluid that needs one, top row from the right),
 *   origin: [row, col] of the grid's top-left (default: just inside the border),
 * }
 * Levels: high, high/factor, … (levels values), then 0 if includeZero. Replicates are adjacent.
 * Returns { plates, backfills (plate indices relative to the first new plate), plateMeta, blocks }.
 */
export function buildExperiment(spec, fluids) {
  const fl = new Map(fluids.map((f) => [f.id, f]));
  const pt = newPlate(spec.plate);
  const depth = spec.border ?? 1;
  const axisLevels = (a) => {
    const lv = a.levels > 0 ? titrationLevels({ mode: 'high', distribution: 'dilution', high: a.high, factor: a.factor, levels: a.levels }) : [];
    return a.includeZero ? [...lv, 0] : lv;
  };
  const prim = spec.primary;
  const pLv = axisLevels(prim);
  const pRep = Math.max(1, prim.replicates || 1);
  const [r0, c0] = spec.origin || [depth, depth];
  const nCols = pLv.length * pRep;
  if (c0 + nCols > pt.cols - depth) throw new Error(`The ${fl.get(prim.fluidId)?.name ?? 'primary'} axis needs ${nCols} columns; only ${pt.cols - depth - c0} fit inside the border`);
  const plates = [], backfills = [], plateMeta = [], blocks = [];
  const nRep = Math.max(1, spec.plateReplicates || 1);
  spec.partners.forEach((part, bi) => {
    const qLv = axisLevels(part), qRep = Math.max(1, part.replicates || 1);
    const nRows = qLv.length * qRep;
    if (r0 + nRows > pt.rows - depth) throw new Error(`The ${fl.get(part.fluidId)?.name ?? 'partner'} axis needs ${nRows} rows; only ${pt.rows - depth - r0} fit inside the border`);
    const blockPlates = [];
    for (let rep = 0; rep < nRep; rep++) {
      const p = newPlate({ ...spec.plate });
      // primary first in every well (fluid order inside a well is application order, as D300e writes it)
      for (let i = 0; i < nRows; i++) for (let j = 0; j < nCols; j++) {
        const a = pLv[Math.floor(j / pRep)], b = qLv[Math.floor(i / qRep)];
        if (a) setWell(p, r0 + i, c0 + j, prim.fluidId, a);
        if (b) setWell(p, r0 + i, c0 + j, part.fluidId, b);
      }
      const pm = newPlateMeta();
      if (spec.scrap !== false) placeScrap(p, pm, [prim, part].map((x) => fl.get(x.fluidId)), depth);
      plateMeta.push(pm);
      blockPlates.push(plates.length);
      plates.push(p);
    }
    const grid = [];
    for (let i = 0; i < nRows; i++) for (let j = 0; j < nCols; j++) grid.push([r0 + i, c0 + j]);
    const nz = part.normalization;
    if (nz && nz.type) {
      const groups = nz.scope === 'plate' || nz.type === 'ToAssayVolumePct' && nz.scope !== 'block' ? blockPlates.map((p) => [p]) : [blockPlates];
      for (const g of groups) backfills.push({ classId: nz.classId ?? 0, type: nz.type, param: nz.param, wells: g.flatMap((p) => grid.map(([r, c]) => ({ p, r, c }))) });
    }
    blocks.push({ name: `${fl.get(prim.fluidId)?.name} × ${fl.get(part.fluidId)?.name}`, plates: blockPlates, primary: prim.fluidId, partner: part.fluidId,
      region: { r0, c0, rows: nRows, cols: nCols }, primaryLevels: pLv, partnerLevels: qLv });
  });
  return { plates, backfills, plateMeta, blocks };
}

/** One priming well per fluid whose largest dispense on the plate is < 30 nL, in the top border row from the
 *  right (A24, A23, …) — fluid order (D3: Bortezomib A24, MEN A23). Value: ≥ 30 nL, 3 significant digits up. */
function placeScrap(plate, pm, fluids, depth) {
  const res = computeProtocol({ fluids, plates: [plate], backfills: [] })[0];
  const maxVol = new Map();
  for (const w of res.wells.values()) for (const x of w.fluids) maxVol.set(x.fluidId, Math.max(maxVol.get(x.fluidId) || 0, x.volume));
  let col = plate.cols - 1;
  for (const f of fluids) {
    if (!f || f.byVol || !(maxVol.get(f.id) < PRIMING_VOLUME - 1e-9)) continue;
    while (col >= 0 && plate.wells.get(wellKey(0, col))?.size) col--;
    if (col < 0) break;
    const exact = (stockInBase(f) * PRIMING_VOLUME) / (plate.assayVolume + PRIMING_VOLUME);
    const mag = Math.pow(10, Math.floor(Math.log10(exact)) - 2);
    const v = Number((Math.ceil(exact / mag - 1e-9) * mag).toPrecision(3));
    setWell(plate, 0, col, f.id, v);
    pm.roles[wellKey(0, col)] = 'scrap';
    col--;
  }
}

/** Apply a buildExperiment() result to a protocol (appends plates, backfills, meta). Returns the first new index. */
export function applyExperiment(protocol, meta, built) {
  const first = protocol.plates.length;
  protocol.plates.push(...built.plates);
  for (const b of built.backfills) addNormalization(protocol, b.classId, b.type, b.param, b.wells.map((w) => ({ ...w, p: w.p + first })));
  meta.plates.push(...built.plateMeta);
  meta.blocks = [...(meta.blocks || []), ...built.blocks.map((b) => ({ ...b, plates: b.plates.map((p) => p + first) }))];
  return first;
}

export { wellName, splitKey };
