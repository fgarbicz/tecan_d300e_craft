import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titrationLevels, suggestShift, buildSynergy, applyTitration, newPlate, addNormalization, removePlate } from '../src/ops.js';
import { wellKey } from '../src/tdd.js';

const close = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg}: ${a} vs ${b}`);

test('log titration matches guide p.98 data (100 -> 0.0013, 6 points)', () => {
  const got = titrationLevels({ mode: 'highLow', high: 100, low: 0.0013, levels: 6, distribution: 'log' });
  [100, 10.53874, 1.11065, 0.117049, 0.012335, 0.0013].forEach((v, i) => close(got[i], v, 5e-5, `level ${i}`));
});

test('dilution and fractional-log titrations', () => {
  assert.deepEqual(titrationLevels({ mode: 'high', high: 8, levels: 4, distribution: 'dilution', factor: 2 }), [8, 4, 2, 1]);
  assert.deepEqual(titrationLevels({ mode: 'low', low: 1, levels: 3, distribution: 'dilution', factor: 3 }), [9, 3, 1]);
  close(titrationLevels({ mode: 'high', high: 10, levels: 3, distribution: 'halfLog' })[2], 1, 1e-12, 'half log');
  assert.throws(() => titrationLevels({ mode: 'high', high: 1, levels: 5, distribution: 'linear', increment: 0.5 }));
});

test('fluid shift / extend: both guide examples (p.29-30)', () => {
  const fluid = { concentration: 5000, classId: 0 };
  const plate = { assayVolume: 200000, dmsoLimit: 0.01 };
  assert.deepEqual(suggestShift(fluid, plate, 1, 0.0001), { kind: 'shift', factor: 4 });
  assert.deepEqual(suggestShift(fluid, plate, 5, 0.00001), { kind: 'extend', factor: 40 });
  assert.equal(suggestShift(fluid, plate, 5, 0.01), null);
});

test('titration placement with replicates', () => {
  const p = newPlate({ plateType: 'Default96' });
  const cells = [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5]];
  applyTitration(p, cells, 0, [10, 1, 0.1], { replicates: 2, pattern: 'rowsTL' });
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((c) => p.wells.get(wellKey(0, c)).get(0)), [10, 10, 1, 1, 0.1, 0.1]);
  assert.throws(() => applyTitration(p, cells.slice(0, 5), 0, [1, 2], { replicates: 2 }));
});

test('synergy A*B: 6x6 grid with zeros, A down rows, B across columns', () => {
  const plates = buildSynergy({ type: 'ABC', layout: 'single', plate: { plateType: 'Default96' },
    fluids: [{ fluidId: 0, levels: [5, 4, 3, 2, 1], includeZero: true }, { fluidId: 1, levels: [50, 40, 30, 20, 10], includeZero: true }] });
  assert.equal(plates.length, 1);
  const w = plates[0].wells;
  assert.deepEqual([...w.get(wellKey(0, 0))], [[0, 5], [1, 50]]);
  assert.deepEqual([...w.get(wellKey(4, 0))], [[0, 1], [1, 50]]);
  assert.deepEqual([...w.get(wellKey(5, 0))], [[1, 50]]); // A = 0
  assert.equal(w.has(wellKey(5, 5)), false); // 0 + 0 -> empty well
  assert.equal(w.size, 35);
});

test('synergy plate breaks: guide examples (9 grids fit; 5x3 -> 5 per plate; 2x4x3 -> 8 per plate)', () => {
  const f = (id, n) => ({ fluidId: id, levels: Array.from({ length: n }, (_, i) => n - i) });
  const base = { type: 'ABC', layout: 'multipleBreaks', gridOrder: 'rows', plate: { plateType: 'Default96' } };
  // 2x4 grid on 96 well: 4 per column x 3 per row = 12 capacity; use 3x4 grid -> floor(8/3)=2 * floor(12/4)=3 -> 6.
  // To get capacity 9 use 2x... simpler: 3x4 grid on 384 excluding rows/cols to get 3x3 slots (9 rows, 12 cols).
  const ex = { excludedRows: new Set([9, 10, 11, 12, 13, 14, 15]), excludedCols: new Set(Array.from({ length: 12 }, (_, i) => 12 + i)) };
  const p1 = buildSynergy({ ...base, ...ex, plate: { plateType: 'Default384' }, fluids: [f(0, 3), f(1, 4), f(2, 5), f(3, 3)] });
  assert.equal(p1.length, 3); // 15 grids at 5 per plate
  const p2 = buildSynergy({ ...base, ...ex, plate: { plateType: 'Default384' }, fluids: [f(0, 3), f(1, 4), f(2, 2), f(3, 4), f(4, 3)] });
  assert.equal(p2.length, 3); // 24 grids at 8 per plate
});

test('normalization: one group per class per well; removing a plate renumbers wells', () => {
  const pr = { backfills: [], plates: [newPlate(), newPlate(), newPlate()] };
  addNormalization(pr, 0, 'ToMaxVolume', null, [{ p: 0, r: 0, c: 0 }, { p: 2, r: 0, c: 0 }]);
  addNormalization(pr, 0, 'ToAssayVolumePct', 0.01, [{ p: 0, r: 0, c: 0 }]);
  assert.equal(pr.backfills.length, 2);
  assert.deepEqual(pr.backfills[0].wells, [{ p: 2, r: 0, c: 0 }]);
  removePlate(pr, 1);
  assert.deepEqual(pr.backfills[0].wells, [{ p: 1, r: 0, c: 0 }]);
});

test('synergy reproduces D300e Control output exactly (T06: 2 fluids, 6 levels each, include 0)', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { parseTdd } = await import('../src/tdd.js');
  const { synergyLevels } = await import('../src/ops.js');
  const ref = parseTdd(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'reference', 't06-synergy.tdd'), 'utf8')).plates[1];
  const lv = (id, order) => ({ fluidId: id, includeZero: true, order,
    levels: synergyLevels({ mode: 'highLow', high: 50, low: 0.05, levels: 6, distribution: 'log', includeZero: true }) });
  const [mine] = buildSynergy({ type: 'ABC', layout: 'single', plate: { plateType: 'Default384', assayVolume: 50000, dmsoLimit: 0.01 },
    fluids: [lv(0, 'highFirst'), lv(2, 'lowFirst')] });
  assert.equal(mine.name, 'Synergy');
  assert.equal(mine.wells.size, ref.wells.size);
  for (const [k, m] of ref.wells) for (const [id, v] of m) close(mine.wells.get(k)?.get(id), v, 1e-12, `well ${k} fluid ${id}`);
});

test('titration patterns reproduce D300e Control (T04)', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { parseTdd } = await import('../src/tdd.js');
  const { TITRATION_PATTERNS } = await import('../src/ops.js');
  const ref = parseTdd(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'reference', 't04-titration.tdd'), 'utf8')).plates[0];
  const p = newPlate({ plateType: 'Default384' });
  const L = (n) => titrationLevels({ mode: 'highLow', high: 10, low: 0.003, levels: n, distribution: 'log' });
  // same order of operations as in D300e: row B, then column 4, then column 6 (later ones replace)
  applyTitration(p, Array.from({ length: 24 }, (_, c) => [1, c]), 0, L(8), { replicates: 3, pattern: 'rowsTL' });
  applyTitration(p, Array.from({ length: 16 }, (_, r) => [r, 3]), 0, L(8), { replicates: 2, pattern: 'colsTL' });
  applyTitration(p, Array.from({ length: 16 }, (_, r) => [r, 5]), 0, L(8), { replicates: 2, pattern: 'colsBL' });
  assert.equal(p.wells.size, ref.wells.size);
  for (const [k, m] of ref.wells) close(p.wells.get(k)?.get(0), m.get(0), 1e-12, `well ${k}`);
  // the four corners, row-wise from top-right on a 2x3 block: highest at top-right, then leftwards
  const q = newPlate({ plateType: 'Default96' });
  applyTitration(q, [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]], 0, [6, 5, 4, 3, 2, 1], { pattern: 'rowsTR' });
  assert.deepEqual([[0, 2], [0, 1], [0, 0], [1, 2], [1, 1], [1, 0]].map(([r, c]) => q.wells.get(`${r},${c}`).get(0)), [6, 5, 4, 3, 2, 1]);
  assert.equal(Object.keys(TITRATION_PATTERNS).length, 8);
});

test('randomization: T09 storage round-trips; randomizing makes a permutation and merges groups', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { parseTdd, writeTdd } = await import('../src/tdd.js');
  const { randomizeWells, dispensedWell } = await import('../src/ops.js');
  const txt = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'reference', 't09-randomize.tdd'), 'utf8');
  const p = parseTdd(txt);
  assert.equal(p.plates[0].randomization.length, 24);
  assert.deepEqual(dispensedWell(p.plates[0], 1, 0), [1, 12]);
  // rewriting from the semantic list (not the raw node) gives the same bytes
  delete p.plates[0]._randomizeRaw;
  assert.equal(writeTdd(p), txt);
  const q = newPlate();
  let seed = 1; const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  randomizeWells(q, [[0, 0], [0, 1], [0, 2]], rng);
  randomizeWells(q, [[1, 0]], rng);
  const from = q.randomization.map((m) => `${m.r},${m.c}`).sort(), to = q.randomization.map((m) => `${m.toR},${m.toC}`).sort();
  assert.deepEqual(from, ['0,0', '0,1', '0,2', '1,0']); assert.deepEqual(to, from);
});

test('Quick Plate reproduces D300e Control (T08) and the guide examples', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { parseTdd } = await import('../src/tdd.js');
  const { buildQuickPlate } = await import('../src/ops.js');
  const ref = parseTdd(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'reference', 't08-quickplate.tdd'), 'utf8')).plates;
  const levels = titrationLevels({ mode: 'highLow', high: 10, low: 0.003, levels: 8, distribution: 'log' });
  const base = { fluids: [0], levels, replicates: 2, layout: 'rows', keepReplicatesTogether: false, plate: { plateType: 'Default384' } };
  for (const [start, refPlate] of [['continuous', ref[1]], ['newLine', ref[2]]]) {
    const [mine] = buildQuickPlate({ ...base, start });
    assert.equal(mine.name, 'Quick Plate');
    assert.deepEqual([...mine.wells.keys()].sort(), [...refPlate.wells.keys()].sort(), start);
    for (const [k, m] of refPlate.wells) close(mine.wells.get(k).get(0), m.get(0), 1e-12, `${start} ${k}`);
  }
  // Guide example 1 (p.58-59): 96-well, 4 fluids, 8 levels, 3 replicates, by columns, not together, no interleave
  const g1 = buildQuickPlate({ fluids: [0, 1, 2, 3], levels: [8, 7, 6, 5, 4, 3, 2, 1], replicates: 3, layout: 'cols',
    keepReplicatesTogether: false, interleave: 'none', start: 'continuous', plate: { plateType: 'Default96' } });
  assert.equal(g1.length, 1);
  for (let f = 0; f < 4; f++) for (let k = 0; k < 3; k++) for (let r = 0; r < 8; r++)
    assert.equal(g1[0].wells.get(`${r},${f * 3 + k}`).get(f), 8 - r, `ex1 fluid ${f} col ${f * 3 + k} row ${r}`);
  // Guide example 2 (p.60-61): 3 x 96-well with perimeter excluded, 6 fluids, 10 levels, 3 replicates,
  // by rows, not together, change fluid after each singlicate -> replicate k on plate k, rows B-G = fluids
  const ten = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const g2 = buildQuickPlate({ fluids: [0, 1, 2, 3, 4, 5], levels: ten, replicates: 3, layout: 'rows', keepReplicatesTogether: false,
    interleave: 'singlicate', start: 'continuous', plate: { plateType: 'Default96' }, excludedRows: new Set([0, 7]), excludedCols: new Set([0, 11]) });
  assert.equal(g2.length, 3);
  for (const pl of g2) for (let f = 0; f < 6; f++) for (let c = 1; c <= 10; c++) assert.equal(pl.wells.get(`${f + 1},${c}`).get(f), 11 - c);
  // Guide example 3 (p.62-63): 384, cols 1-2 excluded, 16 fluids, 10 levels, 2 replicates, by columns, keep
  // replicates together, change fluid after each level replicate -> col 3 = level 1 of fluids 1-8, col 4 = fluids 9-16 ...
  const g3 = buildQuickPlate({ fluids: [...Array(16).keys()], levels: ten, replicates: 2, layout: 'cols', keepReplicatesTogether: true,
    interleave: 'level', start: 'newLine', plate: { plateType: 'Default384' }, excludedCols: new Set([0, 1]) });
  assert.equal(g3.length, 1);
  assert.equal(g3[0].wells.get('0,2').get(0), 10); assert.equal(g3[0].wells.get('1,2').get(0), 10); assert.equal(g3[0].wells.get('2,2').get(1), 10);
  assert.equal(g3[0].wells.get('0,3').get(8), 10); assert.equal(g3[0].wells.get('0,4').get(0), 9);
  assert.equal(g3[0].wells.get('15,21').get(15), 1); assert.equal(g3[0].wells.has('0,22'), false);
});

test('three-fluid synergy reproduces D300e Control (T07: A×B×C, grids stacked by columns, C low→high)', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { parseTdd, writeTdd } = await import('../src/tdd.js');
  const { synergyLevels } = await import('../src/ops.js');
  const proto = parseTdd(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'reference', 't07-synergy3.tdd'), 'utf8'));
  const ref = proto.plates.at(-1);
  const ax = (id, n, low, order) => ({ fluidId: id, includeZero: true, order,
    levels: synergyLevels({ mode: 'highLow', high: 10, low, levels: n, distribution: 'log', includeZero: true }) });
  const [mine] = buildSynergy({ type: 'ABC', layout: 'multiple', gridOrder: 'cols', plate: { plateType: 'Default384', assayVolume: 50000, dmsoLimit: 0.01 },
    fluids: [ax(0, 4, 0.1, 'highFirst'), ax(2, 4, 0.1, 'lowFirst'), ax(1, 3, 1, 'lowFirst')] });
  assert.equal(mine.wells.size, ref.wells.size);
  for (const [k, m] of ref.wells) {
    assert.deepEqual([...mine.wells.get(k).keys()], [...m.keys()], `fluid order in well ${k}`);
    for (const [id, v] of m) close(mine.wells.get(k).get(id), v, 1e-12, `well ${k} fluid ${id}`);
  }
});

test('targeted titration reproduces D300e Control (T11)', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { parseTdd } = await import('../src/tdd.js');
  const { targetedLevels } = await import('../src/ops.js');
  const ref = parseTdd(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'reference', 't11-targeted.tdd'), 'utf8')).plates.at(-1);
  const lv = targetedLevels({ high: 10, low: 0.003, levels: 16, target: 0.5, region: 8, range: 0.25 });
  const p = newPlate({ plateType: 'Default384' });
  applyTitration(p, Array.from({ length: 16 }, (_, r) => [r, 9]), 0, lv, { pattern: 'colsTL' });
  for (let r = 0; r < 16; r++) close(p.wells.get(`${r},9`).get(0), ref.wells.get(`${r},9`).get(0), 1e-12, `row ${r}`);
});

test('copy/paste carries normalization groups (guide §3.9)', async () => {
  const { copyNormalization, pasteNormalization, newPlate, addNormalization } = await import('../src/ops.js');
  const p = { fluids: [], plates: [newPlate(), newPlate()], backfills: [] };
  addNormalization(p, 0, 'ToMaxVolume', undefined, [{ p: 0, r: 1, c: 1 }, { p: 0, r: 1, c: 2 }]);
  addNormalization(p, 0, 'ToAssayVolumePct', 0.01, [{ p: 1, r: 5, c: 5 }]);
  const cells = [[1, 1], [1, 2], [1, 3]];
  const groups = copyNormalization(p, 0, cells);
  assert.deepEqual(groups, [[0], [0], []]);
  const clip = cells.map(([r, c], i) => ({ dr: r - 1, dc: c - 1, groups: groups[i] }));
  pasteNormalization(p, 1, clip, 5, 4, 16, 24); // (5,4),(5,5),(5,6): (5,5) leaves the % group
  assert.deepEqual(p.backfills.map((b) => b.wells.map((w) => `${w.p}:${w.r},${w.c}`)), [['0:1,1', '0:1,2', '1:5,4', '1:5,5']]);
});

test('parseDilution reads the usual ways of writing a dilution step', async () => {
  const { parseDilution } = await import('../src/ops.js');
  const f = (s) => +parseDilution(s).factor.toPrecision(6);
  assert.equal(f('3'), 3); assert.equal(f('1:3'), 3); assert.equal(f('÷2'), 2); assert.equal(f('/2'), 2);
  assert.equal(f('1.5'), 1.5); assert.equal(f('1:1.5'), 1.5); assert.equal(f('1:1,4'), 1.4);
  assert.equal(f('2/3'), 1.5); assert.equal(f('×0.5'), 2); assert.equal(f('x2/3'), 1.5);
  assert.equal(f('-33%'), +(1 / 0.67).toPrecision(6)); assert.equal(f('1:0.33'), +(1 / 0.67).toPrecision(6)); // 10 → 6.7
  assert.equal(f('1:0.333333'), +(1 / (1 - 0.333333)).toPrecision(6));
  for (const bad of ['', '1', '0', 'abc', '1:1', '×2', '120%']) assert.throws(() => parseDilution(bad), /dilution|decrease|Multiply|Enter/, bad);
});
