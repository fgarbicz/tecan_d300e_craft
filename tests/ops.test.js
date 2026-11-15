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
  applyTitration(p, cells, 0, [10, 1, 0.1], { replicates: 2, direction: 'rows' });
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
