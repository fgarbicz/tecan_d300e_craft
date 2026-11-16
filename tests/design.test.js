// The programmable front door (src/design.js, bin/d300craft): a JSON spec must give exactly what the
// experiment wizard / a hand-made protocol gives, and a plan with the D300e run numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseTdd, writeTdd } from '../src/tdd.js';
import { designExperiment, makePlan, planMarkdown, parseAmount, designAndPlan } from '../src/design.js';

const root = join(import.meta.dirname, '..');
const D3 = parseTdd(readFileSync(join(root, 'fixtures/reference/2026.08.28 synergy D3.tdd'), 'utf8'));
const D3_SPEC = {
  name: 'D3',
  plate: { type: 384, wellVolumeUL: 50, dmsoLimitPct: 1, border: 1, replicates: 3, scrap: true, shake: true },
  drugs: [{ name: 'Bortezomib', stock: '1 mM' }, { name: 'MEN', stock: '10 mM' }, { name: 'IDOTDO', stock: '5 mM' }, { name: 'Kynurenin', stock: '20 mM' }],
  design: {
    primary: { drug: 'Bortezomib', top: '0.02 µM', dilution: '1:1.4', levels: 10, replicates: 2, zero: true },
    partners: [
      { drug: 'MEN', top: '3 µM', dilution: '1:2', levels: 6, replicates: 2, normalize: 'block' },
      { drug: 'IDOTDO', top: '10 µM', dilution: '1:2', levels: 6, replicates: 2, normalize: 'block' },
      { drug: 'Kynurenin', top: '50 uM', dilution: '2', levels: 6, replicates: 2, normalize: 'plate' },
    ],
  },
  cells: { lines: ['MM.1S'], cellsPerWell: 2000, seedingVolumeUL: 50 },
};
const wellsOf = (p) => p.plates.map((pl) => [...pl.wells].map(([k, m]) => [k, [...m]]).sort());

test('a JSON spec rebuilds the hand-made D3 protocol: same wells, values, fluid order and normalization', () => {
  // compared as written to disk (13 significant digits, as D300e stores them)
  const protocol = parseTdd(writeTdd(designExperiment(D3_SPEC).protocol));
  assert.deepEqual(protocol.fluids.map((f) => [f.name, f.concentration]), D3.fluids.map((f) => [f.name, f.concentration]));
  assert.deepEqual(wellsOf(protocol), wellsOf(D3));
  assert.deepEqual(protocol.backfills.map((b) => [b.type, b.param ?? null, b.wells]), D3.backfills.map((b) => [b.type, b.param ?? null, b.wells]));
});

test('plan: D300e head loads, seeding and PBS for D3', () => {
  const { protocol, meta } = designExperiment(D3_SPEC);
  const plan = makePlan(protocol, meta, D3_SPEC);
  assert.deepEqual(plan.cassettes[0].heads.map((h) => `${h.fluid} ${h.loadUL}`), ['Bortezomib 2', 'MEN 4.9', 'IDOTDO 20.3', 'IDOTDO 10.3', 'Kynurenin 19.2', 'Kynurenin 19.2']);
  assert.equal(plan.cassettes[1].heads[0].loadUL, 265); // as the real D3 run
  assert.equal(plan.seeding[0].wells, 9 * 14 * 22);
  assert.equal(plan.seeding[0].cellsPerML, 40000);
  assert.equal(plan.pbs.wells, 9 * (2 * 24 + 2 * 14) - 9 * 0 - 12); // border minus scrap wells (2 on plates 1-3, 1 on 4-9)
  assert.deepEqual(plan.warnings, []);
  const md = planMarkdown(plan);
  assert.match(md, /\| Bortezomib \| 1 mM \|/);
  assert.match(md, /Cassette 2 · D4\+/);
});

test('spec errors are clear', () => {
  assert.throws(() => parseAmount('10 mMol'), /Unknown unit/);
  assert.throws(() => designExperiment({ ...D3_SPEC, design: { ...D3_SPEC.design, partners: [{ drug: 'X', top: '1 µM' }] } }), /"X" is used in the design but not listed/);
  assert.throws(() => designExperiment({ ...D3_SPEC, cells: { lines: ['A', 'B'] } }), /use "perLine", "splitRows" or "splitCols"/);
  assert.equal(parseAmount('0,5 µg/ml').unit, 'µg_mL');
});

test('two cell lines per plate and one plate set per line', () => {
  const spec = { ...D3_SPEC, design: { ...D3_SPEC.design, partners: [{ drug: 'MEN', top: '3 µM', dilution: '1:2', levels: 6, replicates: 1 }] } };
  const split = makePlan(...Object.values(designExperiment({ ...spec, cells: { lines: ['A', 'B'], arrangement: 'splitRows', cellsPerWell: 1000 } })).slice(0, 2), spec);
  assert.equal(split.plates.length, 3);
  assert.deepEqual(split.seeding.map((s) => [s.cellLine, s.wells]), [['A', 3 * 7 * 22], ['B', 3 * 7 * 22]]);
  const per = makePlan(...Object.values(designExperiment({ ...spec, cells: { lines: ['A', 'B', 'C'], arrangement: 'perLine' } })).slice(0, 2), spec);
  assert.equal(per.plates.length, 9);
  assert.deepEqual(per.seeding.map((s) => s.plates), [[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
});

test('CLI: design writes .tdd + .craft.json + plan; the .tdd re-opens; check reports warnings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'd300craft-'));
  const specPath = join(dir, 'spec.json');
  writeFileSync(specPath, JSON.stringify(D3_SPEC));
  const md = execFileSync(join(root, 'bin/d300craft'), ['design', specPath, '--out', dir], { encoding: 'utf8' });
  assert.match(md, /# D3 — plan/);
  for (const f of ['D3.tdd', 'D3.craft.json', 'D3_plan.md', 'D3_plan.json']) assert.ok(existsSync(join(dir, f)), f);
  const again = parseTdd(readFileSync(join(dir, 'D3.tdd'), 'utf8'));
  assert.deepEqual(wellsOf(again), wellsOf(D3));
  const plan = JSON.parse(execFileSync(join(root, 'bin/d300craft'), ['plan', join(dir, 'D3.tdd'), '--json'], { encoding: 'utf8' }));
  assert.equal(plan.seeding[0].cellLine, 'MM.1S'); // the experiment file was picked up
  // an over-limit design fails check with exit status 1
  const bad = { ...D3_SPEC, name: 'bad', design: { ...D3_SPEC.design, partners: [{ drug: 'MEN', top: '200 µM', dilution: '1:2', levels: 6 }] } };
  writeFileSync(specPath, JSON.stringify(bad));
  execFileSync(join(root, 'bin/d300craft'), ['design', specPath, '--out', dir], { encoding: 'utf8' });
  assert.throws(() => execFileSync(join(root, 'bin/d300craft'), ['check', join(dir, 'bad.tdd')], { encoding: 'utf8' }), (e) => e.status === 1 && /dmso_limit/.test(e.stdout));
});

test('QA fixes: no stale note right after design; priming wells excluded from the DMSO headline; cells only on grids', () => {
  const spec = { name: 'small', plate: { type: 384, wellVolumeUL: 40, replicates: 1 },
    drugs: [{ name: 'A', stock: '1 mM', mw: 400 }, { name: 'B', stock: '10 mM' }],
    design: { primary: { drug: 'A', top: '20 nM', dilution: '1:1.5', levels: 8, replicates: 1 }, partners: [{ drug: 'B', top: '1 µM', dilution: '1:2', levels: 5, replicates: 1 }] },
    cells: { lines: ['X', 'Y'], arrangement: 'splitRows', cellsPerWell: 1500, seedingVolumeUL: 40 } };
  const dir = mkdtempSync(join(tmpdir(), 'd300craft-'));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec));
  execFileSync(join(root, 'bin/d300craft'), ['design', join(dir, 'spec.json'), '--out', dir], { encoding: 'utf8' });
  const r = spawnSync(join(root, 'bin/d300craft'), ['check', join(dir, 'small.tdd')], { encoding: 'utf8' });
  assert.equal(r.stderr, '', 'no stale-fingerprint note');
  const plan = JSON.parse(readFileSync(join(dir, 'small_plan.json'), 'utf8'));
  assert.ok(plan.maxDmsoScrapPct > plan.maxDmsoPct, 'scrap wells reported separately');
  assert.deepEqual(plan.seeding.map((s) => s.wells), [6 * 9, 6 * 9]); // grid only, not the whole half
  assert.equal(plan.unusedInnerWells, 14 * 22 - 2 * 6 * 9);
  assert.equal(plan.seeding[0].totalCells, Math.round(plan.seeding[0].cellsPerML * plan.seeding[0].suspensionML));
  assert.equal(plan.prepare.find((d) => d.name === 'A').massMg, 0.4); // 1 mM × 1 mL × 400 g/mol
});
