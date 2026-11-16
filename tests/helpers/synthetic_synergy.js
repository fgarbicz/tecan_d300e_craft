// Synthetic two-cell-line drug-combination screen with a known answer, for the SynergyFinder export
// (tests/synergy_export.test.js and tools/synergyfinder/make_example.mjs). Built with the experiment
// wizard on the D3 fluids:
//   primary Bortezomib (fluid 0, along columns) × partner MEN (fluid 1)    → SYNERGISTIC:
//       combination wells v = fA·fB·(1 − S)  (Bliss excess S·fA·fB > 0 everywhere)
//   primary Bortezomib (fluid 0)              × partner IDOTDO (fluid 2)  → Bliss-INDEPENDENT: v = fA·fC
// Each block is printed on 4 plates: plates 1–2 carry cell line "Line A", plates 3–4 "Line B"
// (different IC50s), 2 × 2 in-plate replicates per dose pair (adjacent rows and columns) → 8 replicate wells per dose
// pair and cell line.
// Single-drug curves are Hill-1 log-logistic (f = 1 / (1 + x / IC50)), the model ZIP and drc fit.
// Replicate noise: ±NOISE viability points, alternating so every replicate mean is exact.
// Signal = bg + (top − bg)·v with per-plate bg / top (exercises per-plate normalization).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTdd, wellKey } from '../../src/tdd.js';
import { buildExperiment, applyExperiment, newMeta, addCellLine, assignCellLine, setRole } from '../../src/experiment.js';

const root = join(import.meta.dirname, '..', '..');
export const SYN_SPEC = {
  plate: { plateType: 'Default384', assayVolume: 50000, dmsoLimit: 0.01, dontShake: false },
  border: 1, plateReplicates: 4, scrap: true,
  primary: { fluidId: 0, high: 0.1, factor: 3, levels: 5, includeZero: true, replicates: 2 },
  partners: [
    { fluidId: 1, high: 30, factor: 3, levels: 5, includeZero: true, replicates: 2, normalization: { type: 'ToMaxVolume', scope: 'block' } },
    { fluidId: 2, high: 100, factor: 3, levels: 5, includeZero: true, replicates: 2, normalization: { type: 'ToMaxVolume', scope: 'block' } },
  ],
};
export const SYN_S = 0.4, NOISE = 1.5;
export const IC = { 'Line A': { 0: 0.01, 1: 3, 2: 10 }, 'Line B': { 0: 0.03, 1: 6, 2: 30 } };
export const SYNERGISTIC = [0, 1], INDEPENDENT = [0, 2];
const f = (line, id, x) => 1 / (1 + x / IC[line][id]);
/** Expected viability (fraction) for a cell line and requested concentrations (array by fluid id). */
export function trueViability(line, conc) {
  let v = 1;
  for (const id of [0, 1, 2]) v *= f(line, id, conc[id] || 0);
  if (conc[0] > 0 && conc[1] > 0) v *= 1 - SYN_S;
  return v;
}
const BLANKS = [[14, 19], [14, 20], [14, 21], [14, 22]];

export function buildSyntheticSynergy() {
  const protocol = parseTdd(readFileSync(join(root, 'fixtures/reference/2026.08.28 synergy D3.tdd'), 'utf8'));
  protocol.plates = []; protocol.backfills = [];
  const meta = newMeta(protocol);
  meta.experiment.title = 'Synthetic synergy screen';
  meta.experiment.date = '2026-11-15';
  const built = buildExperiment(SYN_SPEC, protocol.fluids);
  applyExperiment(protocol, meta, built);
  const lines = [addCellLine(meta, 'Line A'), addCellLine(meta, 'Line B')];
  const lineOfPlate = [];
  built.blocks.forEach((block) => {
    const grid = [];
    for (let i = 0; i < block.region.rows; i++) for (let j = 0; j < block.region.cols; j++) grid.push([block.region.r0 + i, block.region.c0 + j]);
    block.plates.forEach((pi, rep) => {
      const line = rep < 2 ? lines[0] : lines[1];
      lineOfPlate[pi] = { line, grid };
      assignCellLine(meta, protocol.plates[pi], pi, grid, line.id);
      setRole(meta, pi, BLANKS, 'blank');
    });
  });
  protocol.plates.forEach((p, pi) => {
    const { line, grid } = lineOfPlate[pi];
    const inGrid = new Set(grid.map(([r, c]) => wellKey(r, c)));
    const bg = 400 + 50 * pi, top = 40000 + 5000 * pi;
    const values = [];
    for (let r = 0; r < p.rows; r++) {
      const row = [];
      for (let c = 0; c < p.cols; c++) {
        const k = wellKey(r, c);
        if (BLANKS.some(([x, y]) => x === r && y === c)) { row.push(bg + (c % 2 ? 9 : -9)); continue; } // 2 odd, 2 even columns → mean exactly bg
        if (!inGrid.has(k)) { row.push(bg + 2); continue; }
        const req = p.wells.get(k);
        const conc = [req?.get(0) || 0, req?.get(1) || 0, req?.get(2) || 0];
        let v = trueViability(line.name, conc);
        // alternate ± noise by column inside the replicate pair; vehicle wells stay exact (mean = top)
        if (conc.some((x) => x > 0)) v += ((c % 2 ? 1 : -1) * NOISE) / 100;
        row.push(bg + (top - bg) * v);
      }
      values.push(row);
    }
    meta.plates[pi].readout = { values, raw: '', importedAt: '2026-11-15T12:00:00Z' };
  });
  return { protocol, meta, built, lines };
}
