// Per-drug display units and the drawings (cassettes / heads, dose strips, plates).
import test from 'node:test';
import assert from 'node:assert/strict';
import { designExperiment, designAndPlan, planMarkdown } from '../src/design.js';
import { drugUnit, setDrugUnit, unitsFor, niceUnit } from '../src/units.js';
import { analyze } from '../src/analysis.js';
import { doseLevels } from '../src/dosemap.js';
import { computeProtocol } from '../src/dispense.js';
import { planRun } from '../src/cassette.js';
import { parseMeta, serializeMeta } from '../src/experiment.js';
import { parseTdd, writeTdd } from '../src/tdd.js';
import { cassetteSvg, levelStripSvg, plateSvg, plateStackSvg, fluidLook, standalone, shortNum } from '../src/draw.js';
import { parseXml as parseDoc } from '../src/xmltree.js';
const parseXml = (svg) => parseDoc('<?xml version="1.0"?>' + svg); // throws when malformed

const spec = (unit) => ({
  name: 'u', plate: { type: '384', wellVolumeUL: 50, replicates: 1 },
  drugs: [{ name: 'Bortezomib', stock: '10 mM', ...(unit ? { unit } : {}) }, { name: 'MEN', stock: '10 mM' }],
  design: { primary: { drug: 'Bortezomib', top: '10 µM', bottom: '0.1 nM', levels: 10, replicates: 2 }, partners: [{ drug: 'MEN', top: '3 µM', dilution: '1:2', levels: 6, replicates: 2 }] },
  cells: { lines: ['MM.1S'] },
});

test('dose unit per drug: default µM, chosen unit kept in the experiment file, diluted stock follows its drug', () => {
  const { protocol, meta } = designExperiment(spec('nM'));
  const b = protocol.fluids.find((f) => f.name === 'Bortezomib'), d = protocol.fluids.find((f) => f.name === 'Bortezomib - 1:30'), m = protocol.fluids.find((f) => f.name === 'MEN');
  assert.equal(drugUnit(meta, protocol, b), 'nM'); assert.equal(drugUnit(meta, protocol, d), 'nM'); assert.equal(drugUnit(meta, protocol, m), 'µM');
  // the .tdd is untouched by the choice: same bytes as without a unit
  assert.equal(writeTdd(protocol), writeTdd(designExperiment(spec()).protocol));
  // survives the sidecar round-trip
  const tdd = writeTdd(protocol), back = parseMeta(serializeMeta(meta, parseTdd(tdd), 'u.tdd'), parseTdd(tdd)).meta;
  assert.equal(drugUnit(back, protocol, b), 'nM');
  setDrugUnit(meta, protocol, b, 'µM'); assert.equal(meta.drugUnits[b.id], undefined); // back to the default: no entry
  assert.throws(() => setDrugUnit(meta, protocol, b, 'ng_mL'), /not a unit/);
  assert.deepEqual(unitsFor(b), ['M', 'mM', 'µM', 'nM', 'pM']);
  assert.throws(() => designExperiment(spec('mg/mL')), /cannot be used for Bortezomib/);
  assert.equal(niceUnit(0.0005), 'nM'); assert.equal(niceUnit(3), 'µM'); assert.equal(niceUnit(2500), 'mM');
});

test('plan, dose levels and analysis report a drug in its unit', () => {
  const { protocol, meta, plan } = designAndPlan(spec('nM'));
  const blk = plan.blocks[0];
  assert.equal(blk.primaryUnit, 'nM'); assert.equal(blk.partnerUnit, 'µM');
  assert.equal(blk.primaryLevels[0], 10000); assert.ok(Math.abs(blk.primaryLevels[9] - 0.1) < 1e-9);
  assert.match(planMarkdown(plan), /Bortezomib along the columns 10000, .* 0\.1, 0 nM; MEN along the rows 3, .* 0 µM/);
  const dl = doseLevels(protocol, { unitOf: (f) => drugUnit(meta, protocol, f) });
  assert.equal(dl[0].unit, 'nM'); assert.equal(dl[0].max, 10000); assert.equal(dl[1].unit, 'µM'); assert.equal(dl[1].max, 3);
  const p = protocol.plates[0];
  meta.plates[0].readout = { values: Array.from({ length: p.rows }, () => Array(p.cols).fill(100)) };
  const res = analyze({ protocol, meta });
  assert.deepEqual(res.fluids.map((f) => f.unit), ['nM', 'µM']);
  assert.ok(res.conditions.some((c) => c.label === 'Bortezomib 10000 nM'));
  assert.ok(res.conditions.some((c) => /^Bortezomib 0\.1 nM \+ MEN 3 µM$/.test(c.label)), res.conditions.slice(-3).map((c) => c.label).join(' | '));
});

test('drawings are well-formed SVG and show every head, level and plate', () => {
  const { protocol, meta } = designExperiment(spec());
  const run = planRun(protocol, computeProtocol(protocol));
  for (const compact of [false, true]) {
    const svg = cassetteSvg(run.cassettes, (h) => fluidLook(protocol, h.fluidId), { compact, title: 'Loading' });
    parseXml(svg);
    const heads = run.cassettes.reduce((n, c) => n + c.heads.length, 0);
    assert.equal((svg.match(/<title>Head /g) || []).length, heads);
    assert.equal((svg.match(/stroke-dasharray="3 3"/g) || []).length, run.cassettes.reduce((n, c) => n + (c.type === 'D4+' ? 4 : 8) - c.heads.length, 0)); // empty heads
    assert.ok(svg.includes('<pattern'), 'the diluted stock is hatched');
    for (const c of run.cassettes) for (const h of c.heads) assert.ok(svg.includes(`${c.type === 'D4+' ? h.load : h.load.toFixed(1)} µL`));
    assert.match(svg, /viewBox="0 0 (300|520) /); assert.ok(!/ width="\d/.test(svg.slice(0, 120)), 'no fixed size: scales with its container');
  }
  const d = protocol.fluids.find((f) => f.name === 'Bortezomib - 1:30');
  assert.deepEqual(fluidLook(protocol, d.id), { color: fluidLook(protocol, d.rootFluidId).color, diluted: true, conc: '0.333 mM' });
  // the same drug at two concentrations: both are written under their heads; the top-up says what it is
  const full = cassetteSvg(run.cassettes, (h) => fluidLook(protocol, h.fluidId, h.classId === 0));
  assert.ok(full.includes('>10 mM<') && full.includes('>0.333 mM<') && full.includes('>pure DMSO<'));
  assert.equal(fluidLook(protocol, null, false).conc, 'solvent only');
  const strip = levelStripSvg([{ v: 10, kind: 'stock' }, { v: 1, kind: 'stock' }, { v: 0.001, kind: 'diluted' }, { v: 1e-5, kind: 'below' }, { v: 0, kind: 'zero' }], '#2f6fde', { unit: 'µM', replicates: 2, dilutedName: 'X - 1:30' });
  parseXml(strip); assert.ok(strip.includes('from X - 1:30')); assert.ok(strip.includes('>!<')); assert.equal((strip.match(/<circle/g) || []).length >= 5, true);
  const plate = plateSvg(protocol.plates[0], { colorOf: (id) => fluidLook(protocol, id).color, border: 1, scrap: new Set(Object.keys(meta.plates[0].roles)), regions: [{ r0: 1, c0: 1, rows: 14, cols: 22, label: 'MM.1S', color: '#e8590c' }] });
  parseXml(plate); assert.ok(plate.includes('MM.1S'));
  const stack = plateStackSvg([{ label: 'A × B', count: 3, first: 1, color: '#2f6fde' }, { label: 'A × C', count: 3, first: 4, color: '#2f6fde' }]);
  parseXml(stack); assert.equal((stack.match(/<rect /g) || []).length, 6);
  const file = standalone(cassetteSvg(run.cassettes, (h) => fluidLook(protocol, h.fluidId)));
  parseXml(file); assert.match(file, /^<svg width="720" height="\d+" /);
  assert.equal(shortNum(10000), '10000'); assert.equal(shortNum(0.359), '0.359'); assert.equal(shortNum(0.0001), '1.0e-4'); assert.equal(shortNum(0), '0');
});
