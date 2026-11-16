// SynergyFinder export: the analyzed readout (analysis.js analyze()) → a self-contained data package that
// runs the Bioconductor package synergyfinder (v3, Ianevski et al., Nucleic Acids Res 2022) and draws its
// figures: data CSVs + analysis.R + README.md + environment.yml.
//
// Pure module: no DOM, no fs; runs in node (tests/synergy_export.test.js) and in the browser. The desktop
// shell writes the returned files to disk (folder or zip) and may run `Rscript analysis.R` in it.
//
// Input format (checked against synergyfinder 3.18.0, ReshapeData() and its .AdjustColumnName()):
//   required columns block_id, drug1, drug2, conc1, conc2, response, conc_unit1 (conc_unit2 optional;
//   copied from conc_unit1 when missing). An extra cell_line_name column is used by ReshapeData's own
//   check that a block holds one drug-pair × cell-line combination.
//   response = per-well % viability, read with ReshapeData(data_type = "viability") — the package's
//   default — which converts it to % inhibition (100 − viability) for every score.
//   One row per measured well; replicates are separate rows (ReshapeData averages them, and with
//   replicates it bootstraps p-values and confidence intervals).
//
// Blocks: one per (cell line × drug pair). A block takes the plates that hold at least one combination
// well of that pair for that cell line, and on those plates every treated / vehicle well of the cell
// line whose drugs are a subset of the pair: combinations, both single agents and the 0/0 vehicle wells.
// Single agents on other plates (e.g. the same primary drug crossed with another partner) are not
// pooled in: their DMSO normalization and plate effects can differ (see analysis.js CONDITIONS_TEXT).
// Wells without a viability (no signal, excluded) are left out; a missing matrix cell is imputed by
// ReshapeData(impute = TRUE) with a warning in the R log.

import { ANALYSIS_R } from './synergy_r.js';

export const SF_VERSION = '3.18.0';
export const SF_DATA_TYPE = 'viability';
export const SF_COLUMNS = ['block_id', 'drug1', 'drug2', 'conc1', 'conc2', 'response', 'conc_unit1', 'conc_unit2', 'cell_line_name'];
export const SF_METHODS = ['ZIP', 'HSA', 'Bliss', 'Loewe'];

/** conda environment that runs analysis.R; identical copy in tools/synergyfinder/environment.yml (tested). */
export const ENVIRONMENT_YML = `# Conda environment for the SynergyFinder analysis (analysis.R).
# Create it with:
#   conda env create -f environment.yml        (or: mamba env create -f environment.yml)
# then run:
#   conda run -n synergyfinder Rscript analysis.R
# Resolved on macOS arm64 (osx-arm64), 2026-11-15, from:
#   mamba create -n synergyfinder -c conda-forge -c bioconda --strict-channel-priority \\
#     bioconductor-synergyfinder=3.18.0 r-base=4.5 r-ggplot2 r-svglite r-ragg r-scales r-plotly
name: synergyfinder
channels:
  - conda-forge
  - bioconda
dependencies:
  - r-base=4.5.3
  - bioconductor-synergyfinder=3.18.0
  - r-ggplot2=4.0.4
  - r-svglite=2.2.2
  - r-ragg=1.5.2
  - r-scales=1.4.0
  - r-plotly=4.12.1
  - r-htmlwidgets=1.6.4
  - r-lattice=0.23_1
  - r-drc=3.0_1
`;

const roundKey = (x) => (x === 0 ? 0 : Number(x.toPrecision(10)));
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

function fluidInfo(result, protocol) {
  return result.fluids || protocol.fluids.map((f) => ({ id: f.id, name: f.name, unit: 'µM' }));
}

/**
 * Blocks (cell line × drug pair) with their wells. Deterministic order: cell line (meta order, then
 * name), then drug1 id, then drug2 id.
 * drug1 / drug2: when a wizard block (meta.blocks) has this pair, drug1 = its primary (titrated along
 * the columns) and drug2 = the partner; otherwise the fluid with the lower id is drug1.
 */
export function synergyBlocks(result, protocol, meta) {
  const fl = fluidInfo(result, protocol);
  const idx = new Map(fl.map((f, i) => [f.id, i]));
  const clOrder = new Map((meta.cellLines || []).map((c, i) => [c.id, i]));
  const primaryOf = new Map();
  for (const b of meta.blocks || []) if (b.primary != null && b.partner != null) {
    primaryOf.set([b.primary, b.partner].sort((x, y) => x - y).join('|'), b.primary);
  }
  const usable = (w) => (w.role === 'treated' || w.role === 'vehicle') && w.cellLineId;
  const drugsOf = (w) => w.conc.map((x, i) => (x ? i : -1)).filter((i) => i >= 0); // indices into fl
  const pairs = new Map();
  for (const w of result.wells) {
    if (!usable(w)) continue;
    const d = drugsOf(w);
    if (d.length !== 2) continue;
    const ids = d.map((i) => fl[i].id).sort((x, y) => x - y);
    const pk = ids.join('|');
    const first = primaryOf.has(pk) ? primaryOf.get(pk) : ids[0];
    const [f1, f2] = first === ids[0] ? ids : [ids[1], ids[0]];
    const k = `${w.cellLineId}|${f1}|${f2}`;
    if (!pairs.has(k)) pairs.set(k, { cellLineId: w.cellLineId, cellLine: w.cellLine, f1, f2, plates: new Set() });
    pairs.get(k).plates.add(w.plateIndex);
  }
  const rank = (id) => clOrder.get(id) ?? Infinity;
  const list = [...pairs.values()].sort((a, b) => rank(a.cellLineId) - rank(b.cellLineId) ||
    String(a.cellLine).localeCompare(String(b.cellLine)) || a.f1 - b.f1 || a.f2 - b.f2);
  return list.map((p, n) => {
    const i1 = idx.get(p.f1), i2 = idx.get(p.f2);
    const wells = result.wells.filter((w) => usable(w) && w.cellLineId === p.cellLineId && p.plates.has(w.plateIndex) &&
      drugsOf(w).every((i) => i === i1 || i === i2));
    const measured = wells.filter((w) => finite(w.viability));
    const lv = (i) => [...new Set(measured.map((w) => roundKey(w.conc[i])))].sort((x, y) => x - y);
    const conc1Levels = lv(i1), conc2Levels = lv(i2);
    const combos = new Set(measured.filter((w) => w.conc[i1] && w.conc[i2]).map((w) => `${roundKey(w.conc[i1])},${roundKey(w.conc[i2])}`));
    const cells = new Set(measured.map((w) => `${roundKey(w.conc[i1])},${roundKey(w.conc[i2])}`));
    return {
      blockId: n + 1, cellLineId: p.cellLineId, cellLine: p.cellLine,
      fluid1: p.f1, fluid2: p.f2, drug1: fl[i1].name, drug2: fl[i2].name, unit1: fl[i1].unit, unit2: fl[i2].unit,
      index1: i1, index2: i2,
      plates: [...p.plates].sort((a, b) => a - b).map((pi) => pi + 1),
      wells, measured,
      conc1Levels, conc2Levels,
      nCombinationCells: combos.size,
      missingCells: conc1Levels.length * conc2Levels.length - cells.size,
      title: `${p.cellLine}: ${fl[i1].name} × ${fl[i2].name}`,
    };
  });
}

/**
 * SynergyFinder long input table.
 * @returns {{ columns: string[], rows: object[], blocks: object[], dataType: 'viability', warnings: string[] }}
 *   rows: { block_id, drug1, drug2, conc1, conc2, response, conc_unit1, conc_unit2, cell_line_name,
 *           plate, well } — plate / well are kept for traceability but not written to the CSV.
 *   blocks: block map rows (see blockMapRows).
 */
export function synergyFinderTable(result, protocol, meta) {
  const blocks = synergyBlocks(result, protocol, meta);
  const warnings = [];
  const rows = [];
  for (const b of blocks) {
    if (b.conc1Levels.filter(Boolean).length < 1 || b.conc2Levels.filter(Boolean).length < 1) warnings.push(`Block ${b.blockId} (${b.title}): no measured single-agent level.`);
    if (!b.conc1Levels.includes(0) || !b.conc2Levels.includes(0)) warnings.push(`Block ${b.blockId} (${b.title}): no single-agent or vehicle wells; SynergyFinder needs the 0 row and column.`);
    if (b.missingCells > 0) warnings.push(`Block ${b.blockId} (${b.title}): ${b.missingCells} dose combination${b.missingCells === 1 ? ' has' : 's have'} no measured well; ReshapeData imputes ${b.missingCells === 1 ? 'it' : 'them'}.`);
    const ordered = [...b.measured].sort((x, y) => x.conc[b.index1] - y.conc[b.index1] || x.conc[b.index2] - y.conc[b.index2] || x.plateIndex - y.plateIndex || x.r - y.r || x.c - y.c);
    for (const w of ordered) {
      rows.push({
        block_id: b.blockId, drug1: b.drug1, drug2: b.drug2,
        conc1: roundKey(w.conc[b.index1]), conc2: roundKey(w.conc[b.index2]),
        response: Number(w.viability.toPrecision(10)),
        conc_unit1: b.unit1, conc_unit2: b.unit2, cell_line_name: b.cellLine,
        plate: w.plate, well: w.well,
      });
    }
  }
  if (!blocks.length) warnings.push('No drug pair has combination wells with a viability: nothing to export for SynergyFinder.');
  return { columns: SF_COLUMNS, rows, blocks: blockMapRows(blocks), dataType: SF_DATA_TYPE, warnings, _blocks: blocks };
}

/** Block map: block_id → cell line, drugs, units, plates, sizes. */
export function blockMapRows(blocks) {
  return blocks.map((b) => ({
    block_id: b.blockId, cell_line: b.cellLine, drug1: b.drug1, drug2: b.drug2, conc_unit1: b.unit1, conc_unit2: b.unit2,
    plates: b.plates.join(';'), n_wells: b.measured.length, n_conc1: b.conc1Levels.length, n_conc2: b.conc2Levels.length,
    n_combinations: b.nCombinationCells, missing_cells: b.missingCells, title: b.title,
  }));
}
export const BLOCK_MAP_COLUMNS = ['block_id', 'cell_line', 'drug1', 'drug2', 'conc_unit1', 'conc_unit2', 'plates', 'n_wells', 'n_conc1', 'n_conc2', 'n_combinations', 'missing_cells', 'title'];

// ---------- CSV ----------
function csvCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  const s = String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** RFC 4180 CSV (comma, "." decimals, LF line ends, UTF-8 without BOM). */
export function toCsv(columns, rows) {
  const lines = [columns.map(csvCell).join(',')];
  for (const r of rows) lines.push((Array.isArray(r) ? r : columns.map((c) => r[c])).map(csvCell).join(','));
  return lines.join('\n') + '\n';
}

function wellsAnnotated(result, blocks) {
  const fl = result.fluids;
  const member = new Map();
  for (const b of blocks) for (const w of b.wells) {
    const k = `${w.plateIndex}|${w.well}`;
    if (!member.has(k)) member.set(k, []);
    member.get(k).push(b.blockId);
  }
  const columns = ['plate', 'plate_name', 'well', 'row', 'col', 'role', 'cell_line', ...fl.map((f) => `${f.name} (${f.unit})`),
    'dmso_pct', 'raw_signal', 'background', 'vehicle_mean', 'viability_pct', 'note', 'synergyfinder_blocks'];
  const rows = result.wells.map((w) => [w.plate, w.plateName, w.well, w.row, w.col, w.role, w.cellLine, ...w.conc,
    w.dmsoPct, w.raw, w.background, w.vehicleMean, w.viability, w.note, (member.get(`${w.plateIndex}|${w.well}`) || []).join(';')]);
  return toCsv(columns, rows);
}

function readme({ title, meta, blocks, warnings, generatedAt, appVersion }) {
  const exp = meta.experiment || {};
  const blockLines = blocks.length
    ? blocks.map((b) => `| ${b.blockId} | ${b.cellLine} | ${b.drug1} (${b.unit1}) | ${b.drug2} (${b.unit2}) | ${b.plates.join(', ')} | ${b.conc1Levels.length} × ${b.conc2Levels.length} | ${b.measured.length} |`).join('\n')
    : '| – | no drug pair with combination wells | | | | | |';
  return `# ${title} — SynergyFinder package

Exported by Tecan D300 Craft${appVersion ? ` ${appVersion}` : ''}${generatedAt ? ` on ${generatedAt}` : ''}.
${exp.title ? `Experiment: ${exp.title}${exp.date ? ` (${exp.date})` : ''}. ` : ''}${exp.assay ? `Assay: ${exp.assay}.` : ''}

This folder is self-contained: the data, the R script that analyses it with the Bioconductor package
**synergyfinder** (${SF_VERSION}), and the conda environment that runs the script.

## Run it

\`\`\`sh
conda env create -f environment.yml     # once (mamba env create -f environment.yml is faster)
conda run -n synergyfinder Rscript analysis.R
\`\`\`

Run from any working directory: the script finds \`data/\` next to itself, and writes \`results/\` and
\`figures/\` next to itself. Options (methods, figure formats, dpi, palette, size) are at the top of
\`analysis.R\`. A figure format whose R package is missing is skipped with a warning; the run goes on.

## Data

| File | Content |
|---|---|
| \`data/synergyfinder_input.csv\` | SynergyFinder long format, one row per measured well (replicates are separate rows). Columns: ${SF_COLUMNS.map((c) => `\`${c}\``).join(', ')}. \`response\` is **% viability** (read with \`ReshapeData(data_type = "viability")\`, which turns it into % inhibition = 100 − viability). Concentrations are the requested final concentrations of the protocol. |
| \`data/block_map.csv\` | One row per block (cell line × drug pair): drugs, units, source plates, matrix size, wells, missing matrix cells. |
| \`data/wells_annotated.csv\` | Every analyzed well: plate, well, role, cell line, concentrations, DMSO %, raw signal, background, vehicle mean, viability %, note and the SynergyFinder blocks the well belongs to. |

Viability % = (signal − background) / (vehicle mean − background) × 100, background = mean of the blank
wells, vehicle mean = mean of the cell line's vehicle wells, both on the same plate. A block uses the
plates that hold combination wells of its drug pair for its cell line, and on those plates the
combination, single-agent and vehicle wells of that cell line.

### Blocks

| Block | Cell line | Drug 1 | Drug 2 | Plates | Doses (drug 1 × drug 2) | Wells |
|---|---|---|---|---|---|---|
${blockLines}
${warnings.length ? `\nWarnings at export:\n\n${warnings.map((w) => `- ${w}`).join('\n')}\n` : ''}
## Output

\`results/\` (CSV):

- \`synergy_summary_by_block.csv\` — per block: the block map, the synergy score of each method over the
  whole dose matrix with its p-value, IC50, RI and CSS.
- \`synergy_scores_by_dose.csv\` — per block and dose pair: mean inhibition, reference (expected)
  inhibition and synergy score of each method (with SD / SEM / 95 % CI when the block has replicates).
- \`sensitivity_by_block.csv\` — RI (relative inhibition, area under the single-drug curve) and CSS
  (combination sensitivity score).
- \`session_info.txt\` — R and package versions of the run.
- \`figure_manifest.csv\` — every figure file with its status (ok / skipped / failed).
- \`synergyfinder_result.rds\` — the full synergyfinder result object.

\`figures/block_<id>_<cell line>_<drug1>_<drug2>/\` — per block:

| Figure | What it shows |
|---|---|
| \`response_matrix\` | Dose-response matrix: mean % inhibition (100 − % viability) at every dose pair, with the SD over replicate wells. |
| \`dose_response_<drug>\` | Single-drug dose response of each drug (the 0 row / column of the matrix): replicate means ± SD and the four-parameter log-logistic fit synergyfinder uses (IC50 in the subtitle). |
| \`synergy_<method>_heatmap\` | Synergy score of the method at every dose pair, with its 95 % CI with replicates; diverging scale centred on 0 (red = synergy, blue = antagonism). |
| \`synergy_<method>_map\` | 2D synergy map: the interpolated score surface as filled contours (synergyfinder's Plot2DrugContour, restyled). |
| \`synergy_<method>_surface\` | 3D synergy surface (synergyfinder's Plot2DrugSurface, lattice wireframe). |

\`figures/\` — across blocks: \`summary_synergy_scores\` (score per method and block, * p < 0.05),
\`summary_sensitivity_synergy\` (CSS vs ZIP score per block).

Every figure is written as PNG (300 dpi by default), PDF, SVG (svglite) and RDS; add \`"html"\` to
\`formats\` for interactive 3D surfaces (plotly). The RDS holds the R
plot object (a ggplot, or a lattice trellis object for the 3D surfaces): \`p <- readRDS("x.rds"); print(p)\`
or restyle it with ggplot2 (\`p + theme(...)\`).

## Synergy models

Scores are in % inhibition points: the observed inhibition minus the inhibition expected from the
single drugs by the reference model. Positive = synergy, negative = antagonism, around 0 = additive.
As a rule of thumb from the SynergyFinder authors, a mean score above 10 suggests synergy and below
−10 antagonism; between, the interaction is likely additive.

- **ZIP** (zero interaction potency): Yadav B, Wennerberg K, Aittokallio T, Tang J. Searching for drug
  synergy in complex dose-response landscapes using an interaction potency model. *Comput Struct
  Biotechnol J* 2015;13:504–513.
- **Bliss** independence: Bliss CI. The toxicity of poisons applied jointly. *Ann Appl Biol*
  1939;26:585–615.
- **Loewe** additivity: Loewe S. The problem of synergism and antagonism of combined drugs.
  *Arzneimittelforschung* 1953;3:285–290.
- **HSA** (highest single agent): Berenbaum MC. What is synergy? *Pharmacol Rev* 1989;41:93–141.
- **CSS** / **RI**: Malyutina A, Majumder MM, Wang W, Pessia A, Heckman CA, Tang J. Drug combination
  sensitivity scoring facilitates the discovery of synergistic and efficacious drug combinations in
  cancer. *PLoS Comput Biol* 2019;15:e1006752.

## Cite

Ianevski A, Giri AK, Aittokallio T. SynergyFinder 3.0: an interactive analysis and consensus
interpretation of multi-drug synergies across multiple samples. *Nucleic Acids Res*
2022;50(W1):W739–W743. doi:10.1093/nar/gkac382

Zheng S, Wang W, Aldahdooh J, et al. SynergyFinder Plus: toward better interpretation and annotation of
drug combination screening datasets. *Genomics Proteomics Bioinformatics* 2022;20(3):587–596.
doi:10.1016/j.gpb.2022.01.004
`;
}

/** A title as the body of an R double-quoted string: one line, \ and " escaped. */
const rTitle = (t) => t.replace(/[\r\n\t]+/g, ' ').replace(/["\\]/g, (c) => `\\${c}`);

/**
 * Complete SynergyFinder data package.
 * @param opts { title, appVersion, generatedAt (Date | ISO string; default now) }
 * @returns {{ files: { path: string, text: string }[] }} — paths relative to the package root, all text.
 */
export function synergyPackage(result, protocol, meta, opts = {}) {
  const table = synergyFinderTable(result, protocol, meta);
  const blocks = table._blocks;
  const title = (opts.title || meta.experiment?.title || 'Drug combination screen').trim();
  const generatedAt = (opts.generatedAt ? new Date(opts.generatedAt) : new Date()).toISOString();
  const files = [
    { path: 'data/synergyfinder_input.csv', text: toCsv(SF_COLUMNS, table.rows) },
    { path: 'data/block_map.csv', text: toCsv(BLOCK_MAP_COLUMNS, table.blocks) },
    { path: 'data/wells_annotated.csv', text: wellsAnnotated(result, blocks) },
    { path: 'analysis.R', text: ANALYSIS_R.replace('__TITLE__', () => rTitle(title)) },
    { path: 'README.md', text: readme({ title, meta, blocks, warnings: [...result.warnings, ...table.warnings], generatedAt, appVersion: opts.appVersion }) },
    { path: 'environment.yml', text: ENVIRONMENT_YML },
  ];
  return { files };
}
