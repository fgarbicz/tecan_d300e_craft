import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseTdd, writeTdd, formatNumber, newProtocol } from '../src/tdd.js';

const dir = join(import.meta.dirname, '..', 'fixtures', 'reference');
const files = readdirSync(dir).filter((f) => f.endsWith('.tdd'));

for (const f of files) {
  test(`model round-trip is byte-identical: ${f}`, () => {
    const buf = readFileSync(join(dir, f));
    const out = writeTdd(parseTdd(buf.toString('utf8')));
    assert.equal(Buffer.compare(Buffer.from(out, 'utf8'), buf), 0);
  });
  test(`model round-trip survives re-formatting of every well value: ${f}`, () => {
    // Drop the original text of all numbers so the formatter has to reproduce them.
    const p = parseTdd(readFileSync(join(dir, f), 'utf8'));
    for (const fl of p.fluids) { delete fl._concText; delete fl._maxVolText; }
    for (const pl of p.plates) { delete pl._assayText; delete pl._dmsoText; }
    for (const b of p.backfills) delete b._paramText;
    assert.equal(writeTdd(p), readFileSync(join(dir, f), 'utf8'));
  });
}

test('formatNumber matches .NET G13 conventions', () => {
  const cases = [[0, '0'], [6, '6'], [0.02, '0.02'], [1 / 98, '0.01020408163265'], [0.0009680051649410, '0.000968005164941'],
    [50000, '50000'], [0.01, '0.01'], [1e-5, '0.00001'], [1e-6, '1E-06'], [1.5e-7, '1.5E-07'], [1e13, '1E+13'],
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
