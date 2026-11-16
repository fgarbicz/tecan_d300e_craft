import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReadout, analyze, toWorkbook, sheetName, rowLabel } from '../src/analysis.js';
import { wellKey } from '../src/tdd.js';
import { setRole } from '../src/experiment.js';
import { buildSynthetic, trueV, fA, fB, S, EPS, PLATES, EXCLUDED } from './helpers/synthetic_readout.js';

// ---------- parsing ----------
const grid = (rows, cols, f = (r, c) => r * 100 + c + 1) => Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => f(r, c)));
const tsv = (g, { header = false, labels = false, sep = '\t', fmt = String } = {}) => {
  const lines = [];
  if (header) lines.push([labels ? '' : null, ...g[0].map((_, c) => c + 1)].filter((x) => x !== null).join(sep));
  g.forEach((row, r) => lines.push([...(labels ? [rowLabel(r)] : []), ...row.map((v) => (v == null ? '' : fmt(v)))].join(sep)));
  return lines.join('\n');
};

test('parse: plain 8×12 grid, tab-separated, as copied from Excel', () => {
  const g = grid(8, 12);
  const res = parseReadout(tsv(g), 8, 12);
  assert.equal(res.format, 'grid');
  assert.deepEqual(res.values, g);
  assert.deepEqual(res.warnings, []);
});

test('parse: grid with column header and row letters, CRLF, trailing tab', () => {
  const g = grid(16, 24);
  const text = tsv(g, { header: true, labels: true }).split('\n').map((l) => l + '\t').join('\r\n');
  const res = parseReadout(text, 16, 24);
  assert.deepEqual(res.values, g);
});

test('parse: plate-reader export with metadata above and below the block', () => {
  const g = grid(8, 12, (r, c) => 1000 + r * 12 + c + 0.5);
  const text = ['Plate reader export', 'Gain\t135', 'Temperature: 25.0 °C', '', tsv(g, { header: true, labels: true }), '', 'Read time\t0.1 s', 'End'].join('\n');
  const res = parseReadout(text, 8, 12);
  assert.deepEqual(res.values, g);
  assert.ok(res.warnings.some((w) => /Skipped \d+ lines/.test(w)));
});

test('parse: 1536 rows AA..AF are recognised as row labels', () => {
  const g = grid(32, 48);
  assert.deepEqual(parseReadout(tsv(g, { labels: true, header: true }), 32, 48).values, g);
});

test('parse: well list A1 / A01, tab or semicolon', () => {
  const text = 'Well\tSignal\nA1\t10\nA02\t20\nB1\t30\nH12\t99\n';
  const res = parseReadout(text, 8, 12);
  assert.equal(res.format, 'list');
  assert.equal(res.values[0][0], 10); assert.equal(res.values[0][1], 20); assert.equal(res.values[1][0], 30); assert.equal(res.values[7][11], 99);
  assert.equal(res.values[2][2], null);
  assert.ok(res.warnings.some((w) => /4 of 96 wells/.test(w)));
  const semi = parseReadout('A01;12345,5\nA02;7,25\n', 8, 12);
  assert.equal(semi.values[0][0], 12345.5); assert.equal(semi.values[0][1], 7.25);
  assert.throws(() => parseReadout('A1\t1\nA1\t2', 8, 12), /A1 appears twice/);
  assert.throws(() => parseReadout('A1\t1\nP24\t2', 8, 12), /P24 is outside this plate \(8 × 12/);
});

test('parse: decimal comma with tab or semicolon separators', () => {
  const g = grid(8, 12, (r, c) => r * 1000 + c + 0.25);
  const comma = (v) => String(v).replace('.', ',');
  assert.deepEqual(parseReadout(tsv(g, { fmt: comma }), 8, 12).values, g);
  assert.deepEqual(parseReadout(tsv(g, { sep: ';', fmt: comma, labels: true, header: true }), 8, 12).values, g);
  // comma-separated with decimal points
  assert.deepEqual(parseReadout(tsv(g, { sep: ',' }), 8, 12).values, g);
});

test('parse: thousands separators are refused, never misread', () => {
  // every comma value looks like a thousands group: ambiguous
  const g = grid(8, 12, (r, c) => `${r + 1},${String(100 + c).padStart(3, '0')}`);
  assert.throws(() => parseReadout(tsv(g), 8, 12), /ambiguous: decimal comma or thousands separator/);
  const g2 = grid(8, 12, () => '1,234,567');
  assert.throws(() => parseReadout(tsv(g2), 8, 12), /thousands separators are not supported/i);
  const g3 = grid(8, 12, () => '1.234,5');
  assert.throws(() => parseReadout(tsv(g3), 8, 12), /thousands separators are not supported/i);
  // one unambiguous decimal-comma value settles the block: 12,345 is then 12.345
  const g4 = grid(8, 12, (r, c) => (r === 0 && c === 0 ? '0,5' : '12,345'));
  const res = parseReadout(tsv(g4), 8, 12);
  assert.equal(res.values[0][0], 0.5); assert.equal(res.values[3][3], 12.345);
});

test('parse: empty cells and OVER / NaN / - become null with a warning', () => {
  const g = grid(8, 12);
  const t = g.map((row) => row.map(String));
  t[0][0] = 'OVER'; t[1][1] = 'NaN'; t[2][2] = '-'; t[3][3] = '';
  const res = parseReadout(t.map((r) => r.join('\t')).join('\n'), 8, 12);
  assert.equal(res.values[0][0], null); assert.equal(res.values[1][1], null); assert.equal(res.values[2][2], null); assert.equal(res.values[3][3], null);
  assert.equal(res.values[4][4], g[4][4]);
  assert.ok(res.warnings.some((w) => /3 wells have no numeric value.*A1 \(OVER\), B2 \(NaN\), C3 \(-\)/.test(w)), res.warnings.join('|'));
  // negative and scientific values are numbers
  t[5][5] = '-12.5'; t[6][6] = '1.2E+05';
  const r2 = parseReadout(t.map((r) => r.join('\t')).join('\n'), 8, 12);
  assert.equal(r2.values[5][5], -12.5); assert.equal(r2.values[6][6], 120000);
});

test('parse: wrong dimensions give a clear error', () => {
  assert.throws(() => parseReadout(tsv(grid(8, 12), { labels: true, header: true }), 16, 24), /^Error: Found 8 rows × 12 columns; this plate is 16 × 24\.$/);
  assert.throws(() => parseReadout(tsv(grid(16, 24)), 8, 12), /Found 16 rows × 24 columns; this plate is 8 × 12/);
  assert.throws(() => parseReadout('hello\nworld', 8, 12), /No plate readout found/);
  assert.throws(() => parseReadout('  \n', 8, 12), /empty/);
});

// ---------- analysis on a synthetic experiment with a known answer ----------
const close = (a, b, tol = 1e-9, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);

test('synthetic experiment: viability, condition statistics, Bliss and HSA', () => {
  const { protocol, meta, block } = buildSynthetic();
  const res = analyze({ protocol, meta });
  // only plates with a readout
  assert.equal(res.wells.length, 3 * 384);
  assert.ok(!res.wells.some((w) => w.plateIndex === 3));
  assert.deepEqual(res.warnings, []);

  // per well: plate 1 (index 1), first grid well (B2) has the highest a and b, cell line A, −EPS
  const [hiA] = block.primaryLevels, [hiB] = block.partnerLevels;
  const w = res.wells.find((x) => x.plateIndex === 1 && x.well === 'B2');
  assert.equal(w.role, 'treated'); assert.equal(w.cellLine, 'Line A');
  assert.equal(w.conc[0], hiA); assert.equal(w.conc[1], hiB); assert.equal(w.conc[2], 0);
  close(w.background, PLATES[1].bg); close(w.vehicleMean, PLATES[1].top, 1e-6);
  close(w.viability, trueV('A', hiA, hiB) * 100 - EPS, 1e-9);
  assert.ok(w.dmsoPct > 0 && w.dmsoPct <= 1.0001, `DMSO ${w.dmsoPct}`);
  const pbs = res.wells.find((x) => x.plateIndex === 0 && x.well === 'A1');
  assert.equal(pbs.role, 'pbs'); assert.equal(pbs.raw, null); assert.equal(pbs.viability, null);
  const blank = res.wells.find((x) => x.plateIndex === 0 && x.well === 'M2');
  assert.equal(blank.role, 'blank'); assert.equal(blank.viability, null); assert.equal(blank.background, PLATES[0].bg);
  const ex = res.wells.find((x) => x.plateIndex === EXCLUDED[0] && x.r === EXCLUDED[1] && x.c === EXCLUDED[2]);
  assert.equal(ex.role, 'exclude'); assert.equal(ex.viability, null); assert.equal(ex.note, 'excluded');

  // conditions: line A pools plates 0 and 1 (2 × 2 replicates each); ±EPS → mean exact, SD = EPS·√(8/7)
  const cond = (line, a, b) => res.conditions.find((c) => c.cellLine === line && c.conc[0] === a && c.conc[1] === b && c.conc[2] === 0 && c.conc[3] === 0);
  const c1 = cond('Line A', hiA, hiB);
  assert.equal(c1.n, 8); assert.deepEqual(c1.plates, [1, 2]); assert.equal(c1.agents, 2);
  close(c1.mean, trueV('A', hiA, hiB) * 100, 1e-9);
  close(c1.sd, EPS * Math.sqrt(8 / 7), 1e-9);
  close(c1.sem, c1.sd / Math.sqrt(8), 1e-12);
  close(c1.cv, (c1.sd / c1.mean) * 100, 1e-9);
  assert.match(c1.label, /^Bortezomib 0\.02 µM \+ MEN 3 µM$/);
  const veh = cond('Line A', 0, 0);
  assert.equal(veh.label, 'Vehicle'); assert.equal(veh.n, 8); close(veh.mean, 100, 1e-9); close(veh.sd, 0, 1e-9);
  // the excluded well drops out of its condition (line B, one plate: 4 wells → 3)
  assert.equal(cond('Line B', hiA, hiB).n, 3);
  assert.equal(cond('Line B', block.primaryLevels[1], hiB).n, 4);
  // 2 lines × (1 vehicle + 3 A + 3 B + 9 combinations)
  assert.equal(res.conditions.length, 2 * 16);

  // synergy: line A is Bliss-independent (excess 0), line B has excess S·fA·fB in every combination
  assert.equal(res.synergy.length, 18);
  for (const s of res.synergy) {
    const iA = 1 - fA(s.concA), iB = 1 - fB(s.concB);
    close(s.inhibitionA, iA, 1e-9, 'I_A'); close(s.inhibitionB, iB, 1e-9, 'I_B');
    close(s.blissExpected, iA + iB - iA * iB, 1e-9, 'expected');
    const excess = s.cellLine === 'Line B' ? S * fA(s.concA) * fB(s.concB) : 0;
    close(s.blissExcess, excess, 1e-9, `Bliss ${s.cellLine} ${s.concA} ${s.concB}`);
    close(s.hsaExcess, s.inhibitionAB - Math.max(iA, iB), 1e-12);
    assert.equal(s.drugA, 'Bortezomib'); assert.equal(s.drugB, 'MEN');
  }
  assert.ok(res.synergy.filter((s) => s.cellLine === 'Line B').every((s) => s.blissExcess > 0.01));
  // positive control for the test itself: HSA excess of an independent pair is positive (both drugs act)
  assert.ok(res.synergy.filter((s) => s.cellLine === 'Line A').every((s) => s.hsaExcess > 0));
});

test('analysis warns instead of guessing: no blanks, no vehicle, no cell line', () => {
  const { protocol, meta, block } = buildSynthetic();
  setRole(meta, 0, [[12, 1], [12, 2], [12, 3], [12, 4]], null); // plate 1 loses its blanks
  // plate 2: line A vehicle wells removed (re-labelled excluded) → no vehicle for this line on the plate
  const vehCells = [];
  for (let i = 0; i < block.region.rows; i++) for (let j = 0; j < block.region.cols; j++) {
    const r = block.region.r0 + i, c = block.region.c0 + j;
    if (!protocol.plates[1].wells.get(wellKey(r, c))?.size) vehCells.push([r, c]);
  }
  assert.equal(vehCells.length, 4);
  setRole(meta, 1, vehCells, 'exclude');
  delete meta.plates[2].cellLines[wellKey(1, 2)]; // one drugged well without cells annotated
  const res = analyze({ protocol, meta });
  assert.ok(res.warnings.some((w) => /^Plate 1: no blank wells with a signal; background set to 0\.$/.test(w)), res.warnings.join('\n'));
  assert.ok(res.warnings.some((w) => /^Plate 2: 60 Line A wells have no vehicle wells/.test(w)), res.warnings.join('\n'));
  assert.ok(res.warnings.some((w) => /^Plate 3: 1 wells with drug have no cell line/.test(w)), res.warnings.join('\n'));
  const w0 = res.wells.find((x) => x.plateIndex === 0 && x.well === 'B2');
  close(w0.viability, (w0.raw / w0.vehicleMean) * 100, 1e-9); // bg 0
  assert.ok(res.wells.filter((x) => x.plateIndex === 1 && x.role === 'treated').every((x) => x.viability == null));
  // plate 2 is now out of every line A condition
  assert.ok(res.conditions.filter((c) => c.cellLine === 'Line A').every((c) => !c.plates.includes(2)));
  // no readout anywhere
  for (const p of meta.plates) p.readout = null;
  assert.deepEqual(analyze({ protocol, meta }).warnings, ['No plate has a readout yet.']);
});

test('the parsed readout drives the same analysis as the numbers themselves', () => {
  const { protocol, meta } = buildSynthetic();
  const v = meta.plates[0].readout.values;
  const text = ['Luminescence', '', tsv(v, { header: true, labels: true, fmt: (x) => x.toPrecision(17) })].join('\n');
  const parsed = parseReadout(text, 16, 24);
  assert.deepEqual(parsed.values, v);
});

// ---------- workbook ----------
test('workbook: sheets, headers, shapes, JSON-safe values', () => {
  const { protocol, meta } = buildSynthetic();
  meta.experiment.title = 'Synthetic CTG';
  const res = analyze({ protocol, meta });
  const wb = toWorkbook(res, protocol, meta, { appVersion: '0.1.0', generatedAt: '2026-11-15T12:00:00Z' });
  assert.deepEqual(wb.sheets.map((s) => s.name), ['Info', 'Wells', 'Conditions', 'Synergy (Bliss)', 'Synergy matrix', 'Raw']);
  for (const s of wb.sheets) {
    assert.ok(s.name.length <= 31 && !/[[\]:*?/\\]/.test(s.name));
    assert.equal(s.freeze.length, 2);
    for (const row of s.rows) for (const x of row) assert.ok(x === null || typeof x === 'string' || Number.isFinite(x), `${s.name}: ${x}`);
    if (s.autofilter) for (const row of s.rows) assert.equal(row.length, s.columns.length, `${s.name} row width`);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(wb)), wb); // nothing JSON would silently change (NaN, undefined)
  const [info, wells, conds, syn, matrix, raw] = wb.sheets;
  assert.deepEqual(info.rows[0], ['Experiment', 'Synthetic CTG']);
  assert.ok(info.rows.some((r) => r[0] === 'Exported by' && r[1] === 'Tecan D300 Craft 0.1.0'));
  assert.ok(info.rows.some((r) => r[0] === 'Drugs' && /Bortezomib \(stock 1 mM\)/.test(r[1])), JSON.stringify(info.rows.find((r) => r[0] === 'Drugs')));
  assert.equal(wells.rows.length, 3 * 384);
  assert.deepEqual(wells.columns.slice(7, 11).map((c) => c.header), ['Bortezomib (µM)', 'MEN (µM)', 'IDOTDO (µM)', 'Kynurenin (µM)']);
  assert.equal(conds.rows.length, res.conditions.length);
  assert.equal(syn.rows.length, 18);
  // matrix: 2 cell lines × 1 pair, viability block is 4 × 4 with the vehicle (100 %) in the corner
  assert.equal(matrix.rows.filter((r) => /mean viability %$/.test(r[0] || '')).length, 2);
  const i = matrix.rows.findIndex((r) => /^Line A: Bortezomib × MEN — mean viability %$/.test(r[0] || ''));
  assert.deepEqual(matrix.rows[i + 1].slice(1), [0, 0.005, 0.01, 0.02]);
  close(matrix.rows[i + 2][1], 100, 1e-9);
  const j = matrix.rows.findIndex((r) => /^Line B: .*Bliss excess/.test(r[0] || ''));
  close(matrix.rows[j + 2][1], S * fA(0.005) * fB(0.75), 1e-9);
  assert.ok(matrix.boldRows.includes(i));
  // raw: title + 16 rows + blank per plate, values as given
  assert.equal(raw.rows.length, 3 * 18);
  assert.match(raw.rows[0][0], /^Plate 1 \(16 × 24\)/);
  assert.equal(raw.rows[1][0], 'A'); assert.equal(raw.rows[1][1], null); assert.equal(raw.rows[2][2], meta.plates[0].readout.values[1][1]);
});

test('workbook: degenerate results (no combinations, no readout) still give valid sheets', () => {
  const single = buildSynthetic();
  for (const p of single.protocol.plates) for (const w of p.wells.values()) w.delete(1);
  const r1 = analyze(single);
  assert.equal(r1.synergy.length, 0);
  const wb1 = toWorkbook(r1, single.protocol, single.meta, { appVersion: 'x' });
  assert.equal(wb1.sheets[3].rows.length, 0);
  assert.match(wb1.sheets[4].rows[0][0], /No drug pair/);
  const empty = buildSynthetic();
  for (const p of empty.meta.plates) p.readout = null;
  const wb2 = toWorkbook(analyze(empty), empty.protocol, empty.meta);
  assert.deepEqual(wb2.sheets.map((s) => s.rows.length).slice(1, 4), [0, 0, 0]);
  assert.equal(wb2.sheets[5].rows.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(wb2)), wb2);
});

test('parse: dot-grouped values next to whole numbers are refused', () => {
  const g = grid(8, 12, (r, c) => ((r + c) % 2 ? '850' : `${r + 1}.${String(100 + c).padStart(3, '0')}`));
  assert.throws(() => parseReadout(tsv(g), 8, 12), /thousands separators/);
  // all values with 3 decimals and no whole numbers: read as decimals, with a warning
  const g2 = grid(8, 12, (r, c) => `${r + 1}.${String(100 + c).padStart(3, '0')}`);
  const res = parseReadout(tsv(g2), 8, 12);
  assert.equal(res.values[0][0], 1.1);
  assert.ok(res.warnings.some((w) => /1000× too small/.test(w)));
});

test('sheetName sanitises and de-duplicates', () => {
  const taken = new Set();
  assert.equal(sheetName('a/b:c*d?[e]\\f', taken), 'a_b_c_d__e__f');
  assert.equal(sheetName('x'.repeat(40), taken), 'x'.repeat(31));
  assert.equal(sheetName('x'.repeat(40), taken), 'x'.repeat(27) + ' (2)');
  assert.equal(sheetName("'q'", taken), 'q');
});
