// Build a protocol from scratch with the app's engine (no inherited layout, no thumbnail) and write it,
// to test that D300e Control opens files the app creates. Usage: node make_protocol.mjs <out.tdd>
import { writeFileSync } from 'node:fs';
import { newProtocol, writeTdd } from '../../src/tdd.js';
import { newPlate, addFluid, titrationLevels, applyTitration, synergyLevels, buildSynergy, addNormalization, dilutedFluid, setWell } from '../../src/ops.js';
import { scrapWellValues } from '../../src/dispense.js';

const p = newProtocol();
const a = addFluid(p, { name: 'DrugA', concentration: 10000, concentrationUnit: 'mM', classId: 0 });
const b = addFluid(p, { name: 'DrugB', concentration: 5000, concentrationUnit: 'mM', classId: 0 });
const ad = dilutedFluid(p, a, 100);
// plate 1: titration of DrugA across row B (12 levels, 10 -> 0.001 µM), DrugB set value in row C
const p1 = newPlate({ plateType: 'Default384', name: 'Mac titration' });
p.plates.push(p1);
const cells = Array.from({ length: 12 }, (_, i) => [1, i + 1]);
applyTitration(p1, cells, a.id, titrationLevels({ mode: 'highLow', high: 10, low: 0.003, levels: 12, distribution: 'log' }));
for (let c = 1; c <= 6; c++) setWell(p1, 2, c, b.id, 1.5);
setWell(p1, 3, 1, ad.id, 0.0005);
for (const [id, v] of scrapWellValues([a, b, ad], p1)) setWell(p1, 0, 23, id, v);
// plate 2: synergy 6x6 with zeros (as D300e builds it)
const lv = (id, order, high, low) => ({ fluidId: id, includeZero: true, order, levels: synergyLevels({ mode: 'highLow', high, low, levels: 6, distribution: 'log', includeZero: true }) });
const [p2] = buildSynergy({ type: 'ABC', layout: 'single', plate: { plateType: 'Default384', assayVolume: 50000, dmsoLimit: 0.01 },
  fluids: [lv(a.id, 'highFirst', 20, 0.02), lv(b.id, 'lowFirst', 20, 0.02)] });
p.plates.push(p2);
addNormalization(p, 0, 'ToMaxVolume', undefined, [...p2.wells.keys()].map((k) => { const [r, c] = k.split(',').map(Number); return { p: 1, r, c }; }));
addNormalization(p, 0, 'ToAssayVolumePct', 0.005, cells.map(([r, c]) => ({ p: 0, r, c })));
writeFileSync(process.argv[2], writeTdd(p));
console.log('wrote', process.argv[2], p.fluids.length, 'fluids', p.plates.length, 'plates');
