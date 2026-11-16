import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTdd } from '../src/tdd.js';
import { drugScales, rampColor, wellBackground, wellDoses, doseMapSvg, doseSummary, scrapBySignature } from '../src/dosemap.js';

const d3 = parseTdd(readFileSync(join(import.meta.dirname, '..', 'fixtures/reference/2026.08.28 synergy D3.tdd'), 'utf8'));

test('ramp: pale at the lowest level, the hue at 0.7, darker at the top; monotone in lightness', () => {
  assert.equal(rampColor('#2f6fde', 0.7), '#2f6fde');
  const L = (h) => { const n = parseInt(h.slice(1), 16); return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255); };
  let prev = Infinity;
  for (let t = 0; t <= 1.0001; t += 0.05) { const l = L(rampColor('#d9480f', t)); assert.ok(l < prev + 1e-9, `t=${t}`); prev = l; }
  assert.ok(L(rampColor('#2f6fde', 0)) > 200, 'lowest level is a pale tint');
});

test('drug scales span the whole protocol on a log scale; distinct levels merge float noise', () => {
  const sc = drugScales(d3);
  assert.ok(sc.size >= 2);
  for (const s of sc.values()) {
    assert.equal(s.t(s.min), 0); assert.ok(Math.abs(s.t(s.max) - (s.levels.length > 1 ? 1 : 1)) < 1e-12);
    for (let i = 1; i < s.levels.length; i++) assert.ok(s.levels[i] > s.levels[i - 1] * (1 + 1e-9));
    // geometric dilution series: equal log steps → equal t steps
  }
  const p = { plates: [{ rows: 1, cols: 3, wells: new Map([['0,0', new Map([[1, 1]])], ['0,1', new Map([[1, 10]])], ['0,2', new Map([[1, 100.00000000001]])]]) }],
    fluids: [{ id: 1, name: 'X', byVol: false, concentrationUnit: 'mM' }], settings: {} };
  const s = drugScales(p).get(1);
  assert.equal(s.levels.length, 3); assert.ok(Math.abs(s.t(10) - 0.5) < 1e-9);
});

test('well background: one drug solid, two drugs left/right halves in protocol order, none → null', () => {
  const p = { plates: [{ rows: 1, cols: 2, wells: new Map() }], settings: {},
    fluids: [{ id: 2, name: 'A', byVol: false, concentrationUnit: 'mM' }, { id: 1, name: 'B', byVol: false, concentrationUnit: 'mM' }] };
  p.plates[0].wells.set('0,0', new Map([[1, 5], [2, 1]])); p.plates[0].wells.set('0,1', new Map([[2, 4]]));
  const sc = drugScales(p);
  const two = wellBackground(p.plates[0].wells.get('0,0'), sc);
  assert.match(two, /^linear-gradient\(90deg, #[0-9a-f]{6} 50%, #[0-9a-f]{6} 50%\)$/);
  assert.equal(wellDoses(p.plates[0].wells.get('0,0'), sc)[0].id, 2, 'left half = first drug in the protocol');
  assert.equal(wellBackground(p.plates[0].wells.get('0,0'), sc, 1), sc.get(1).colorOf(5), 'filtered to one drug');
  assert.equal(wellBackground(new Map(), sc), null);
});

test('dose-map SVG and summary for the D3 protocol', () => {
  const svg = doseMapSvg(d3, { title: 'D3' });
  assert.match(svg, /^<svg [^>]*viewBox/); assert.ok(svg.endsWith('</svg>'));
  assert.ok(!/NaN|undefined/.test(svg));
  for (let i = 1; i <= d3.plates.length; i++) assert.ok(svg.includes(`Plate ${i}`));
  const lines = doseSummary(d3);
  assert.equal(lines.length, drugScales(d3).size);
  assert.match(lines[0], /level/);
});

test('scrap wells: D3 hand-made scrap wells (0.6 / 6 µM) are recognised by signature and left off the scale', () => {
  const sc = drugScales(d3, { skip: scrapBySignature(d3) });
  const bz = [...sc.values()].find((s) => s.fluid.name === 'Bortezomib');
  assert.ok(Math.abs(bz.max - 0.02) < 1e-9, 'Bortezomib top level 20 nM, not the 0.6 µM scrap well');
  assert.equal(drugScales(d3).get(bz.fluid.id).max, 0.6, 'without the skip the scrap well sets the top');
});

test('design plan carries the dose levels; the CLI writes the dose map', async () => {
  const { designAndPlan } = await import('../src/design.js');
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = join(import.meta.dirname, '..');
  const spec = JSON.parse(execFileSync('node', [join(root, 'tools/cli/d300craft.mjs'), 'example'], { encoding: 'utf8' }));
  const { plan } = designAndPlan(spec, 'x');
  assert.deepEqual(plan.doses.map((d) => d.drug), spec.drugs.map((d) => d.name).filter((n) => plan.doses.some((x) => x.drug === n)));
  for (const d of plan.doses) { assert.ok(d.levels.length >= 2); assert.ok(d.foldRange > 1); }
  const dir = mkdtempSync(join(tmpdir(), 'dosemap-'));
  try {
    const specPath = join(dir, 'spec.json');
    (await import('node:fs')).writeFileSync(specPath, JSON.stringify(spec));
    const out = execFileSync('node', [join(root, 'tools/cli/d300craft.mjs'), 'design', specPath, '--out', dir, '--name', 'dm'], { encoding: 'utf8' });
    assert.ok(existsSync(join(dir, 'dm_dosemap.svg')));
    assert.match(out, /## Dose gradients/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scrap signature is not used on a plate whose experiment file marks scrap wells', async () => {
  const { scrapTestFromRoles } = await import('../src/dosemap.js');
  // D3 plate 1: A24 matches the priming signature; if the experiment file marks a different well as scrap,
  // A24 must stay on the scale.
  const marked = scrapTestFromRoles(d3, (pi, r, c) => (pi === 0 && r === 1 && c === 1 ? 'scrap' : 'treated'));
  assert.equal(marked(0, '0,23'), false, 'A24 kept: this plate has explicitly marked scrap wells');
  const none = scrapTestFromRoles(d3, () => 'treated');
  assert.equal(none(0, '0,23'), true, 'no scrap marked anywhere: signature applies');
});
