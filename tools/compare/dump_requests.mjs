// Dump requested well values of a .tdd as JSON {"plate|well|fluid": [value, classId, stockµM, assay_nL]} (1-based plate & fluid).
import { readFileSync } from 'node:fs';
import { parseTdd, wellName, splitKey } from '../../src/tdd.js';
import { stockInBase } from '../../src/dispense.js';
const p = parseTdd(readFileSync(process.argv[2], 'utf8'));
const o = {};
p.plates.forEach((pl, pi) => { for (const [k, m] of pl.wells) { const [r, c] = splitKey(k); for (const [id, v] of m) { const f = p.fluids.find((x) => x.id === id); o[`${pi + 1}|${wellName(r, c)}|${id + 1}`] = [v, f.classId, stockInBase(f), pl.assayVolume, m.size]; } } });
process.stdout.write(JSON.stringify(o));
