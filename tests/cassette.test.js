// Cassette / dispense-head / load-volume plan vs. what D300e Control 4.0.1 showed in simulated runs
// (fill screens and run reports, 2026-11-15; protocols in fixtures/reference/probes, reports in
// fixtures/reference/reports/probes) and the D3 run report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTdd } from '../src/tdd.js';
import { computeProtocol } from '../src/dispense.js';
import { planRun, headLoad, T8, D4 } from '../src/cassette.js';

const root = join(import.meta.dirname, '..');
const plan = (rel) => { const p = parseTdd(readFileSync(join(root, rel), 'utf8')); return planRun(p, computeProtocol(p)); };
const heads = (r) => r.cassettes.map((c) => [c.type, c.heads.map((h) => `${h.name} ${h.load}`)]);

test('probe-1: single heads, 2 µL minimum, 1.15·d + 0.3', () => {
  const r = plan('fixtures/reference/probes/probe-1-small.tdd');
  assert.deepEqual(r.fluids.map((f) => f.load), [2.0, 2.0, 2.1, 2.4, 2.8, 3.7, 7.2, 14.1]);
  assert.equal(r.cassettes.length, 1);
});

test('probe-2: > 20 µL splits equally, heads continue on a second T8+ cassette', () => {
  assert.deepEqual(heads(plan('fixtures/reference/probes/probe-2-split.tdd')), [
    ['T8+', ['m1 16.4', 'm2 18.7', 'm3 21', 'm4 22.1', 'm5 23.3', 'm6 12.4', 'm6 12.4', 'm7 13.5']],
    ['T8+', ['m7 13.5', 'm8 15.2', 'm8 15.2']]]);
});

test('probe-3: whole plates per head when they fit, else equal split; heads ordered by first plate', () => {
  assert.deepEqual(heads(plan('fixtures/reference/probes/probe-3-plates.tdd')), [
    ['T8+', ['p1 10.6', 'p2 17.5', 'p3 18.7', 'p4 19.3', 'p4 19.3', 'p3 9.5']]]);
});

test('probe-4: aqueous classes have 2.5 µL dead volume and a 4 µL minimum', () => {
  assert.deepEqual(plan('fixtures/reference/probes/probe-4-classes.tdd').fluids.map((f) => f.load), [4.0, 16.3, 4.0, 16.3, 25.5, 8.2, 8.2, 6.0]);
});

test('probe-5/6/7: normalization on T8+ up to 40 µL, then D4+ (1.25·d + 15, 200 µL per head)', () => {
  assert.deepEqual(heads(plan('fixtures/reference/probes/probe-5-norm40.tdd')), [['T8+', ['n1 2', 'DMSO normalization 23.3', 'DMSO normalization 23.3']]]);
  assert.deepEqual(heads(plan('fixtures/reference/probes/probe-6-norm120.tdd')), [['T8+', ['n1 2']], ['D4+', ['DMSO normalization 165']]]);
  assert.deepEqual(heads(plan('fixtures/reference/probes/probe-7-norm300.tdd')), [['T8+', ['n1 2']], ['D4+', ['DMSO normalization 203', 'DMSO normalization 203']]]);
});

test('probe-8: ten fluids need two T8+ cassettes', () => {
  const r = plan('fixtures/reference/probes/probe-8-tenfluids.tdd');
  assert.deepEqual(r.fluids.map((f) => f.load), [2.0, 2.6, 3.7, 4.9, 6.0, 7.2, 8.3, 9.5, 10.6, 11.8]);
  assert.deepEqual(r.cassettes.map((c) => c.heads.length), [8, 2]);
});

test('probe-9: 40 µL stays on two T8+ heads, 60 and 90 µL go to D4+', () => {
  const r = plan('fixtures/reference/probes/probe-9-big.tdd');
  assert.deepEqual(heads(r), [['T8+', ['b1 23.3', 'b1 23.3']], ['D4+', ['b2 90', 'b3 128']]]);
});

test('probe-10: boundaries (20 µL T8+ cap, D4+ cap 200, remainder ≤ 40 µL to T8+)', () => {
  assert.deepEqual(heads(plan('fixtures/reference/probes/probe-10-bounds.tdd')), [
    ['T8+', ['x1 12', 'x1 12', 'x2 12.3', 'x2 12.3', 'x6 23.3', 'x8 14.6', 'x8 14.6', 'x9 19.7']],
    ['T8+', ['x9 19.7']],
    ['D4+', ['x3 66', 'x4 70', 'x5 265', 'x6 241']],
    ['D4+', ['x7 171', 'x7 171']]]);
});

test('probe-11: next-fit plate packing (15 | 10+5), D4+ with a T8+ remainder head', () => {
  assert.deepEqual(heads(plan('fixtures/reference/probes/probe-11-packing.tdd')), [
    ['T8+', ['k1 17.5', 'k2 23.3', 'k4 21', 'k1 17.5', 'k4 21']],
    ['D4+', ['k2 252', 'k3 184']]]);
});

test('D3 run report: fluid heads and loads (normalization excluded: that run used a modified protocol)', () => {
  const r = plan('fixtures/reference/2026.08.28 synergy D3.tdd');
  assert.deepEqual(r.cassettes[0].heads.map((h) => `${h.name} ${h.load}`),
    ['Bortezomib 2', 'MEN 4.9', 'IDOTDO 20.3', 'IDOTDO 10.3', 'Kynurenin 19.2', 'Kynurenin 19.2']);
});

test('headLoad rounding', () => {
  assert.equal(headLoad(T8, 10.2), 12.0);
  assert.equal(headLoad(D4, 135), 184);
  assert.equal(headLoad(T8, 1, false), 4.0);
});

test('D3 run: normalization on D4+ packs whole plates largest first (head 1 = 265 µL)', () => {
  // The real D3 run loaded 265 µL into D4+ head 1 = 1.25 × 199.785 + 15: plates 9, 6, 5 (144.5 + 2 × 22.4 µL)
  // and 3, 2, 1 (3 × 3.5 µL); it dispensed plates 1, 2 and 9 (151.5 µL) before the run was aborted.
  // Heads 2 and 3 were filled but have no loaded volume in the report (aborted), so only head 1 is checked.
  const r = plan('fixtures/reference/2026.08.28 synergy D3.tdd');
  const d4 = r.cassettes.find((c) => c.type === 'D4+');
  assert.equal(d4.heads[0].load, 265);
  assert.deepEqual(d4.heads[0].plates, [0, 1, 2, 4, 5, 8]);
  assert.deepEqual(d4.heads.map((h) => h.load), [265, 224, 196]);
});

test('probe-13: D4+ largest-first packing, remainder > 20 µL on D4+, aqueous on D4+, cassette order by run', () => {
  assert.deepEqual(heads(plan('fixtures/reference/probes/probe-13-packing2.tdd')), [
    ['T8+', ['q1 19.8', 'q1 19.8']],
    ['D4+', ['q2 190', 'q4 159', 'q4 159', 'q5 140']],
    ['D4+', ['q3 240', 'q2 265', 'q3 140']]]);
});

test('probe-15: when fluid 1 is on a D4+ head, the D4+ cassette is loaded first', () => {
  assert.deepEqual(heads(plan('fixtures/reference/probes/probe-15-dmsorule.tdd')), [['D4+', ['d1 78']], ['T8+', ['d2 2']]]);
});
