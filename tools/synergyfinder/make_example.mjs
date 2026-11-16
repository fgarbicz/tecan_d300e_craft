// Write the SynergyFinder package of the synthetic two-cell-line screen (tests/helpers/synthetic_synergy.js)
// to a folder, exactly as synergyPackage() returns it.
//   node tools/synergyfinder/make_example.mjs [--out DIR] [--variant replicated|single|mixed]
// variants: replicated = 8 wells per dose pair (all blocks);
//           single     = one well per dose pair (first plate of each cell line, one well of each 2 × 2 replicate group);
//           mixed      = Line A blocks replicated, Line B blocks single wells.
// DIR defaults to tools/synergyfinder/example/<variant> (gitignored).
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { analyze } from '../../src/analysis.js';
import { setRole } from '../../src/experiment.js';
import { synergyPackage } from '../../src/synergy_export.js';
import { buildSyntheticSynergy } from '../../tests/helpers/synthetic_synergy.js';

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const variant = arg('--variant', 'replicated');
if (!['replicated', 'single', 'mixed'].includes(variant)) throw new Error(`Unknown variant ${variant}`);
const out = arg('--out', join(import.meta.dirname, 'example', variant));

const { protocol, meta, built, lines } = buildSyntheticSynergy();
const singleLines = variant === 'single' ? [lines[0].id, lines[1].id] : variant === 'mixed' ? [lines[1].id] : [];
const plates = [];
for (const block of built.blocks) {
  const { r0, c0, rows, cols } = block.region;
  block.plates.forEach((pi, rep) => {
    const line = meta.plates[pi].cellLines[`${r0},${c0}`] ?? Object.values(meta.plates[pi].cellLines)[0];
    const single = singleLines.includes(line);
    if (single && rep % 2 === 1) return; // second plate of the cell line: not analyzed
    plates.push(pi);
    if (!single) return;
    const ex = [];
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) if (i % 2 || j % 2) ex.push([r0 + i, c0 + j]);
    setRole(meta, pi, ex, 'exclude');
  });
}
const result = analyze({ protocol, meta, options: { plates } });
const pkg = synergyPackage(result, protocol, meta, { title: `Synthetic synergy screen (${variant})`, appVersion: 'example', generatedAt: '2026-11-15T12:00:00Z' });
// replace a previous example, never an unrelated folder
if (existsSync(out) && readdirSync(out).length && !existsSync(join(out, 'analysis.R'))) throw new Error(`${out} exists and is not a SynergyFinder package; not overwriting`);
rmSync(out, { recursive: true, force: true });
for (const f of pkg.files) {
  mkdirSync(dirname(join(out, f.path)), { recursive: true });
  writeFileSync(join(out, f.path), f.text);
}
console.log(`${variant}: ${pkg.files.length} files → ${out}`);
