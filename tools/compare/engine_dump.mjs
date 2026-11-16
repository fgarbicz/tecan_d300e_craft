// Dump the dispense engine's per-well results for a .tdd as JSON (for comparison with D300e reports).
import { readFileSync } from 'node:fs';
import { parseTdd, wellName, splitKey } from '../../src/tdd.js';
import { computeProtocol } from '../../src/dispense.js';
const p = parseTdd(readFileSync(process.argv[2], 'utf8'));
const out = [];
computeProtocol(p).forEach(({ wells }, pi) => {
  // `well` is the design (non-random) well; `dispensed` the well the D300e dispenses it into (plate randomization)
  const rnd = new Map((p.plates[pi].randomization || []).map((m) => [`${m.r},${m.c}`, wellName(m.toR, m.toC)]));
  for (const [k, w] of wells) {
    const [r, c] = splitKey(k);
    for (const x of w.fluids) out.push({ plate: pi + 1, well: wellName(r, c), dispensedWell: rnd.get(k) || wellName(r, c), fluid: x.fluidId + 1, volume: x.volume, conc: x.dispensed ?? null, total: w.totalVolume, norm: w.normalization });
    if (w.normalization) out.push({ plate: pi + 1, well: wellName(r, c), dispensedWell: rnd.get(k) || wellName(r, c), fluid: 'norm', volume: w.normalization, conc: null, total: w.totalVolume, norm: w.normalization });
  }
});
process.stdout.write(JSON.stringify(out));
