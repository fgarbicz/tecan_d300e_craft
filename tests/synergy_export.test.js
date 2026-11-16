import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from '../src/analysis.js';
import { setRole } from '../src/experiment.js';
import { synergyFinderTable, synergyPackage, toCsv, SF_COLUMNS, ENVIRONMENT_YML } from '../src/synergy_export.js';
import { buildSyntheticSynergy, trueViability, NOISE } from './helpers/synthetic_synergy.js';

const root = join(import.meta.dirname, '..');
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);
const setup = () => { const s = buildSyntheticSynergy(); return { ...s, result: analyze({ protocol: s.protocol, meta: s.meta }) }; };

test('SynergyFinder table: columns, blocks, units, row counts, replicates', () => {
  const { protocol, meta, result } = setup();
  assert.deepEqual(result.warnings, []);
  const t = synergyFinderTable(result, protocol, meta);
  assert.deepEqual(t.columns, ['block_id', 'drug1', 'drug2', 'conc1', 'conc2', 'response', 'conc_unit1', 'conc_unit2', 'cell_line_name']);
  assert.equal(t.dataType, 'viability');
  assert.deepEqual(t.warnings, []);
  // one block per cell line × drug pair, cell line order first; drug1 = the wizard's primary drug
  assert.deepEqual(t.blocks.map((b) => [b.block_id, b.cell_line, b.drug1, b.drug2, b.plates]), [
    [1, 'Line A', 'Bortezomib', 'MEN', '1;2'], [2, 'Line A', 'Bortezomib', 'IDOTDO', '5;6'],
    [3, 'Line B', 'Bortezomib', 'MEN', '3;4'], [4, 'Line B', 'Bortezomib', 'IDOTDO', '7;8']]);
  for (const b of t.blocks) {
    assert.equal(b.conc_unit1, 'µM'); assert.equal(b.conc_unit2, 'µM');
    assert.equal(b.n_conc1, 6); assert.equal(b.n_conc2, 6); assert.equal(b.n_combinations, 25); assert.equal(b.missing_cells, 0);
    assert.equal(b.n_wells, 6 * 6 * 8);
  }
  // 4 blocks × 36 dose pairs × 8 replicate wells (2 rows × 2 columns × 2 plates), replicates as separate rows
  assert.equal(t.rows.length, 4 * 36 * 8);
  const groups = new Map();
  for (const r of t.rows) {
    assert.ok(r.block_id >= 1 && r.block_id <= 4);
    assert.equal(r.conc_unit1, 'µM'); assert.equal(r.conc_unit2, 'µM');
    const k = `${r.block_id}|${r.conc1}|${r.conc2}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  assert.equal(groups.size, 4 * 36);
  for (const [k, rs] of groups) {
    assert.equal(rs.length, 8, k);
    // single agents come from the block's own plates only (Bortezomib alone is on all 8 plates)
    assert.equal(new Set(rs.map((r) => r.plate)).size, 2, k);
  }
  // response = % viability, exact replicate means (±NOISE alternates), vehicle = 100
  const blockDrug2 = { 1: 1, 2: 2, 3: 1, 4: 2 };
  for (const [k, rs] of groups) {
    const [b, c1, c2] = k.split('|').map(Number);
    const line = rs[0].cell_line_name;
    const conc = [c1, 0, 0]; conc[blockDrug2[b]] = c2;
    const m = rs.reduce((s, r) => s + r.response, 0) / rs.length;
    close(m, trueViability(line, conc) * 100, 1e-6, k);
    if (c1 || c2) assert.ok(rs.some((r) => Math.abs(r.response - m - NOISE) < 1e-6), `noise ${k}`);
    else assert.ok(rs.every((r) => Math.abs(r.response - 100) < 1e-9));
  }
  assert.ok(groups.has('1|0|0') && groups.has('1|0.1|30') && groups.has('2|0.1|100'));
});

test('SynergyFinder table: excluded wells drop out, a fully missing dose pair is flagged for imputation', () => {
  const { protocol, meta, built } = buildSyntheticSynergy();
  const { r0, c0 } = built.blocks[0].region;
  // block 1 (Line A, plates 1–2): the top-left 2 × 2 replicate group (highest doses) excluded on both plates
  for (const pi of [0, 1]) setRole(meta, pi, [[r0, c0], [r0, c0 + 1], [r0 + 1, c0], [r0 + 1, c0 + 1]], 'exclude');
  setRole(meta, 2, [[r0 + 2, c0 + 2]], 'exclude'); // one well of block 3
  const t = synergyFinderTable(analyze({ protocol, meta }), protocol, meta);
  assert.equal(t.blocks[0].missing_cells, 1);
  assert.equal(t.blocks[0].n_wells, 288 - 8);
  assert.equal(t.blocks[2].n_wells, 287); assert.equal(t.blocks[2].missing_cells, 0);
  assert.ok(t.warnings.some((w) => /^Block 1 \(Line A: Bortezomib × MEN\): 1 dose combination has no measured well; ReshapeData imputes it\.$/.test(w)), t.warnings.join('\n'));
  assert.equal(t.rows.filter((r) => r.block_id === 1 && r.conc1 === 0.1 && r.conc2 === 30).length, 0);
});

test('SynergyFinder table: nothing measured → no rows, a warning', () => {
  const { protocol, meta } = buildSyntheticSynergy();
  for (const p of meta.plates) p.readout = null;
  const t = synergyFinderTable(analyze({ protocol, meta }), protocol, meta);
  assert.equal(t.rows.length, 0); assert.equal(t.blocks.length, 0);
  assert.ok(t.warnings.some((w) => /nothing to export/.test(w)));
});

test('CSV: RFC 4180 quoting, empty for null / non-finite', () => {
  assert.equal(toCsv(['a', 'b', 'c'], [{ a: 'x,y', b: 'say "hi"', c: null }, ['line\nbreak', NaN, 1.5]]),
    'a,b,c\n"x,y","say ""hi""",\n"line\nbreak",,1.5\n');
});

test('package: file list, relative paths, CSV contents, R script, environment', () => {
  const { protocol, meta, result } = setup();
  const pkg = synergyPackage(result, protocol, meta, { title: 'Screen "7" $& C:\\x', generatedAt: '2026-11-15T12:00:00Z', appVersion: '0.2.0' });
  assert.deepEqual(Object.keys(pkg), ['files']);
  assert.deepEqual(pkg.files.map((f) => f.path), ['data/synergyfinder_input.csv', 'data/block_map.csv', 'data/wells_annotated.csv', 'analysis.R', 'README.md', 'environment.yml']);
  for (const f of pkg.files) {
    assert.equal(typeof f.text, 'string'); assert.ok(f.text.length > 0);
    assert.ok(!f.path.startsWith('/') && !f.path.includes('..'));
  }
  const file = (p) => pkg.files.find((f) => f.path === p).text;
  const input = file('data/synergyfinder_input.csv').trimEnd().split('\n');
  assert.equal(input[0], SF_COLUMNS.join(','));
  assert.equal(input.length, 1 + 1152);
  assert.match(input[1], /^1,Bortezomib,MEN,0,0,100,µM,µM,Line A$/);
  const map = file('data/block_map.csv').trimEnd().split('\n');
  assert.equal(map.length, 5);
  assert.equal(map[0], 'block_id,cell_line,drug1,drug2,conc_unit1,conc_unit2,plates,n_wells,n_conc1,n_conc2,n_combinations,missing_cells,title');
  const wells = file('data/wells_annotated.csv').trimEnd().split('\n');
  assert.equal(wells.length, 1 + result.wells.length);
  assert.match(wells[0], /^plate,plate_name,well,row,col,role,cell_line,Bortezomib \(µM\),MEN \(µM\),IDOTDO \(µM\),Kynurenin \(µM\),dmso_pct,raw_signal,background,vehicle_mean,viability_pct,note,synergyfinder_blocks$/);
  assert.ok(wells.some((l) => /,vehicle,Line A,.*,1$/.test(l))); // a vehicle well of block 1
  const R = file('analysis.R');
  assert.ok(!R.includes('__TITLE__'));
  assert.ok(R.includes('title            = "Screen \\"7\\" $& C:\\\\x",'), 'title escaped for an R string');
  assert.ok(!/\/Users\/|[A-Z]:\\\\Users/.test(R), 'no absolute paths');
  assert.match(R, /ReshapeData\(input, data_type = "viability", impute = OPTIONS\$impute, noise = FALSE/);
  assert.match(R, /CalculateSynergy\(/); assert.match(R, /CalculateSensitivity\(/);
  assert.match(R, /methods\s+= c\("ZIP", "HSA", "Bliss", "Loewe"\)/);
  assert.match(R, /formats .*else c\("png", "pdf", "svg", "rds"\)/);
  assert.ok(/^[\x00-\x7f]*$/.test(R), 'analysis.R is ASCII (non-ASCII as \\u escapes), whatever the R locale');
  const readme = file('README.md');
  assert.match(readme, /Ianevski A, Giri AK, Aittokallio T\. SynergyFinder 3\.0/);
  assert.match(readme, /\| 4 \| Line B \| Bortezomib \(µM\) \| IDOTDO \(µM\) \| 7, 8 \| 6 × 6 \| 288 \|/);
  assert.equal(file('environment.yml'), ENVIRONMENT_YML);
  // the repo copy that created / documents the conda env is the same file
  assert.equal(readFileSync(join(root, 'tools/synergyfinder/environment.yml'), 'utf8'), ENVIRONMENT_YML);
  assert.match(ENVIRONMENT_YML, /^name: synergyfinder$/m);
  assert.match(ENVIRONMENT_YML, /bioconductor-synergyfinder=3\.18\.0/);
});
