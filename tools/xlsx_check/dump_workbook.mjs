// Dump the toWorkbook() JSON of the synthetic CTG experiment (tests/helpers/synthetic_readout.js).
// Usage: node tools/xlsx_check/dump_workbook.mjs out.json
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze, toWorkbook } from '../../src/analysis.js';
import { buildSynthetic } from '../../tests/helpers/synthetic_readout.js';

const out = process.argv[2];
if (!out) { console.error('usage: dump_workbook.mjs out.json'); process.exit(2); }
const { protocol, meta } = buildSynthetic();
meta.experiment.title = 'Synthetic CTG round-trip';
const conf = JSON.parse(readFileSync(join(import.meta.dirname, '../../crates/d300-app/tauri.conf.json'), 'utf8'));
const wb = toWorkbook(analyze({ protocol, meta }), protocol, meta, { appVersion: conf.version, generatedAt: '2026-11-15T12:00:00Z' });
writeFileSync(out, JSON.stringify(wb));
console.log(`wrote ${out}: ${wb.sheets.map((s) => `${s.name} (${s.rows.length} rows)`).join(', ')}`);
