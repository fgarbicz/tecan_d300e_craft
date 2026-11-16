// Experiment layer: everything the drug printer does not need but the experiment does — cell lines, the
// evaporation-barrier border (PBS), well roles, plate readouts (e.g. CellTiter-Glo) — plus the experiment
// wizard that builds whole designs (matrix × partners × plate replicates) in one step.
//
// The .tdd stays exactly what D300e Control reads and writes. The experiment layer lives in a sidecar file
// next to it ("<name>.craft.json"), holding a fingerprint of the .tdd so a protocol re-saved elsewhere is
// detected. Plate entries in meta.plates are index-aligned with protocol.plates; every operation that
// adds, removes or reorders plates must call the matching meta helper below (tested).

import { wellKey, splitKey, wellName } from './tdd.js';
import { newPlate, titrationLevels, addNormalization, setWell, suggestShift, dilutedFluid, extendThreshold } from './ops.js';
import { computeProtocol, PRIMING_VOLUME, stockInBase, validRange } from './dispense.js';
import { scrapBySignature } from './dosemap.js';

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
 * Concentration levels of one axis, high → low, then 0 when includeZero.
 *  - { high, factor, levels }: high, high/factor, high/factor², …
 *  - { high, low, levels }: `levels` values evenly spaced on a log scale from high down to low (both included);
 *    the step is (high/low)^(1/(levels−1)). Values are kept to 10 significant digits.
 */
export function axisLevels(a) {
  let lv = [];
  if (a.levels > 0 && a.low > 0 && a.high > 0) {
    const n = Math.floor(a.levels);
    if (n === 1) lv = [a.high];
    else lv = Array.from({ length: n }, (_, i) => (i === n - 1 ? a.low : Number((a.high * (a.low / a.high) ** (i / (n - 1))).toPrecision(10))));
  } else if (a.levels > 0) lv = titrationLevels({ mode: 'high', distribution: 'dilution', high: a.high, factor: a.factor, levels: a.levels });
  return a.includeZero ? [...lv, 0] : lv;
}
/** Dilution step (fold per level) of a high/low/levels axis. */
export const rangeStep = (high, low, levels) => (levels > 1 && high > 0 && low > 0 ? (high / low) ** (1 / (levels - 1)) : null);

/**
 * Extra diluted stocks for series that go below one drop of the stock (D300e "fluid shift / extend", guide
 * p.29–31; dilution choice and level split INFERRED from the guide's two worked examples — ops.js suggestShift):
 *  - shift: one diluted stock covers the whole series → the axis uses "Drug - 1:N" only;
 *  - extend: the series needs both → every level that needs at most ~180 nL of "Drug - 1:N" is dispensed from it
 *    (ops.js extendThreshold, measured on D300e Control: probe-29), the higher levels from the stock.
 * Mutates `protocol` (adds the diluted fluids, reusing one with the same name) and the axes of `spec`
 * (fluidId / lowFluidId / splitBelow). Returns notes: [{ drug, kind: 'shift'|'extend'|'impossible', factor,
 * fluid (name), stock (in base units), levels (on the diluted fluid) }].
 */
export function resolveStocks(protocol, spec) {
  const notes = [], done = new Set();
  const plate = { assayVolume: spec.plate.assayVolume, dmsoLimit: spec.plate.dmsoLimit };
  for (const a of [spec.primary, ...spec.partners]) {
    if (!a || a.fluidId == null || done.has(a)) continue;
    done.add(a);
    const f = protocol.fluids.find((x) => x.id === a.fluidId);
    if (!f || f.byVol) continue;
    const lv = axisLevels(a).filter((v) => v > 0);
    if (!lv.length) continue;
    const high = Math.max(...lv), low = Math.min(...lv);
    // dilutions of this drug that already exist are reused when one covers the series (probe-29)
    const existing = protocol.fluids.filter((x) => x.rootFluidId === f.id && x.dilutionFactor > 1).map((x) => x.dilutionFactor);
    const s = suggestShift(f, plate, high, low, existing);
    if (!s) continue;
    if (s.kind === 'impossible') { notes.push({ drug: f.name, kind: 'impossible', levels: lv.filter((v) => v < validRange(f, plate).min) }); continue; }
    const name = `${f.name} - 1:${s.factor}`;
    const d = protocol.fluids.find((x) => x.name === name) || dilutedFluid(protocol, f, s.factor);
    if (s.kind === 'shift') { a.rootFluidId = f.id; a.fluidId = d.id; notes.push({ drug: f.name, kind: 'shift', factor: s.factor, fluid: d.name, stock: d.concentration, levels: lv }); continue; }
    a.lowFluidId = d.id; a.splitBelow = extendThreshold(d.concentration, plate) * (1 + 1e-9); // levels up to the threshold: extended fluid
    notes.push({ drug: f.name, kind: 'extend', factor: s.factor, fluid: d.name, stock: d.concentration, levels: lv.filter((v) => v < a.splitBelow) });
  }
  return notes;
}

/** Small seeded PRNG (mulberry32) so a randomization can be reproduced from its seed. */
export function seededRng(seed) {
  let t = seed >>> 0;
  return () => { t = (t + 0x6d2b79f5) >>> 0; let x = Math.imul(t ^ (t >>> 15), 1 | t); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
/**
 * Randomize where each design well is dispensed, keeping every well inside its own cell line: the wells seeded
 * with one cell line (meta) are shuffled among themselves, so drugs move but cells stay put (two cell lines on a
 * plate stay in their halves). Wells with a set role (PBS, scrap/priming, blank, excluded) are not moved.
 * A plate without cell lines is shuffled within each drug grid of its design, or among its drug wells.
 * Each group gets a uniform random permutation (Fisher–Yates), so a well may keep its place by chance.
 * Writes plate.randomization (the D300e <Randomize> map, design well → dispensed well). D300e Control shows the
 * plate as one randomized group; re-randomizing there would mix the cell lines again.
 */
export function randomizeByCellLine(protocol, meta, plateIndices, rng = Math.random) {
  for (const pi of plateIndices) {
    const p = protocol.plates[pi], pm = meta.plates[pi];
    if (!p || !pm) continue;
    const groups = new Map();
    for (const [k, id] of Object.entries(pm.cellLines || {})) {
      if (pm.roles?.[k]) continue;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(splitKey(k));
    }
    if (!groups.size) {
      // no cell lines on this plate: shuffle within each drug grid of the design (wizard blocks: the halves of a
      // split plate stay apart), or, on a hand-made plate, among all wells that get a drug
      const blocks = (meta.blocks || []).filter((b) => b.plates.includes(pi));
      blocks.forEach((b, bi) => (b.copies || [b.region]).forEach((g, gi) => {
        const cells = [];
        for (let r = g.r0; r < g.r0 + g.rows; r++) for (let c = g.c0; c < g.c0 + g.cols; c++) if (!pm.roles?.[wellKey(r, c)]) cells.push([r, c]);
        if (cells.length) groups.set(`grid${bi}.${gi}`, cells);
      }));
      if (!groups.size) {
        // hand-made plate: the rectangle spanned by its drug wells (so the no-drug control wells inside it take
        // part), leaving out priming wells (marked, or recognised by their value) and other marked wells
        const scrap = scrapBySignature(protocol);
        const drug = [...p.wells.entries()].filter(([k, m]) => m.size && !pm.roles?.[k] && !scrap(pi, k)).map(([k]) => splitKey(k));
        if (drug.length > 1) {
          const r0 = Math.min(...drug.map((x) => x[0])), r1 = Math.max(...drug.map((x) => x[0])), c0 = Math.min(...drug.map((x) => x[1])), c1 = Math.max(...drug.map((x) => x[1]));
          const cells = [];
          for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const k = wellKey(r, c); if (!pm.roles?.[k] && !scrap(pi, k)) cells.push([r, c]); }
          groups.set('drugs', cells);
        }
      }
    }
    const list = [];
    for (const cells of groups.values()) {
      cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const to = cells.map((x) => x.slice());
      for (let i = to.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [to[i], to[j]] = [to[j], to[i]]; } // Fisher-Yates
      cells.forEach(([r, c], i) => list.push({ r, c, toR: to[i][0], toC: to[i][1] }));
    }
    p.randomization = list;
  }
}


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
  const nameOf = (id) => { const f = fl.get(id); return (f && f.rootFluidId != null && fl.get(f.rootFluidId)?.name) || f?.name; };
  // after resolveStocks(): an "extended" axis puts its levels below the stock's reach on the diluted fluid
  const fidFor = (a, v) => (a.lowFluidId != null && v < a.splitBelow ? a.lowFluidId : a.fluidId);
  const prim = spec.primary;
  const pLv = axisLevels(prim);
  const pRep = Math.max(1, prim.replicates || 1);
  // spec.split: 'rows' (top / bottom halves) or 'cols' (left / right halves) puts the same grid twice on each
  // plate, e.g. for two cell lines per plate; the copies are blocks' `copies` (regions), in plate order.
  const split = spec.split === 'rows' || spec.split === 'cols' ? spec.split : null;
  const innerR = pt.rows - 2 * depth, innerC = pt.cols - 2 * depth;
  const [r0, c0] = spec.origin || [depth, depth];
  const nCols = pLv.length * pRep;
  const availC = split === 'cols' ? Math.floor(innerC / 2) : pt.cols - depth - c0;
  if (nCols > availC) throw new Error(fitAdvice(nameOf(prim.fluidId) ?? 'primary', prim, pLv, pRep, availC, 'columns', split === 'cols' ? 'in half the plate' : 'inside the border', depth));
  const plates = [], backfills = [], plateMeta = [], blocks = [];
  const nRep = Math.max(1, spec.plateReplicates || 1);
  spec.partners.forEach((part, bi) => {
    const qLv = axisLevels(part), qRep = Math.max(1, part.replicates || 1);
    const nRows = qLv.length * qRep;
    const availR = split === 'rows' ? Math.floor(innerR / 2) : pt.rows - depth - r0;
    if (nRows > availR) throw new Error(fitAdvice(part.fluidId == null ? 'single-drug replicate' : nameOf(part.fluidId) ?? 'partner', part, qLv, qRep, availR, 'rows', split === 'rows' ? 'in half the plate' : 'inside the border', depth));
    const origins = !split ? [[r0, c0]] : split === 'rows' ? [[depth, c0], [depth + Math.floor(innerR / 2), c0]] : [[r0, depth], [r0, depth + Math.floor(innerC / 2)]];
    const blockPlates = [];
    for (let rep = 0; rep < nRep; rep++) {
      const p = newPlate({ ...spec.plate });
      // primary first in every well (fluid order inside a well is application order, as D300e writes it)
      for (const [or, oc] of origins) for (let i = 0; i < nRows; i++) for (let j = 0; j < nCols; j++) {
        const a = pLv[Math.floor(j / pRep)], b = qLv[Math.floor(i / qRep)];
        if (a) setWell(p, or + i, oc + j, fidFor(prim, a), a);
        if (b) setWell(p, or + i, oc + j, fidFor(part, b), b);
      }
      const pm = newPlateMeta();
      if (spec.scrap !== false) placeScrap(p, pm, [prim, part].flatMap((x) => [x.fluidId, x.lowFluidId]).filter((id) => id != null).map((id) => fl.get(id)), depth);
      plateMeta.push(pm);
      blockPlates.push(plates.length);
      plates.push(p);
    }
    const grid = [];
    for (const [or, oc] of origins) for (let i = 0; i < nRows; i++) for (let j = 0; j < nCols; j++) grid.push([or + i, oc + j]);
    grid.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // normalization wells row-major, as D300e writes them
    const nz = part.normalization;
    if (nz && nz.type) {
      const groups = nz.scope === 'plate' || nz.type === 'ToAssayVolumePct' && nz.scope !== 'block' ? blockPlates.map((p) => [p]) : [blockPlates];
      for (const g of groups) backfills.push({ classId: nz.classId ?? 0, type: nz.type, param: nz.param, wells: g.flatMap((p) => grid.map(([r, c]) => ({ p, r, c }))) });
    }
    // A partner with fluidId null and only the 0 level makes a single-drug block (dose response, `replicates` rows).
    blocks.push({ name: part.fluidId == null ? `${nameOf(prim.fluidId)}` : `${nameOf(prim.fluidId)} × ${nameOf(part.fluidId)}`, plates: blockPlates, primary: prim.fluidId, partner: part.fluidId,
      region: { r0: origins[0][0], c0: origins[0][1], rows: nRows, cols: nCols }, copies: origins.map(([r, c]) => ({ r0: r, c0: c, rows: nRows, cols: nCols })),
      primaryLevels: pLv, partnerLevels: qLv });
  });
  return { plates, backfills, plateMeta, blocks };
}

/** "Does not fit" message with the numbers and what would fit. */
function fitAdvice(name, a, lv, rep, avail, dim, where, depth) {
  const n = lv.length * rep, zero = a.includeZero ? 1 : 0, nz = lv.length - zero;
  const opts = [];
  const maxLv = Math.floor(avail / rep) - zero;
  if (maxLv >= 1 && maxLv < nz) opts.push(`${maxLv} levels${zero ? ' + 0' : ''} × ${rep} replicates`);
  const maxRep = Math.floor(avail / lv.length);
  if (maxRep >= 1 && maxRep < rep) opts.push(`${nz} levels${zero ? ' + 0' : ''} × ${maxRep} replicate${maxRep > 1 ? 's' : ''} (more plate replicates instead)`);
  if (depth > 0 && n <= avail + 2 * depth) opts.push('no PBS border');
  return `The ${name} axis needs ${n} ${dim} (${nz} levels${zero ? ' + 0' : ''} × ${rep} replicate${rep > 1 ? 's' : ''}); only ${avail} fit ${where}.` + (opts.length ? ` Fits: ${opts.join(', or ')}.` : '');
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

/** Seed cell lines on the drug grids of the given blocks: set[i] goes into copy i (split plates: one line per
 *  half; otherwise set[0] into the single grid). Only grid wells get cells — the plan reports the other inner
 *  wells as unused, so nobody seeds (and counts) cells that receive no drug. */
export function seedBlocks(meta, protocol, blocks, set) {
  for (const b of blocks) for (const pi of b.plates) {
    const p = protocol.plates[pi];
    (b.copies || [b.region]).forEach((reg, i) => {
      const cl = set[i] ?? (b.copies?.length > 1 ? null : set[0]);
      if (!cl) return;
      const cells = [];
      for (let r = reg.r0; r < reg.r0 + reg.rows; r++) for (let c = reg.c0; c < reg.c0 + reg.cols; c++) cells.push([r, c]);
      assignCellLine(meta, p, pi, cells, cl.id);
    });
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
