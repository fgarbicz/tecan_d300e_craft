import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseXml, writeXml } from '../src/xmltree.js';

const dir = join(import.meta.dirname, '..', 'fixtures', 'reference');

for (const f of readdirSync(dir).filter((f) => f.endsWith('.tdd'))) {
  test(`byte-identical tree round-trip: ${f}`, () => {
    const buf = readFileSync(join(dir, f));
    const src = buf.toString('utf8');
    const out = writeXml(parseXml(src));
    assert.equal(Buffer.compare(Buffer.from(out, 'utf8'), buf), 0, 'output bytes differ from original');
  });
}
