// Synthetic CellTiter-Glo experiment with a known answer, shared by tests/analysis.test.js and
// tools/xlsx_roundtrip.mjs. Built with the experiment wizard on the D3 fluids (Bortezomib × MEN):
//   plates 0, 1: cell line A, drugs Bliss-independent: v = fA(a)·fB(b); treated wells get +EPS
//                viability points on plate 0 and −EPS on plate 1 (so means are exact, SD known);
//   plate 2:     cell line B, synergistic: combination wells v = fA·fB·(1 − S);
//   plate 3:     no readout (must be ignored).
// Signal = bg + (top − bg)·v, with a different bg / top per plate (per-plate normalization).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTdd, wellKey } from '../../src/tdd.js';
import { buildExperiment, applyExperiment, newMeta, addCellLine, assignCellLine, setRole } from '../../src/experiment.js';

const root = join(import.meta.dirname, '..', '..');
export const SPEC = {
  plate: { plateType: 'Default384', assayVolume: 50000, dmsoLimit: 0.01, dontShake: false },
  border: 1, plateReplicates: 4, scrap: true,
  primary: { fluidId: 0, high: 0.02, factor: 2, levels: 3, includeZero: true, replicates: 2 },
  partners: [{ fluidId: 1, high: 3, factor: 2, levels: 3, includeZero: true, replicates: 2, normalization: { type: 'ToMaxVolume', scope: 'block' } }],
};
export const IC_A = 0.01, IC_B = 1.5, S = 0.3, EPS = 2;
export const PLATES = [{ bg: 500, top: 50000 }, { bg: 800, top: 80000 }, { bg: 300, top: 30000 }];
export const fA = (a) => 1 / (1 + a / IC_A);
export const fB = (b) => 1 / (1 + b / IC_B);
export const BLANKS = [[12, 1], [12, 2], [12, 3], [12, 4]]; // M2–M5: medium only
export const EXCLUDED = [2, 1, 1]; // plate 2, B2 (a high, b high): excluded, given an absurd signal

/** Expected viability (fraction) of a well with requested a (fluid 0) and b (fluid 1) for cell line A or B. */
export const trueV = (line, a, b) => fA(a) * fB(b) * (line === 'B' && a > 0 && b > 0 ? 1 - S : 1);

export function buildSynthetic() {
  const protocol = parseTdd(readFileSync(join(root, 'fixtures/reference/2026.08.28 synergy D3.tdd'), 'utf8'));
  protocol.plates = []; protocol.backfills = [];
  const meta = newMeta(protocol);
  const built = buildExperiment(SPEC, protocol.fluids);
  applyExperiment(protocol, meta, built);
  const A = addCellLine(meta, 'Line A'), B = addCellLine(meta, 'Line B');
  const block = built.blocks[0];
  const grid = [];
  for (let i = 0; i < block.region.rows; i++) for (let j = 0; j < block.region.cols; j++) grid.push([block.region.r0 + i, block.region.c0 + j]);
  const lineOf = ['A', 'A', 'B', 'A'];
  protocol.plates.forEach((p, pi) => {
    assignCellLine(meta, p, pi, grid, lineOf[pi] === 'A' ? A.id : B.id);
    setRole(meta, pi, BLANKS, 'blank');
  });
  setRole(meta, EXCLUDED[0], [[EXCLUDED[1], EXCLUDED[2]]], 'exclude');
  const inGrid = new Set(grid.map(([r, c]) => wellKey(r, c)));
  PLATES.forEach(({ bg, top }, pi) => {
    const p = protocol.plates[pi];
    const values = [];
    for (let r = 0; r < p.rows; r++) {
      const row = [];
      for (let c = 0; c < p.cols; c++) {
        const k = wellKey(r, c);
        if (BLANKS.some(([x, y]) => x === r && y === c)) { row.push(bg + (c % 2 ? 7 : -7)); continue; } // mean exactly bg
        if (!inGrid.has(k)) { row.push(r === 0 && c === 0 ? null : bg + 3); continue; } // A1 'OVER'
        const req = p.wells.get(k);
        const a = req?.get(0) || 0, b = req?.get(1) || 0;
        let v = trueV(lineOf[pi], a, b);
        if (a || b) v += (pi === 0 ? EPS : pi === 1 ? -EPS : 0) / 100;
        row.push(bg + (top - bg) * v);
      }
      values.push(row);
    }
    if (pi === EXCLUDED[0]) values[EXCLUDED[1]][EXCLUDED[2]] = 1e9;
    meta.plates[pi].readout = { values, raw: '', importedAt: '2026-11-15T12:00:00Z' };
  });
  return { protocol, meta, block, lines: { A, B } };
}
