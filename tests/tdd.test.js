import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseTdd, writeTdd, formatNumber, newProtocol } from '../src/tdd.js';

const dir = join(import.meta.dirname, '..', 'fixtures', 'reference');
const files = [...readdirSync(dir).filter((f) => f.endsWith('.tdd')),
  ...readdirSync(join(dir, 'tecan_examples')).filter((f) => f.endsWith('.tdd')).map((f) => join('tecan_examples', f))];

for (const f of files) {
  test(`model round-trip is byte-identical: ${f}`, () => {
    const buf = readFileSync(join(dir, f));
    const out = writeTdd(parseTdd(buf.toString('utf8')));
    assert.equal(Buffer.compare(Buffer.from(out, 'utf8'), buf), 0);
  });
  test(`model round-trip survives re-formatting of every well value: ${f}`, () => {
    // Drop the original text of all numbers so the formatter has to reproduce them.
    const p = parseTdd(readFileSync(join(dir, f), 'utf8'));
    for (const fl of p.fluids) { delete fl._concText; delete fl._maxVolText; delete fl._dilText; }
    for (const pl of p.plates) { delete pl._assayText; delete pl._dmsoText; }
    for (const b of p.backfills) delete b._paramText;
    assert.equal(writeTdd(p), readFileSync(join(dir, f), 'utf8'));
  });
}

test('formatNumber matches .NET G13 conventions', () => {
  const cases = [[0, '0'], [6, '6'], [0.02, '0.02'], [1 / 98, '0.01020408163265'], [0.0009680051649410, '0.000968005164941'],
    [50000, '50000'], [0.01, '0.01'], [1e-4, '0.0001'], [1e-5, '1E-05'], [1e-6, '1E-06'], [1.5e-7, '1.5E-07'], [1e13, '1E+13'],
    [9.99999999999999, '10'], [-0.5, '-0.5'], [1 / 3, '0.3333333333333']];
  for (const [x, s] of cases) assert.equal(formatNumber(x), s, `formatNumber(${x})`);
});

test('a new empty protocol writes valid structure', () => {
  const out = writeTdd(newProtocol());
  assert.match(out, /^<\?xml version="1.0" encoding="utf-8"\?>\r\n<Root>\r\n  <Protocol>\r\n    <!--Protocol files/);
  assert.match(out, /<Fluids \/>/);
  assert.ok(!out.endsWith('\r\n'));
  assert.deepEqual(parseTdd(out).settings.Version, '4');
});

test('T01 (made in D300e Control): stock units, 13-digit values, exponent form, diluted fluid', () => {
  const p = parseTdd(readFileSync(join(dir, 't01-setvalue-units.tdd'), 'utf8'));
  // "DMSO @ 10.0 mM" in the UI is stored as 10000 (µM) with display unit mM
  assert.equal(p.fluids[0].concentration, 10000); assert.equal(p.fluids[0].concentrationUnit, 'mM');
  // 1:300 dilution: concentration in µM, RootFluidID/DilutionFactor recorded
  assert.equal(p.fluids[1].name, 'Fluid 1 - 1:300'); assert.equal(p.fluids[1].rootFluidId, 0); assert.equal(p.fluids[1].dilutionFactor, 300);
  assert.equal(formatNumber(10000 / 300), '33.33333333333');
  const w = p.plates[0].wells;
  assert.equal(w.get('0,1').get(0), 33.33333333333);
  assert.equal(w.get('0,12').get(1), 1e-5);
});

test('a diluted fluid created by the app is written like D300e Control writes it', async () => {
  const { dilutedFluid } = await import('../src/ops.js');
  const t01 = readFileSync(join(dir, 't01-setvalue-units.tdd'), 'utf8');
  const ref = parseTdd(t01);
  const mine = newProtocol();
  mine.fluids.push({ ...ref.fluids[0], _order: undefined });
  dilutedFluid(mine, mine.fluids[0], 300);
  const block = (txt) => txt.split('<Fluids>')[1].split('</Fluids>')[0];
  assert.equal(block(writeTdd(mine)), block(t01));
});

test('new plates default to Deionize=True; empty names are written <Name />', async () => {
  const { newPlate, addFluid } = await import('../src/ops.js');
  const p = newProtocol(); p.plates.push(newPlate()); addFluid(p, { name: '' });
  const out = writeTdd(p);
  assert.match(out, /<Deionize>True<\/Deionize>/);
  assert.ok(!out.includes('<Name></Name>'));
});
