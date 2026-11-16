// Readout analysis: a plate-reader readout (e.g. CellTiter-Glo luminescence) pasted per plate →
// per-well viability, per-condition statistics, Bliss / HSA synergy, and a workbook model that the
// desktop shell writes as .xlsx (crates/d300-app/src/xlsx.rs, command save_xlsx).
//
// Pure module: no DOM, runs in node (tests/analysis.test.js) and in the browser.
//
// Choices (documented here because they change numbers):
//   * Background = mean signal of the plate's 'blank' wells (medium, no cells). A plate without blank
//     wells uses background 0, with a warning — viability is then signal / vehicle mean.
//   * Vehicle mean = mean signal of 'vehicle' wells (cells, no drug) with the SAME cell line on the
//     SAME plate. Plate-to-plate differences in cell number / reagent are normalized away this way.
//   * Wells without a signal (empty cell, OVER, NaN …) are left out of every mean.
//   * Conditions pool wells across all analyzed plates; statistics are on per-well viability.
//   * Synergy uses condition MEANS (not per-well values). Inhibition is not clamped to [0, 1]: a
//     viability above 100 % gives a negative inhibition, which is reported as measured.

import { wellKey, wellName } from './tdd.js';
import { wellRole } from './experiment.js';
import { computeProtocol, unitKind, toDisplay, unitLabel } from './dispense.js';

// ---------- row labels ----------
/** Row letters as used by wellName(): A..Z, then AA, AB … (1536 plates). */
export const rowLabel = (r) => wellName(r, 0).replace(/\d+$/, '');
function rowIndex(label) {
  const s = label.toUpperCase();
  if (s.length === 1) return s.charCodeAt(0) - 65;
  return (s.charCodeAt(0) - 64) * 26 + (s.charCodeAt(1) - 65);
}

// ---------- parsing pasted readouts ----------
// Numbers: plain or scientific, decimal point or decimal comma (decided per block, below).
const NUM_RE = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)([eE][+-]?\d+)?$/;
// Tokens readers / Excel write instead of a value. They become null with a warning.
const FLAG_RE = /^(over|overflow|ovrflw|sat|saturated|nan|n\/?a|-+|—|–|\*+|#n\/a|#value!|#div\/0!|#num!|#ref!|err|error|invalid|[+-]?inf(inity)?|range\?|\?+)$/i;
// Numbers with grouping (1,234,567 / 1.234,5 / 1,234.5 / 1'234 / 1 234): not supported.
const GROUPED_RE = /^[+-]?\d{1,3}(([,.'’ ]\d{3}){2,}|'\d{3}|’\d{3}|[,.]\d{3}[.,]\d+| \d{3})$/;
// "12,345": decimal comma or thousands separator? Undecidable on its own.
const AMBIG_COMMA_RE = /^[+-]?[1-9]\d{0,2},\d{3}$/;
const AMBIG_DOT_RE = /^[+-]?[1-9]\d{0,2}\.\d{3}$/;
const ROWLABEL_RE = /^[A-Za-z]{1,2}$/;
const WELL_RE = /^([A-Za-z]{1,2})0*(\d{1,3})$/;

const THOUSANDS_MSG = 'Numbers with thousands separators are not supported';

function classify(tok) {
  if (tok === '') return 'empty';
  if (NUM_RE.test(tok)) return 'num';
  if (FLAG_RE.test(tok)) return 'flag';
  if (GROUPED_RE.test(tok)) return 'grouped';
  return 'text';
}

/** Split one line. Non-whitespace separators keep empty cells and honour "double quotes". */
function splitLine(line, sep) {
  if (sep === 'ws') return line.trim() === '' ? [] : line.trim().split(/\s+/);
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; continue; }
    if (ch === sep && !q) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * Decide how the numeric tokens of a block are read and convert them. Per BLOCK, not per cell, so a
 * plate is never half decimal-comma, half thousands: a silent 1000× error is the failure to avoid.
 * Throws a decisive error (err.decisive = true) when the block cannot be read safely.
 */
function convertBlock(tokens, sep, warnings) {
  const nums = tokens.filter((t) => classify(t) === 'num');
  const grouped = tokens.filter((t) => classify(t) === 'grouped');
  const withComma = nums.filter((t) => t.includes(','));
  const withDot = nums.filter((t) => t.includes('.'));
  const fail = (msg) => { const e = new Error(msg); e.decisive = true; throw e; };
  if (grouped.length) fail(`${THOUSANDS_MSG} (found "${grouped[0]}"). Format the readout without a 1000 separator and paste again.`);
  let decimalComma = false;
  if (withComma.length) {
    if (sep === ',') fail('Internal: comma inside a comma-separated cell'); // cannot happen: split on ','
    if (withDot.length) fail(`The readout mixes decimal points and commas ("${withDot[0]}", "${withComma[0]}"); ${THOUSANDS_MSG.toLowerCase()}. Paste the values without 1000 separators.`);
    if (withComma.every((t) => AMBIG_COMMA_RE.test(t))) {
      fail(`Values like "${withComma[0]}" are ambiguous: decimal comma or thousands separator? ${THOUSANDS_MSG}; format the readout without a 1000 separator and paste again.`);
    }
    decimalComma = true;
  } else if (withDot.length && withDot.every((t) => AMBIG_DOT_RE.test(t)) && nums.some((t) => !/[.,eE]/.test(t))) {
    // "850" next to "12.345": integers below 1000 and dotted values that look like 12 345 — a
    // dot-grouped export. Reading the dots as decimals would make some wells 1000× too small.
    fail(`Values like "${withDot[0]}" next to whole numbers look like "." thousands separators; ${THOUSANDS_MSG.toLowerCase()}. Format the readout without a 1000 separator and paste again.`);
  } else if (withDot.length && withDot.every((t) => AMBIG_DOT_RE.test(t))) {
    // Dot decimals are the norm, so these are read as decimals, but say what would go wrong.
    warnings.push(`Every decimal value has exactly 3 digits after the point (e.g. "${withDot[0]}"). They are read as decimals; if your spreadsheet uses "." as a thousands separator the values are 1000× too small.`);
  }
  return (t) => {
    const k = classify(t);
    if (k !== 'num') return null;
    return Number(decimalComma ? t.replace(',', '.') : t);
  };
}

function headerRun(cells) {
  // A header line: (optional non-numeric first cell) 1 2 3 … n, n ≥ 2
  let xs = cells.slice();
  while (xs.length && xs[xs.length - 1] === '') xs.pop();
  if (xs.length && ROWLABEL_RE.test(xs[0])) return 0; // "A 1 2 3" is row A holding 1, 2, 3
  if (xs.length && classify(xs[0]) !== 'num') xs = xs.slice(1);
  if (xs.length < 2) return 0;
  return xs.every((t, i) => /^\d+$/.test(t) && Number(t) === i + 1) ? xs.length : 0;
}

/** Try the grid format with one separator. Returns {ok, values, …} | {found: {rows, cols, first}} | null. */
function tryGrid(lines, sep, rows, cols, headersAsData = false) {
  // classify every line
  const info = lines.map((line) => {
    let cells = splitLine(line, sep);
    if (!headersAsData && headerRun(cells)) return { kind: 'header' };
    // a row label, possibly after leading empty cells (block pasted from column B)
    let label = null;
    let lead = 0;
    while (lead < cells.length && cells[lead] === '') lead++;
    if (lead < cells.length && ROWLABEL_RE.test(cells[lead])) { label = rowIndex(cells[lead]); cells = cells.slice(lead + 1); }
    let last = -1;
    for (let i = 0; i < cells.length; i++) if (cells[i] !== '') last = i;
    if (last < 0) return { kind: 'blank' };
    const kinds = cells.map(classify);
    if (kinds.some((k) => k === 'text')) return { kind: 'other' };
    if (!kinds.some((k) => k === 'num' || k === 'flag' || k === 'grouped')) return { kind: 'other' };
    // trailing empty cells beyond the plate width are separators at the end of the line, not wells
    const width = Math.max(last + 1, Math.min(cells.length, cols));
    return { kind: 'data', label, cells: cells.slice(0, width), width };
  });
  // runs of consecutive data lines; labelled lines must continue A, B, C …
  const runs = [];
  let cur = null;
  info.forEach((x, i) => {
    if (x.kind !== 'data') { cur = null; return; }
    const prev = cur && cur.lines[cur.lines.length - 1];
    const continues = cur && (x.label == null) === (prev.label == null) && (x.label == null || x.label === prev.label + 1);
    if (!continues) { cur = { start: i, lines: [] }; runs.push(cur); }
    cur.lines.push(x);
  });
  // Rows shorter than the plate are accepted (readers that drop trailing empty cells) except with
  // whitespace separation, where an empty cell cannot be told apart and padding would shift wells.
  const fits = (run) => run.lines.length === rows && Math.max(...run.lines.map((l) => l.width)) === cols &&
    (sep !== 'ws' || run.lines.every((l) => l.width === cols)) &&
    (run.lines[0].label == null || run.lines[0].label === 0);
  const good = runs.filter(fits);
  if (!good.length) {
    if (!runs.length) return null;
    // the largest numeric block, for the dimension error
    const best = runs.map((r) => ({ rows: r.lines.length, cols: Math.max(...r.lines.map((l) => l.width)), first: r.start }))
      .sort((a, b) => b.rows * b.cols - a.rows * a.cols || a.first - b.first)[0];
    return { found: best };
  }
  const run = good[0];
  const warnings = [];
  if (good.length > 1) warnings.push(`Found ${good.length} blocks of ${rows} × ${cols} values; used the first (lines ${run.start + 1}–${run.start + rows}).`);
  const conv = convertBlock(run.lines.flatMap((l) => l.cells), sep, warnings);
  const values = [], flagged = [];
  run.lines.forEach((l, r) => {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const t = l.cells[c] ?? '';
      if (classify(t) === 'flag') flagged.push(`${wellName(r, c)} (${t})`);
      row.push(conv(t));
    }
    values.push(row);
  });
  if (run.lines.some((l) => l.width < cols)) warnings.push('Some rows were shorter than the plate; their missing wells are left empty.');
  const skipped = lines.length - rows - info.filter((x) => x.kind === 'blank').length;
  if (skipped > 0) warnings.push(`Skipped ${skipped} line${skipped === 1 ? '' : 's'} outside the plate block (headers, metadata).`);
  return { ok: true, values, format: 'grid', warnings, flagged };
}

/** Try the list format ("A1<sep>12345", one well per line). */
function tryList(lines, sep, rows, cols) {
  const entries = [];
  let outside = null;
  for (const line of lines) {
    const toks = splitLine(line, sep).filter((t) => t !== '');
    if (toks.length !== 2) continue;
    const m = WELL_RE.exec(toks[0]);
    const k = classify(toks[1]);
    if (!m || !(k === 'num' || k === 'flag' || k === 'grouped')) continue;
    const r = rowIndex(m[1]), c = Number(m[2]) - 1;
    if (r >= rows || c >= cols || c < 0) { outside ||= toks[0].toUpperCase(); continue; }
    entries.push({ r, c, tok: toks[1], name: toks[0] });
  }
  if (!entries.length && !outside) return null;
  const fail = (msg) => { const e = new Error(msg); e.decisive = true; throw e; };
  if (outside) fail(`Well ${outside} is outside this plate (${rows} × ${cols}, ${rowLabel(0)}1–${wellName(rows - 1, cols - 1)}).`);
  const warnings = [];
  const conv = convertBlock(entries.map((e) => e.tok), sep, warnings);
  const values = Array.from({ length: rows }, () => Array(cols).fill(null));
  const seen = new Set(), flagged = [];
  for (const e of entries) {
    const key = wellKey(e.r, e.c);
    if (seen.has(key)) fail(`Well ${wellName(e.r, e.c)} appears twice in the list.`);
    seen.add(key);
    if (classify(e.tok) === 'flag') flagged.push(`${wellName(e.r, e.c)} (${e.tok})`);
    values[e.r][e.c] = conv(e.tok);
  }
  if (seen.size < rows * cols) warnings.push(`The list has ${seen.size} of ${rows * cols} wells; the others are left empty.`);
  return { ok: true, values, format: 'list', warnings, flagged };
}

/**
 * Parse a readout pasted from Excel or exported by a plate reader.
 * @returns {{ values: (number|null)[][], format: 'grid'|'list', warnings: string[] }}
 * @throws Error with a message for the user when the text cannot be read as a rows × cols plate.
 */
export function parseReadout(text, rows, cols) {
  if (!(rows > 0 && cols > 0)) throw new Error('Plate dimensions are missing');
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r\n|\r|\n/);
  if (!lines.some((l) => l.trim() !== '')) throw new Error('The readout is empty');
  // Separators to try, most specific first. ';' and ',' only when they occur; whitespace always
  // (plate readers that align columns with spaces). A result must not depend on the choice.
  const seps = [];
  if (text.includes('\t')) seps.push('\t');
  if (text.includes(';')) seps.push(';');
  if (text.includes(',')) seps.push(',');
  seps.push('ws');
  const ok = [], decisive = [], found = [];
  for (const sep of seps) {
    try {
      // a first data row that reads 1 2 3 … looks like a column header; retry with it as data
      let g = tryGrid(lines, sep, rows, cols);
      if (!g?.ok) {
        const g2 = tryGrid(lines, sep, rows, cols, true);
        if (g2?.found) found.push(g2.found);
        if (g2?.ok) g = g2;
      }
      if (g?.ok) { ok.push(g); continue; }
      if (g?.found) found.push(g.found);
      const l = tryList(lines, sep, rows, cols);
      if (l?.ok) ok.push(l);
    } catch (e) {
      if (!e.decisive) throw e;
      decisive.push(e);
    }
  }
  if (ok.length) {
    const same = (a, b) => a.values.every((row, r) => row.every((v, c) => Object.is(v, b.values[r][c])));
    if (ok.some((x) => !same(x, ok[0]))) throw new Error('The readout can be read in more than one way (the separator is ambiguous). Paste it with tabs between the columns, e.g. straight from Excel.');
    const res = ok[0];
    const warnings = [...res.warnings];
    if (res.flagged.length) {
      const shown = res.flagged.slice(0, 12).join(', ') + (res.flagged.length > 12 ? ', …' : '');
      warnings.push(`${res.flagged.length} well${res.flagged.length === 1 ? ' has' : 's have'} no numeric value and ${res.flagged.length === 1 ? 'is' : 'are'} left empty: ${shown}.`);
    }
    return { values: res.values, format: res.format, warnings };
  }
  if (decisive.length) throw new Error(decisive[0].message);
  if (found.length) {
    const b = found.sort((a, b2) => b2.rows * b2.cols - a.rows * a.cols)[0];
    throw new Error(`Found ${b.rows} row${b.rows === 1 ? '' : 's'} × ${b.cols} column${b.cols === 1 ? '' : 's'}; this plate is ${rows} × ${cols}.`);
  }
  throw new Error(`No plate readout found. Paste a ${rows} × ${cols} block of numbers (optionally with row letters and column numbers) or a list of wells (A1<tab>value).`);
}

// ---------- helpers ----------
const finite = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
/** Concentration key: rounded to 10 significant digits so 0.1 + 0.2 style noise does not split groups. */
const roundKey = (x) => (x === 0 ? 0 : Number(x.toPrecision(10)));
const fmtConc = (x) => String(Number(x.toPrecision(4)));

/** Display unit of the per-well values of a fluid: requested values are stored in the base unit. */
export function fluidUnit(f) {
  if (f.byVol) return 'nL';
  try { return unitKind(f.concentrationUnit) === 'mass' ? 'ng/mL' : 'µM'; } catch { return 'µM'; }
}

function stats(xs) {
  const n = xs.length, m = mean(xs);
  if (n < 2) return { n, mean: m, sd: null, sem: null, cv: null };
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  return { n, mean: m, sd, sem: sd / Math.sqrt(n), cv: m !== 0 ? (sd / Math.abs(m)) * 100 : null };
}

// ---------- analysis ----------
/**
 * @param {{ protocol, computed?, meta, options? }} args
 *   computed: computeProtocol(protocol) result (computed here when missing; only used for DMSO %).
 *   options.plates: plate indices to analyze (default: every plate with a readout).
 * @returns {{ wells: object[], conditions: object[], synergy: object[], warnings: string[], fluids: object[] }}
 */
export function analyze({ protocol, computed, meta, options = {} }) {
  const comp = computed || computeProtocol(protocol);
  const fluids = protocol.fluids.map((f) => ({ id: f.id, name: f.name, unit: fluidUnit(f) }));
  const clName = new Map((meta.cellLines || []).map((c) => [c.id, c.name]));
  const clOrder = new Map((meta.cellLines || []).map((c, i) => [c.id, i]));
  const warnings = [];
  const wells = [];
  const only = options.plates ? new Set(options.plates) : null;

  protocol.plates.forEach((plate, pi) => {
    if (only && !only.has(pi)) return;
    const pm = meta.plates?.[pi];
    const values = pm?.readout?.values;
    if (!values) return;
    const P = `Plate ${pi + 1}`;
    if (values.length !== plate.rows || values.some((row) => !Array.isArray(row) || row.length !== plate.cols)) {
      warnings.push(`${P}: the readout is not ${plate.rows} × ${plate.cols}; plate skipped.`);
      return;
    }
    const pw = [];
    for (let r = 0; r < plate.rows; r++) for (let c = 0; c < plate.cols; c++) {
      const k = wellKey(r, c);
      const req = plate.wells.get(k);
      const role = wellRole(meta, plate, pi, r, c);
      const cellLineId = pm.cellLines?.[k] ?? null;
      const cw = comp?.[pi]?.wells?.get(k);
      pw.push({
        plate: pi + 1, plateIndex: pi, plateName: plate.name || '', well: wellName(r, c), row: rowLabel(r), col: c + 1, r, c,
        role, cellLineId, cellLine: cellLineId ? (clName.get(cellLineId) ?? cellLineId) : '',
        conc: protocol.fluids.map((f) => finite(req?.get(f.id)) ?? 0),
        // a well the dispenser never touches holds no DMSO; a well the engine could not compute: unknown
        dmsoPct: !cw ? 0 : finite(cw.dmsoFraction) == null ? null : cw.dmsoFraction * 100,
        raw: finite(values[r][c]), background: null, vehicleMean: null, viability: null, note: '',
      });
    }
    const blanks = pw.filter((w) => w.role === 'blank' && w.raw != null).map((w) => w.raw);
    let bg = mean(blanks);
    if (bg == null) {
      bg = 0;
      warnings.push(`${P}: no blank wells with a signal; background set to 0.`);
    }
    const veh = new Map();
    for (const w of pw) if (w.role === 'vehicle' && w.raw != null) {
      if (!veh.has(w.cellLineId)) veh.set(w.cellLineId, []);
      veh.get(w.cellLineId).push(w.raw);
    }
    const missing = new Map(); // reason → count, so warnings are per plate, not per well
    const miss = (reason) => missing.set(reason, (missing.get(reason) || 0) + 1);
    for (const w of pw) {
      if (w.role === 'blank') { w.background = bg; continue; }
      if (w.role !== 'treated' && w.role !== 'vehicle') { if (w.role === 'exclude') w.note = 'excluded'; continue; }
      w.background = bg;
      if (!w.cellLineId) { w.note = 'no cell line assigned'; miss('wells with drug have no cell line assigned (no vehicle control to normalize to)'); continue; }
      const vm = mean(veh.get(w.cellLineId) || []);
      w.vehicleMean = vm;
      if (w.raw == null) { w.note = 'no signal'; continue; }
      if (vm == null) { w.note = 'no vehicle wells for this cell line on this plate'; miss(`${w.cellLine} wells have no vehicle wells (cells, no drug) on this plate`); continue; }
      if (!(vm - bg > 0)) { w.note = 'vehicle mean ≤ background'; miss(`${w.cellLine} wells: vehicle mean is not above the background`); continue; }
      w.viability = ((w.raw - bg) / (vm - bg)) * 100;
    }
    for (const [reason, n] of missing) warnings.push(`${P}: ${n} ${reason}; viability left empty.`);
    wells.push(...pw);
  });
  if (!wells.length) warnings.push('No plate has a readout yet.');

  // ----- conditions -----
  const groups = new Map();
  for (const w of wells) {
    if ((w.role !== 'treated' && w.role !== 'vehicle') || w.viability == null) continue;
    const conc = w.conc.map(roundKey);
    const key = `${w.cellLineId}|${conc.join(',')}`;
    if (!groups.has(key)) groups.set(key, { key, cellLineId: w.cellLineId, cellLine: w.cellLine, conc, vals: [], plates: new Set(), wells: [] });
    const g = groups.get(key);
    g.vals.push(w.viability); g.plates.add(w.plate); g.wells.push(`P${w.plate}:${w.well}`);
  }
  const conditions = [...groups.values()].map((g) => {
    const agents = g.conc.filter((x) => x !== 0).length;
    const label = agents ? g.conc.map((x, i) => (x ? `${fluids[i].name} ${fmtConc(x)} ${fluids[i].unit}` : null)).filter(Boolean).join(' + ') : 'Vehicle';
    return { key: g.key, cellLineId: g.cellLineId, cellLine: g.cellLine, label, agents, conc: g.conc, ...stats(g.vals), plates: [...g.plates].sort((a, b) => a - b), wells: g.wells };
  });
  const cmpConc = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  const clRank = (id) => clOrder.get(id) ?? Infinity;
  conditions.sort((a, b) => clRank(a.cellLineId) - clRank(b.cellLineId) || String(a.cellLine).localeCompare(String(b.cellLine)) || a.agents - b.agents || cmpConc(a.conc, b.conc));

  // ----- synergy (Bliss independence, highest single agent) -----
  const byKey = new Map(conditions.map((c) => [c.key, c]));
  const single = (cl, n, i, x) => { const v = Array(n).fill(0); v[i] = x; return byKey.get(`${cl}|${v.join(',')}`); };
  const synergy = [];
  for (const c of conditions) {
    if (c.agents !== 2) continue;
    const [a, b] = c.conc.map((x, i) => (x ? i : -1)).filter((i) => i >= 0);
    const sa = single(c.cellLineId, c.conc.length, a, c.conc[a]), sb = single(c.cellLineId, c.conc.length, b, c.conc[b]);
    if (!sa || !sb) continue;
    const iA = 1 - sa.mean / 100, iB = 1 - sb.mean / 100, iAB = 1 - c.mean / 100;
    const expected = iA + iB - iA * iB;
    synergy.push({
      cellLineId: c.cellLineId, cellLine: c.cellLine,
      fluidA: fluids[a].id, drugA: fluids[a].name, unitA: fluids[a].unit, concA: c.conc[a],
      fluidB: fluids[b].id, drugB: fluids[b].name, unitB: fluids[b].unit, concB: c.conc[b],
      viabilityA: sa.mean, viabilityB: sb.mean, viabilityAB: c.mean, nA: sa.n, nB: sb.n, nAB: c.n,
      inhibitionA: iA, inhibitionB: iB, inhibitionAB: iAB,
      blissExpected: expected, blissExcess: iAB - expected, hsaExcess: iAB - Math.max(iA, iB),
    });
  }
  synergy.sort((x, y) => clRank(x.cellLineId) - clRank(y.cellLineId) || String(x.cellLine).localeCompare(String(y.cellLine)) ||
    x.fluidA - y.fluidA || x.fluidB - y.fluidB || x.concA - y.concA || x.concB - y.concB);
  return { wells, conditions, synergy, warnings, fluids };
}

// ---------- workbook model ----------
/** Excel sheet names: ≤ 31 characters, none of [ ] : * ? / \, not starting/ending with an apostrophe, unique. */
export function sheetName(name, taken = new Set()) {
  let base = String(name).replace(/[[\]:*?/\\]/g, '_').replace(/^'+|'+$/g, '').trim() || 'Sheet';
  base = base.slice(0, 31);
  let out = base, i = 2;
  while (taken.has(out.toLowerCase())) { const suf = ` (${i++})`; out = base.slice(0, 31 - suf.length) + suf; }
  taken.add(out.toLowerCase());
  return out;
}

const NORMALIZATION_TEXT = 'Viability % = (signal − background) / (vehicle mean − background) × 100. Background = mean signal of the blank wells (medium, no cells) on the same plate; 0 when a plate has no blank wells. Vehicle mean = mean signal of the vehicle wells (cells, no drug) with the same cell line on the same plate. Wells without a signal are left out of every mean. PBS, scrap, excluded and empty wells are listed but not normalized.';
const CONDITIONS_TEXT = 'Treated and vehicle wells pooled over all analyzed plates by cell line and requested concentrations (rounded to 10 significant digits). Wells with the same concentrations are pooled even when they come from different plate sets, e.g. a drug alone appears in every combination block; DMSO normalization can differ between those sets (see DMSO % in Wells). SD is the sample SD (n − 1); SEM = SD / √n; CV % = SD / mean × 100.';
const SYNERGY_TEXT = 'From condition means, for combinations of exactly two drugs whose single-agent conditions (same concentrations, all other drugs 0) were measured for the same cell line. Inhibition I = 1 − viability/100 (not clamped). Bliss expected = I_A + I_B − I_A·I_B; Bliss excess = I_A+B − expected; HSA excess = I_A+B − max(I_A, I_B). Positive = more inhibition than expected (synergy), negative = antagonism.';

function stockText(f) {
  // <Concentration> is in the base unit; <ConcentrationUnit> is the display unit (dispense.js stockInBase)
  try { return `${fmtConc(toDisplay(f.concentration, f.concentrationUnit))} ${unitLabel(f.concentrationUnit)}`; } catch { return `${f.concentration}`; }
}
const nn = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * Workbook model for the xlsx writer (crates/d300-app/src/xlsx.rs mirrors this shape):
 *   { sheets: [{ name, columns: [{ header, width, format? }], rows: (string|number|null)[][],
 *                freeze: [row, col], autofilter?: boolean, boldRows?: number[], header?: boolean }] }
 * `format` is an Excel number format for the column's data cells; boldRows index into `rows`;
 * header: false writes no header row (columns then only set widths); autofilter spans header + rows.
 * @param opts { appVersion, generatedAt (Date or ISO string) } — passed in so output is deterministic in tests.
 */
export function toWorkbook(result, protocol, meta, opts = {}) {
  const taken = new Set();
  const fl = result.fluids || protocol.fluids.map((f) => ({ id: f.id, name: f.name, unit: fluidUnit(f) }));
  const concCols = fl.map((f) => ({ header: `${f.name} (${f.unit})`, width: Math.max(12, f.name.length + 8) }));
  const exp = meta.experiment || {};
  const generatedAt = opts.generatedAt ? new Date(opts.generatedAt) : new Date();
  const analyzed = [...new Set(result.wells.map((w) => w.plateIndex))];
  const cellLines = [...new Set(result.wells.map((w) => w.cellLine).filter(Boolean))];

  const info = [
    ['Experiment', exp.title || ''], ['Date', exp.date || ''], ['Assay', exp.assay || ''], ['Notes', exp.notes || ''],
    ['Protocol file', meta.tdd?.name || ''],
    ['Cell lines', cellLines.join(', ')],
    ['Plates analyzed', analyzed.map((i) => `${i + 1}${protocol.plates[i]?.name ? ` (${protocol.plates[i].name})` : ''}`).join(', ')],
    ['Drugs', protocol.fluids.map((f) => `${f.name}${f.byVol ? ' (by volume)' : ` (stock ${stockText(f)})`}`).join(', ')],
    ['Concentrations', 'Requested concentrations as designed in the protocol (base units: µM for molar drugs, ng/mL for mass, nL for volume fluids).'],
    ['Normalization', NORMALIZATION_TEXT], ['Conditions', CONDITIONS_TEXT], ['Synergy', SYNERGY_TEXT],
    ['Exported by', `Tecan D300 Craft ${opts.appVersion || ''}`.trim()],
    ['Exported at', generatedAt.toISOString()],
  ];
  if (result.warnings.length) result.warnings.forEach((w, i) => info.push([i ? '' : 'Warnings', w]));
  else info.push(['Warnings', 'none']);

  const wellsSheet = {
    name: sheetName('Wells', taken), freeze: [1, 3], autofilter: true,
    columns: [{ header: 'Plate', width: 6 }, { header: 'Plate name', width: 14 }, { header: 'Well', width: 6 }, { header: 'Row', width: 5 }, { header: 'Column', width: 7 },
      { header: 'Role', width: 9 }, { header: 'Cell line', width: 12 }, ...concCols, { header: 'DMSO %', width: 8, format: '0.000' },
      { header: 'Raw signal', width: 11 }, { header: 'Background', width: 11, format: '0.0' }, { header: 'Vehicle mean', width: 12, format: '0.0' },
      { header: 'Viability %', width: 11, format: '0.0' }, { header: 'Note', width: 30 }],
    rows: result.wells.map((w) => [w.plate, w.plateName, w.well, w.row, w.col, w.role, w.cellLine, ...w.conc.map(nn), nn(w.dmsoPct),
      nn(w.raw), nn(w.background), nn(w.vehicleMean), nn(w.viability), w.note]),
  };

  const condSheet = {
    name: sheetName('Conditions', taken), freeze: [1, 2], autofilter: true,
    columns: [{ header: 'Cell line', width: 12 }, { header: 'Condition', width: 34 }, { header: 'Drugs', width: 6 }, ...concCols,
      { header: 'n', width: 5 }, { header: 'Mean viability %', width: 10, format: '0.0' }, { header: 'SD', width: 8, format: '0.0' },
      { header: 'SEM', width: 8, format: '0.0' }, { header: 'CV %', width: 8, format: '0.0' }, { header: 'Plates', width: 10 }, { header: 'Wells', width: 40 }],
    rows: result.conditions.map((c) => [c.cellLine, c.label, c.agents, ...c.conc.map(nn), c.n, nn(c.mean), nn(c.sd), nn(c.sem), nn(c.cv),
      c.plates.join(', '), c.wells.join(', ')]),
  };

  const synSheet = {
    name: sheetName('Synergy (Bliss)', taken), freeze: [1, 1], autofilter: true,
    columns: [{ header: 'Cell line', width: 12 }, { header: 'Drug A', width: 12 }, { header: 'Conc A', width: 9 }, { header: 'Unit A', width: 6 },
      { header: 'Drug B', width: 12 }, { header: 'Conc B', width: 9 }, { header: 'Unit B', width: 6 },
      { header: 'Viability A %', width: 10, format: '0.0' }, { header: 'Viability B %', width: 10, format: '0.0' }, { header: 'Viability A+B %', width: 10, format: '0.0' },
      { header: 'n A', width: 5 }, { header: 'n B', width: 5 }, { header: 'n A+B', width: 6 },
      { header: 'Inhibition A', width: 10, format: '0.000' }, { header: 'Inhibition B', width: 10, format: '0.000' }, { header: 'Inhibition A+B', width: 10, format: '0.000' },
      { header: 'Bliss expected', width: 10, format: '0.000' }, { header: 'Bliss excess', width: 10, format: '0.000' }, { header: 'HSA excess', width: 10, format: '0.000' }],
    rows: result.synergy.map((s) => [s.cellLine, s.drugA, s.concA, s.unitA, s.drugB, s.concB, s.unitB, nn(s.viabilityA), nn(s.viabilityB), nn(s.viabilityAB),
      s.nA, s.nB, s.nAB, nn(s.inhibitionA), nn(s.inhibitionB), nn(s.inhibitionAB), nn(s.blissExpected), nn(s.blissExcess), nn(s.hsaExcess)]),
  };

  // Matrices: one block per cell line × drug pair — mean viability (incl. single agents and vehicle),
  // then Bliss excess, then HSA excess. Columns = drug A ascending, rows = drug B ascending.
  const mRows = [], mBold = [];
  const pairs = new Map();
  for (const s of result.synergy) {
    const k = `${s.cellLineId}|${s.fluidA}|${s.fluidB}`;
    if (!pairs.has(k)) pairs.set(k, []);
    pairs.get(k).push(s);
  }
  const condBy = new Map(result.conditions.map((c) => [c.key, c]));
  for (const list of pairs.values()) {
    const s0 = list[0];
    const ia = fl.findIndex((f) => f.id === s0.fluidA), ib = fl.findIndex((f) => f.id === s0.fluidB);
    const as = [...new Set(list.map((s) => s.concA))].sort((x, y) => x - y);
    const bs = [...new Set(list.map((s) => s.concB))].sort((x, y) => x - y);
    const cellOf = (a, b) => { const v = Array(fl.length).fill(0); v[ia] = a; v[ib] = b; return condBy.get(`${s0.cellLineId}|${v.join(',')}`); };
    const synOf = new Map(list.map((s) => [`${s.concA},${s.concB}`, s]));
    const corner = `${s0.drugB} (${s0.unitB}) \\ ${s0.drugA} (${s0.unitA})`;
    const block = (title, aAxis, bAxis, val) => {
      mBold.push(mRows.length); mRows.push([title]);
      mBold.push(mRows.length); mRows.push([corner, ...aAxis]);
      for (const b of bAxis) mRows.push([b, ...aAxis.map((a) => nn(val(a, b)))]);
      mRows.push([]);
    };
    const head = `${s0.cellLine || '(no cell line)'}: ${s0.drugA} × ${s0.drugB}`;
    block(`${head} — mean viability %`, [0, ...as], [0, ...bs], (a, b) => cellOf(a, b)?.mean);
    block(`${head} — Bliss excess (positive = synergy)`, as, bs, (a, b) => synOf.get(`${a},${b}`)?.blissExcess);
    block(`${head} — HSA excess`, as, bs, (a, b) => synOf.get(`${a},${b}`)?.hsaExcess);
    const bl = list.map((s) => s.blissExcess);
    mRows.push(['Mean Bliss excess', nn(mean(bl)), 'max', nn(Math.max(...bl)), 'min', nn(Math.min(...bl)), 'combinations', list.length]);
    mRows.push([], []);
  }
  if (!mRows.length) mRows.push(['No drug pair has combination and single-agent conditions measured for the same cell line.']);
  const width = Math.max(2, ...mRows.map((r) => r.length));
  const matrixSheet = {
    name: sheetName('Synergy matrix', taken), freeze: [0, 0], boldRows: mBold,
    columns: Array.from({ length: width }, (_, i) => ({ header: '', width: i === 0 ? 26 : 10 })),
    rows: mRows, header: false,
  };

  // Raw grids, as pasted, with row letters and column numbers.
  const maxCols = Math.max(1, ...analyzed.map((i) => protocol.plates[i].cols));
  const rawRows = [], rawBold = [];
  for (const i of analyzed) {
    const p = protocol.plates[i];
    rawBold.push(rawRows.length);
    rawRows.push([`Plate ${i + 1}${p.name ? ` — ${p.name}` : ''} (${p.rows} × ${p.cols})${meta.plates[i]?.readout?.importedAt ? `, imported ${meta.plates[i].readout.importedAt}` : ''}`]);
    const v = meta.plates[i].readout.values;
    for (let r = 0; r < p.rows; r++) rawRows.push([rowLabel(r), ...v[r].map(nn)]);
    rawRows.push([]);
  }
  const rawSheet = {
    name: sheetName('Raw', taken), freeze: [1, 1], boldRows: rawBold,
    columns: [{ header: 'Row', width: 6 }, ...Array.from({ length: maxCols }, (_, c) => ({ header: String(c + 1), width: 9 }))],
    rows: rawRows,
  };

  const infoSheet = { name: sheetName('Info', taken), freeze: [0, 0], columns: [{ header: 'Item', width: 16 }, { header: 'Value', width: 110 }], rows: info };
  return { sheets: [infoSheet, wellsSheet, condSheet, synSheet, matrixSheet, rawSheet] };
}
