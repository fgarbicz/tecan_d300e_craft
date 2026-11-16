import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTdd, writeTdd, wellKey } from '../src/tdd.js';
import { replicatePlate, removePlate } from '../src/ops.js';
import { buildExperiment, applyExperiment, newMeta, reconcileMeta, wellRole, assignCellLine, addCellLine, setRole,
  serializeMeta, parseMeta, protocolFingerprint, metaReplicatePlate, metaRemovePlate, metaCopyWells, metaPasteWells } from '../src/experiment.js';

const root = join(import.meta.dirname, '..');
const D3 = readFileSync(join(root, 'fixtures/reference/2026.08.28 synergy D3.tdd'), 'utf8');

// The D3 design, as the wizard asks for it.
const D3_SPEC = {
  plate: { plateType: 'Default384', assayVolume: 50000, dmsoLimit: 0.01, dontShake: false },
  border: 1, plateReplicates: 3, scrap: true,
  primary: { fluidId: 0, high: 0.02, factor: 1.4, levels: 10, includeZero: true, replicates: 2 },
  partners: [
    { fluidId: 1, high: 3, factor: 2, levels: 6, includeZero: true, replicates: 2, normalization: { type: 'ToMaxVolume', scope: 'block' } },
    { fluidId: 2, high: 10, factor: 2, levels: 6, includeZero: true, replicates: 2, normalization: { type: 'ToMaxVolume', scope: 'block' } },
    { fluidId: 3, high: 50, factor: 2, levels: 6, includeZero: true, replicates: 2, normalization: { type: 'ToAssayVolumePct', param: 0.01, scope: 'plate' } },
  ],
};

test('experiment wizard rebuilds the hand-made D3 protocol byte for byte', () => {
  const orig = parseTdd(D3);
  const p = parseTdd(D3);
  p.plates = []; p.backfills = [];
  const meta = newMeta(p);
  const built = buildExperiment(D3_SPEC, p.fluids);
  applyExperiment(p, meta, built);
  assert.equal(p.plates.length, 9);
  assert.equal(writeTdd(p), writeTdd(orig));
  assert.equal(writeTdd(p), D3);
  // scrap wells are marked, the rest of the border is PBS, the 0/0 corner is vehicle once cells are assigned
  assert.equal(wellRole(meta, p.plates[0], 0, 0, 23), 'scrap');
  assert.equal(wellRole(meta, p.plates[0], 0, 0, 22), 'scrap');
  assert.equal(wellRole(meta, p.plates[3], 3, 0, 22), 'pbs');
  assert.equal(wellRole(meta, p.plates[0], 0, 15, 5), 'pbs');
  const cl = addCellLine(meta, 'MM.1S');
  const all = []; for (let r = 0; r < 16; r++) for (let c = 0; c < 24; c++) all.push([r, c]);
  const { skipped } = assignCellLine(meta, p.plates[0], 0, all, cl.id);
  assert.equal(skipped, 16 * 2 + 22 * 2); // the whole border (incl. scrap wells) is skipped
  assert.equal(wellRole(meta, p.plates[0], 0, 13, 21), 'vehicle'); // N22: no drug
  assert.equal(wellRole(meta, p.plates[0], 0, 1, 1), 'treated');
  assert.equal(meta.blocks.length, 3);
});

test('wizard refuses a grid that does not fit inside the border', () => {
  const p = parseTdd(D3);
  assert.throws(() => buildExperiment({ ...D3_SPEC, primary: { ...D3_SPEC.primary, levels: 11 } }, p.fluids), /needs 24 columns; only 22 fit/);
});

test('sidecar round-trip and stale detection', () => {
  const p = parseTdd(D3);
  const meta = reconcileMeta(null, p);
  addCellLine(meta, 'KMS-11');
  setRole(meta, 0, [[2, 2]], 'blank');
  const text = serializeMeta(meta, p, 'x.tdd');
  const back = parseMeta(text, p);
  assert.equal(back.stale, false);
  assert.equal(back.meta.cellLines[0].name, 'KMS-11');
  assert.equal(back.meta.plates[0].roles['2,2'], 'blank');
  p.plates[0].wells.get('1,1').set(0, 0.03);
  assert.equal(parseMeta(text, p).stale, true);
  assert.notEqual(protocolFingerprint(p), JSON.parse(text).tdd.fingerprint);
  assert.throws(() => parseMeta('{"x":1}', p), /Not a D300 Craft/);
});

test('plate operations keep annotations aligned', () => {
  const p = parseTdd(D3);
  const meta = reconcileMeta(null, p);
  const cl = addCellLine(meta, 'A');
  assignCellLine(meta, p.plates[2], 2, [[5, 5]], cl.id);
  meta.plates[2].readout = { values: [[1]] };
  replicatePlate(p, 2); metaReplicatePlate(meta, 2);
  assert.equal(meta.plates.length, p.plates.length);
  assert.equal(meta.plates[9].cellLines['5,5'], cl.id);
  assert.equal(meta.plates[9].readout, null);
  removePlate(p, 0); metaRemovePlate(meta, 0);
  assert.equal(meta.plates[1].cellLines['5,5'], cl.id);
  const clip = metaCopyWells(meta, 1, [[5, 5], [5, 6]]);
  metaPasteWells(meta, 1, clip, 10, 10, 16, 24);
  assert.equal(meta.plates[1].cellLines[wellKey(10, 10)], cl.id);
  assert.equal(meta.plates[1].cellLines[wellKey(10, 11)], undefined);
});
