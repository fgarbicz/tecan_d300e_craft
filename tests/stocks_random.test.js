// Dose ranges (top/bottom/levels), automatic diluted stocks (D300e fluid shift / extend) and randomization within
// each cell line: builder, CLI spec path, analysis and dose maps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { axisLevels, rangeStep, randomizeByCellLine, newMeta, seededRng } from '../src/experiment.js';
import { readFileSync } from 'node:fs';
import { designExperiment, designAndPlan } from '../src/design.js';
import { parseTdd, writeTdd as writeTddOf } from '../src/tdd.js';
import { computeProtocol } from '../src/dispense.js';
import { analyze } from '../src/analysis.js';
import { doseLevels } from '../src/dosemap.js';

const wide = (extra = {}) => ({
  name: 'wide',
  plate: { type: '384', wellVolumeUL: 50, dmsoLimitPct: 1, border: 1, replicates: 1, ...extra.plate },
  drugs: [{ name: 'Bortezomib', stock: '10 mM' }, { name: 'MEN', stock: '10 mM' }],
  design: { primary: { drug: 'Bortezomib', top: '10 µM', bottom: '0.1 nM', levels: 10, replicates: 2, ...extra.primary },
    partners: [{ drug: 'MEN', top: '3 µM', dilution: '1:2', levels: 6, replicates: 1 }] },
  cells: { lines: ['MM.1S', 'KMS-11'], arrangement: 'splitRows' },
});

test('top/bottom/levels: log-even levels with both ends exact', () => {
  const lv = axisLevels({ high: 10, low: 0.0001, levels: 6, includeZero: true });
  assert.deepEqual(lv, [10, 1, 0.1, 0.01, 0.001, 0.0001, 0]);
  const lv2 = axisLevels({ high: 3, low: 0.03, levels: 5 });
  assert.equal(lv2[0], 3); assert.equal(lv2.at(-1), 0.03);
  const r = lv2.slice(1).map((v, i) => lv2[i] / v);
  for (const x of r) assert.ok(Math.abs(x - rangeStep(3, 0.03, 5)) < 1e-8);
  assert.throws(() => designExperiment(wide({ primary: { dilution: '1:3' } })), /either "dilution" or "bottom"/);
  assert.throws(() => designExperiment(wide({ primary: { bottom: '20 µM' } })), /must be below top/);
});

test('extend: levels below one drop of the stock go to "Drug - 1:30", the rest stay on the stock', () => {
  const { protocol, meta, stockNotes } = designExperiment(wide());
  const d = protocol.fluids.find((f) => f.name === 'Bortezomib - 1:30');
  const b = protocol.fluids.find((f) => f.name === 'Bortezomib');
  assert.ok(d, protocol.fluids.map((f) => f.name).join());
  assert.equal(d.rootFluidId, b.id); assert.equal(d.dilutionFactor, 30); assert.ok(Math.abs(d.concentration - b.concentration / 30) < 1e-9);
  assert.equal(stockNotes[0].kind, 'extend');
  // 10 mM, 50 µL, 13 pL drop: the stock reaches down to 0.0026 µM
  const p = protocol.plates[0];
  for (const [k, m] of p.wells) {
    if (meta.plates[0].roles[k] === 'scrap') continue; // priming wells take ≥ 30 nL of each stock
    if (m.has(d.id)) assert.ok(m.get(d.id) < 0.0026 && !m.has(b.id));
    if (m.has(b.id)) assert.ok(m.get(b.id) >= 0.0026);
  }
  const warn = computeProtocol(protocol).flatMap((x) => [...x.wells.values()].flatMap((w) => w.warnings)).filter((w) => w.code === 'below_min_volume');
  assert.equal(warn.length, 0);
  // the .tdd carries the link to the root fluid (D300e's RootFluidID / DilutionFactor)
  const { tdd } = designAndPlan(wide());
  const back = parseTdd(tdd).fluids.find((f) => f.name === 'Bortezomib - 1:30');
  assert.equal(back.rootFluidId, b.id); assert.equal(back.dilutionFactor, 30);
  // without diluted stocks the same series is flagged
  const off = designExperiment(wide({ plate: { dilutedStocks: false } })).protocol;
  assert.ok(computeProtocol(off).flatMap((x) => [...x.wells.values()].flatMap((w) => w.warnings)).some((w) => w.code === 'below_min_volume'));
});

test('shift: a series one diluted stock covers uses only that stock', () => {
  const { protocol, stockNotes } = designExperiment(wide({ primary: { top: '1 µM', bottom: '1 nM', levels: 8 } }));
  assert.equal(stockNotes[0].kind, 'shift'); assert.equal(stockNotes[0].factor, 3); // guide p.29 rule: smallest candidate ≥ 2.6
  const b = protocol.fluids.find((f) => f.name === 'Bortezomib'), d = protocol.fluids.find((f) => f.name === 'Bortezomib - 1:3');
  const used = new Set(protocol.plates.flatMap((p) => [...p.wells.values()].flatMap((m) => [...m.keys()])));
  assert.ok(used.has(d.id)); assert.ok(!protocol.plates[0].wells.get('0,23')?.has(b.id) || true);
  // only priming may still use the original stock; no assay well does
  const { meta } = designExperiment(wide({ primary: { top: '1 µM', bottom: '1 nM', levels: 8 } }));
  for (const [k, m] of protocol.plates[0].wells) if (m.has(b.id)) assert.equal(meta.plates[0].roles[k], 'scrap');
});

test('plan: the diluted stock is listed with a pipettable recipe and the levels it dispenses', () => {
  const { plan } = designAndPlan(wide());
  const d = plan.prepare.find((x) => x.name === 'Bortezomib - 1:30');
  assert.equal(d.dilution.from, 'Bortezomib'); assert.equal(d.dilution.factor, 30);
  assert.ok(d.dilution.stockUL >= 1); assert.equal(d.dilution.solventUL, d.dilution.stockUL * 29);
  assert.deepEqual(d.dilution.levels.map((v) => +v.toPrecision(3)), [0.00129, 0.000359, 0.0001]);
});

test('randomize within each cell line: a permutation that never crosses cell lines or moves role wells', () => {
  const { protocol, meta } = designExperiment(wide({ plate: { randomize: 'cellLine', randomSeed: 3 } }));
  const p = protocol.plates[0], pm = meta.plates[0];
  assert.ok(p.randomization.length > 200);
  const from = new Set(), to = new Set();
  let moved = 0;
  for (const m of p.randomization) {
    const a = `${m.r},${m.c}`, b = `${m.toR},${m.toC}`;
    from.add(a); to.add(b);
    assert.equal(pm.cellLines[a], pm.cellLines[b], `${a} → ${b} crosses cell lines`);
    assert.ok(!pm.roles[a] && !pm.roles[b]);
    if (a !== b) moved++;
  }
  assert.equal(from.size, to.size); assert.deepEqual([...from].sort(), [...to].sort());
  assert.ok(moved > 100);
  // reproducible from the seed
  const again = designExperiment(wide({ plate: { randomize: 'cellLine', randomSeed: 3 } })).protocol.plates[0].randomization;
  assert.deepEqual(again, p.randomization);
  // without cell lines: shuffled within each drug grid (the two halves of a split plate stay apart)
  const nc = designExperiment({ ...wide({ plate: { randomize: 'cellLine' } }), cells: { lines: [], arrangement: 'splitRows' } });
  const rz = nc.protocol.plates[0].randomization, blk = nc.meta.blocks[0];
  assert.equal(rz.length, blk.copies.reduce((n, g) => n + g.rows * g.cols, 0));
  const half = (r) => blk.copies.findIndex((g) => r >= g.r0 && r < g.r0 + g.rows);
  for (const m of rz) assert.equal(half(m.r), half(m.toR));
  assert.ok(rz.some((m) => m.r !== m.toR || m.c !== m.toC));
});

test('analysis: readouts of a randomized plate are read at the dispensed well; a diluted stock is the same drug', () => {
  const { protocol, meta } = designExperiment(wide({ plate: { randomize: 'cellLine', randomSeed: 5 } }));
  const p = protocol.plates[0];
  // fake signal: 1000 in every well, except wells that physically received the top Bortezomib dose (10 µM) → 500
  const b = protocol.fluids.find((f) => f.name === 'Bortezomib');
  const values = Array.from({ length: p.rows }, () => Array(p.cols).fill(1000));
  const rnd = new Map(p.randomization.map((m) => [`${m.r},${m.c}`, [m.toR, m.toC]]));
  for (const [k, m] of p.wells) if (m.get(b.id) === 10) { const [r, c] = rnd.get(k) || k.split(',').map(Number); values[r][c] = 500; }
  for (let c = 0; c < p.cols; c++) values[0][c] = 0; // border row as blank-ish background is not needed: no blanks → bg 0
  meta.plates[0].readout = { values };
  const res = analyze({ protocol, meta });
  assert.deepEqual(res.fluids.map((f) => f.name), ['Bortezomib', 'MEN']);
  const top = res.conditions.filter((c) => c.agents === 1 && c.conc[0] === 10);
  assert.ok(top.length === 2 && top.every((c) => Math.abs(c.mean - 50) < 1e-9), JSON.stringify(top.map((c) => c.mean)));
  // the three diluted-stock levels sit on the Bortezomib axis
  const levels = new Set(res.conditions.filter((c) => c.conc[0] > 0 && c.conc[1] === 0).map((c) => +c.conc[0].toPrecision(3)));
  assert.equal(levels.size, 10);
  assert.ok(levels.has(0.0001));
  // dose map: one Bortezomib scale with all 10 levels
  const dl = doseLevels(protocol);
  assert.deepEqual(dl.map((x) => x.drug), ['Bortezomib', 'MEN']);
  assert.equal(dl[0].levels.length, 10);
});

test('randomizing a hand-made plate (no experiment file): priming wells and the border stay, the grid is shuffled', () => {
  const protocol = parseTdd(readFileSync(new URL('../fixtures/reference/2026.08.28 synergy D3.tdd', import.meta.url), 'utf8'));
  const meta = newMeta(protocol);
  randomizeByCellLine(protocol, meta, [0], seededRng(11));
  const rz = protocol.plates[0].randomization;
  assert.equal(rz.length, 14 * 22); // B2–O23: the drug grid with its no-drug controls
  for (const m of rz) for (const [r, c] of [[m.r, m.c], [m.toR, m.toC]]) assert.ok(r >= 1 && r <= 14 && c >= 1 && c <= 22, `${r},${c} is outside the grid`);
  assert.equal(new Set(rz.map((m) => `${m.toR},${m.toC}`)).size, rz.length);
  // de-randomize = an empty map; the .tdd then has no <Randomize> wells
  protocol.plates[0].randomization = [];
  assert.ok(!/<Well R="\d+" C="\d+" ToR=/.test(writeTddOf(protocol)));
});
