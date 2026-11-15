import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeWell, roundVolume, FLUID_CLASSES, validRange, computeProtocol } from '../src/dispense.js';
import { parseTdd } from '../src/tdd.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const dmsoFluid = (S, id = 0) => ({ id, name: 'F', byVol: false, concentration: S, classId: 0 });

// Guide p.89 Tabular Detail report (values read from a 300 dpi render of the figure, row A): A = 100 µL, Fluid 1 = 10 mM in DMSO.
// [requested µM, reported volume nL, reported concentration µM]
// tol = half a unit in the last digit shown in the report.
const P89 = [[50, 502.4, 49.98885599, 5e-9], [10, 100, 9.99000999, 5e-9], [2.511886, 25.2, 2.51936512, 5e-9],
  [0.6309573, 6.4, 0.639959043, 5e-10], [0.1584893, 1.58, 0.157997504, 5e-10], [0.03981072, 0.4, 0.03999984, 5e-9],
  [0.01, 0.1, 0.00999999, 5e-9], [0.0013, 0.013, 0.0013, 5e-5]];

test('guide p.89 report example: volumes and dispensed concentrations', () => {
  const plate = { assayVolume: 100000, dmsoLimit: 0.01 };
  const fluids = new Map([[0, dmsoFluid(10000)]]);
  for (const [c, vol, disp, tol] of P89) {
    const r = computeWell(new Map([[0, c]]), fluids, plate);
    close(r.fluids[0].volume, vol, 1e-9, `volume for ${c} µM`);
    close(r.fluids[0].dispensed, disp, tol, `dispensed conc for ${c} µM`);
  }
});

test('guide p.89 multi-fluid wells: total volume includes all dispensed fluids', () => {
  const plate = { assayVolume: 100000, dmsoLimit: 0.02 };
  const fluids = new Map([[1, dmsoFluid(10000, 1)], [2, dmsoFluid(10000, 2)], [3, dmsoFluid(10000, 3)]]);
  // A09: two fluids at 50 µM -> 505.2 nL each, total 101010.4, 50.01465196 µM
  let r = computeWell(new Map([[1, 50], [2, 50]]), fluids, plate);
  for (const x of r.fluids) { close(x.volume, 505.2, 1e-9, 'A09 volume'); close(x.dispensed, 50.01465196, 5e-9, 'A09 conc'); }
  close(r.totalVolume, 101010.4, 1e-6, 'A09 total');
  // A08: 50 µM + 0.0013 µM -> 502.4 + 0.013 nL, total 100502.413, 49.98884952 µM
  r = computeWell(new Map([[1, 50], [2, 0.0013]]), fluids, plate);
  close(r.totalVolume, 100502.413, 1e-6, 'A08 total');
  close(r.fluids[0].dispensed, 49.98884952, 5e-9, 'A08 conc');
  close(r.fluids[1].dispensed, 0.001293501, 5e-10, 'A08 low conc');
});

test('guide valid-range screenshots (p.23-29)', () => {
  const r = (S, A) => validRange(dmsoFluid(S), { assayVolume: A, dmsoLimit: 0.01 });
  close(r(10000, 200000).min, 0.00065, 1e-6, '10 mM, 200 µL min');
  close(r(5000, 200000).min, 0.000325, 1e-6, '5 mM, 200 µL min');
  close(r(10000, 100000).min, 0.0013, 1e-6, '10 mM, 100 µL min');
  close(r(10000, 50000).min, 0.0026, 1e-6, '10 mM, 50 µL min');
  close(r(10000, 200000).max, 100, 1e-9, '10 mM max at 1 %');
  close(r(5000, 200000).max, 50, 1e-9, '5 mM max at 1 %');
});

test('guide p.30 tooltip: 1 µM of 1.25 mM in 200 µL = 160 nL, DMSO 0.0799 %', () => {
  const r = computeWell(new Map([[0, 1]]), new Map([[0, dmsoFluid(1250)]]), { assayVolume: 200000, dmsoLimit: 0.01 });
  close(r.fluids[0].volume, 160, 1e-9, 'volume');
  close(r.dmsoFraction * 100, 0.0799, 5e-5, 'DMSO %');
  close(r.totalVolume, 200160, 1e-6, 'total');
});

test('DMSO rounding bands', () => {
  const c = FLUID_CLASSES[0];
  for (const [v, want] of [[0.013, 0.013], [0.016, 0.013], [0.018, 0.02], [1.585, 1.58], [3.59, 3.6], [6.31, 6.4], [502.51, 502.4]])
    close(roundVolume(v, c).volume, want, 1e-12, `round ${v}`);
  assert.equal(roundVolume(0.005, c).belowMin, true);
});

test('DMSO limit warning fires above the plate limit', () => {
  const plate = { assayVolume: 50000, dmsoLimit: 0.01 };
  const fl = new Map([[0, dmsoFluid(1000)]]);
  assert.ok(!computeWell(new Map([[0, 9]]), fl, plate).warnings.some((w) => w.code === 'dmso_limit'));
  assert.ok(computeWell(new Map([[0, 11]]), fl, plate).warnings.some((w) => w.code === 'dmso_limit'));
});

test('guide p.89 row B: ToMaxVolume normalization volumes and totals', () => {
  // Row B, Fluid 2 = 10 mM DMSO, A = 100 µL; B01 holds the class maximum (100 nL).
  // [well col, requested µM, fluid nL, normalization nL, total nL]
  const rows = [[0, 10, 100, 0, 100100], [2, 0.6309573, 6.4, 93.6, 100100], [3, 0.1584893, 1.58, 98.4, 100099.98],
    [4, 0.03981072, 0.4, 99.6, 100100],
    // B06: the guide figure (older software) shows 100 nL (nearest step); D300e Control 4.0.1 rounds the
    // top-up DOWN (see the D3 run-report test), giving 99.6 nL. We follow 4.0.1.
    [5, 0.01, 0.1, 99.6, 100099.7]];
  const plate = { assayVolume: 100000, dmsoLimit: 0.01, wells: new Map(rows.map(([c, conc]) => [`1,${c}`, new Map([[2, conc]])])) };
  const protocol = { fluids: [{ id: 2, byVol: false, concentration: 10000, classId: 0 }], plates: [plate],
    backfills: [{ classId: 0, type: 'ToMaxVolume', wells: rows.map(([c]) => ({ p: 0, r: 1, c })) }] };
  const res = computeProtocol(protocol)[0].wells;
  for (const [c, , vol, norm, total] of rows) {
    const r = res.get(`1,${c}`);
    close(r.fluids[0].volume, vol, 1e-9, `B${c + 1} fluid volume`);
    close(r.normalization, norm, 1e-9, `B${c + 1} normalization`);
    close(r.totalVolume, total, 1e-6, `B${c + 1} total`);
  }
  close(res.get('1,3').fluids[0].dispensed, 0.157842189, 1e-8, 'B04 dispensed conc');
});

test('D300e Control 4.0.1 run report: every dispense of the D3 protocol is reproduced', async () => {
  // 5,752 dispense rows (all fluids + normalization, 9 plates): volume, total well volume and dispensed
  // concentration must all match. tools/compare/compare_report.py does the comparison.
  const { execFileSync } = await import('node:child_process');
  const root = join(import.meta.dirname, '..');
  const out = execFileSync('python3', ['-I', 'tools/compare/compare_report.py',
    'fixtures/reference/2026.08.28 synergy D3.tdd', 'fixtures/reference/reports/2026.08.28 synergy D3.xml'], { cwd: root, encoding: 'utf8' });
  assert.match(out, /'rows': 5752, 'vol_ok': 5752, 'total_ok': 5752, 'conc_ok': 5752/, out.split('\n')[0]);
  assert.match(out, /ALL ROWS MATCH/);
});

test('DMSO limit: normalizing to exactly the limit is not flagged; a real excess is', () => {
  const fl = new Map([[0, dmsoFluid(1000)]]);
  const plate = { assayVolume: 50000, dmsoLimit: 0.01 };
  // 505.2 nL normalization -> 505.2 / 50505.2 = 1.00029 % (rounds to 1.000 %)
  assert.ok(!computeWell(new Map(), fl, plate, 505.2).warnings.some((w) => w.code === 'dmso_limit'));
  // 0.505 µM -> 25.6 nL + 485 nL normalization would be 1.01 %
  assert.ok(computeWell(new Map([[0, 10.2]]), fl, plate).warnings.some((w) => w.code === 'dmso_limit'));
});

test('priming: fluids below 30 nL on a plate are flagged; scrap well values reach ≥ 30 nL', async () => {
  const { primingIssues, scrapWellValues, PRIMING_VOLUME } = await import('../src/dispense.js');
  const fluids = [{ id: 0, byVol: false, concentration: 1000, classId: 0 }, { id: 1, byVol: false, concentration: 10000, classId: 0 }];
  const plate = { assayVolume: 50000, dmsoLimit: 0.01, wells: new Map([['1,1', new Map([[0, 0.02], [1, 3]])]]) };
  const protocol = { fluids, plates: [plate], backfills: [] };
  const issues = primingIssues(protocol, computeProtocol(protocol))[0].lacking.map((x) => x.fluidId).sort();
  assert.deepEqual(issues, [0, 1]); // 1 nL and 15 nL
  const vals = scrapWellValues(fluids, plate);
  const r = computeWell(new Map(vals), new Map(fluids.map((f) => [f.id, f])), plate);
  for (const x of r.fluids) assert.ok(x.volume >= PRIMING_VOLUME, `${x.fluidId}: ${x.volume}`);
  // the reference D3 file's scrap wells (A23 Bortezomib 0.6 µM, A24 MEN 6 µM) satisfy the rule
  const d3 = parseTdd(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'reference', '2026.08.28 synergy D3.tdd'), 'utf8'));
  const lack = primingIssues(d3, computeProtocol(d3)).flatMap((x) => x.lacking);
  assert.deepEqual(lack, []);
});

test('T05 (D300e Control): all five normalization types reproduce the software totals', () => {
  const p = parseTdd(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'reference', 't05-normalize.tdd'), 'utf8'));
  assert.deepEqual(p.backfills.map((b) => b.type), ['ToMaxVolume', 'ToVolume', 'ToAssayVolumePct', 'ToMaxTotalVolume', 'ToTotalVolume']);
  const res = computeProtocol(p)[0].wells;
  const sumRow = (r) => [...Array(24).keys()].reduce((s, c) => s + (res.get(`${r},${c}`)?.normalization || 0), 0) / 1000;
  // Normalization panel showed DMSO 11.4 µL after row A, 16.2 after B, 22.3 after C, 29.5 after D+E.
  const a = sumRow(0), b = sumRow(1), c = sumRow(2), d = sumRow(3), e = sumRow(4);
  close(a, 11.4, 0.05, 'row A'); close(a + b, 16.2, 0.05, 'rows A-B'); close(a + b + c, 22.3, 0.05, 'rows A-C');
  close(a + b + c + d + e, 29.5, 0.05, 'rows A-E');
  assert.equal(d, 0); close(e, 7.2, 1e-9, 'row E: 300 nL x 24');
});
