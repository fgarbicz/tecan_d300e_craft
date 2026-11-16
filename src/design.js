// Spec → protocol, experiment layer and a bench plan. This is the programmable front door used by the CLI
// (bin/d300craft) and by Claude: one JSON description of an experiment becomes a D300e protocol (.tdd), the
// experiment file (.craft.json) and a plan covering what to prepare, which cassettes to load with how much,
// how to seed the cells, and every warning the dispense engine raises.
//
// Spec (all concentrations as strings with units, e.g. "10 mM", "0.02 µM", "50 nM"):
// {
//   "name": "MM synergy",
//   "plate":  { "type": "384", "wellVolumeUL": 50, "dmsoLimitPct": 1, "border": 1, "replicates": 3, "scrap": true, "shake": false,
//               "dilutedStocks": true,          // add "Drug - 1:N" stocks when a series goes below one drop (D300e shift/extend)
//               "randomize": false | "cellLine", "randomSeed": 1 },  // shuffle well positions within each cell line
//   "drugs":  [ { "name": "Bortezomib", "stock": "1 mM", "class": "DMSO", "mw": 384.24, "unit": "nM" }, … ],
//               // "unit": the unit this drug's doses are shown in (plan, app, Excel); default µM (ng/mL for mass stocks)
//   "design": { "primary":  { "drug": "Bortezomib", "top": "0.02 µM", "dilution": "1:1.4", "levels": 10, "replicates": 2, "zero": true },
//               // or a range: { "drug": "X", "top": "10 µM", "bottom": "0.1 nM", "levels": 10 } → evenly spaced on a log scale
//               "partners": [ { "drug": "MEN", "top": "3 µM", "dilution": "1:2", "levels": 6, "replicates": 2, "zero": true,
//                               "normalize": "block" | "plate" | "none" }, … ] },          // partner "drug": null = single drug
//   "cells":  { "lines": ["MM.1S"], "arrangement": "same" | "perLine" | "splitRows" | "splitCols" | "none",
//               "cellsPerWell": 2000, "seedingVolumeUL": 50, "overagePct": 15 },
//   "pbsVolumeUL": 50
// }

import { newProtocol, writeTdd, wellName, parseTdd } from './tdd.js';
import { addFluid, parseDilution, PLATE_TYPES } from './ops.js';
import { computeProtocol, primingIssues, MOLARITY_UNITS, MASS_UNITS, fromDisplay, FLUID_CLASSES, unitLabel } from './dispense.js';
import { buildExperiment, applyExperiment, newMeta, addCellLine, seedBlocks, serializeMeta, wellRole, resolveStocks, randomizeByCellLine, seededRng, rangeStep } from './experiment.js';

import { planRun } from './cassette.js';
import { setDrugUnit, drugUnit, unitOfFn } from './units.js';
import { doseLevels, scrapTest } from './dosemap.js';

const UNIT_ALIASES = { um: 'µM', 'μm': 'µM', 'µm': 'µM', mm: 'mM', nm: 'nM', pm: 'pM', m: 'M', 'mg/ml': 'mg_mL', 'ug/ml': 'µg_mL', 'µg/ml': 'µg_mL', 'ng/ml': 'ng_mL', 'pg/ml': 'pg_mL' };
/** "10 mM" → { value: 10, unit: 'mM' } (units as in dispense.js). */
export function parseAmount(text, what = 'concentration') {
  const m = String(text ?? '').trim().replace(',', '.').match(/^([0-9]*\.?[0-9]+(?:e[-+]?\d+)?)\s*([a-zA-Zµμ/_]+)$/);
  if (!m) throw new Error(`Could not read the ${what} "${text}" (write e.g. "10 mM" or "0.5 µM")`);
  const raw = m[2].replace('_', '/'), unit = UNIT_ALIASES[raw.toLowerCase()] || raw;
  if (!(unit in MOLARITY_UNITS) && !(unit in MASS_UNITS)) throw new Error(`Unknown unit "${m[2]}" in "${text}" (use M, mM, µM, nM, pM, mg/mL, µg/mL, ng/mL)`);
  return { value: +m[1], unit };
}
/** Value in the protocol's base unit (µM for molar, ng/mL for mass). */
const toBase = (a) => fromDisplay(a.value, a.unit);

const CLASS_BY_NAME = Object.fromEntries(Object.entries(FLUID_CLASSES).flatMap(([id, c]) => [[c.short.toLowerCase(), +id], [c.label.toLowerCase(), +id], [c.key, +id]]));
const PLATE_BY_NAME = { 48: 'Default48', 96: 'Default96', 384: 'Default384', 1536: 'Default1536' };
const NORM = { block: { type: 'ToMaxVolume', scope: 'block' }, plate: { type: 'ToAssayVolumePct', scope: 'plate' }, none: null };

/** Build protocol + meta from a spec. Throws with a clear message on anything ambiguous. */
export function designExperiment(spec) {
  const pl = spec.plate || {};
  const plateType = PLATE_BY_NAME[String(pl.type ?? 384).replace(/\D/g, '')] || pl.type;
  if (!PLATE_TYPES[plateType]) throw new Error(`Unknown plate type "${pl.type}" (48, 96, 384 or 1536)`);
  const dmsoLimit = (pl.dmsoLimitPct ?? 1) / 100, assay = (pl.wellVolumeUL ?? 50) * 1000, border = pl.border ?? 1;
  const protocol = newProtocol();
  const meta = newMeta(protocol);
  meta.experiment.title = spec.name || '';
  meta.settings.borderPBS = border > 0; meta.settings.borderDepth = border || 1;
  const drugs = new Map();
  for (const d of spec.drugs || []) {
    if (!d.name) throw new Error('Every drug needs a name');
    const st = parseAmount(d.stock, `stock of ${d.name}`);
    const classId = d.class == null ? 0 : CLASS_BY_NAME[String(d.class).toLowerCase()];
    if (classId == null) throw new Error(`Unknown fluid class "${d.class}" for ${d.name} (DMSO, a+Tw, a+B, a+TX, a+Tw+g, …)`);
    const f = addFluid(protocol, { name: d.name, concentration: toBase(st), concentrationUnit: st.unit, classId });
    if (d.unit != null) {
      const raw = String(d.unit).trim().replace('_', '/'), u = UNIT_ALIASES[raw.toLowerCase()] || raw;
      try { setDrugUnit(meta, protocol, f, u); } catch { throw new Error(`Unit "${d.unit}" cannot be used for ${d.name} (stock in ${unitLabel(st.unit)}): use ${st.unit in MOLARITY_UNITS ? 'M, mM, µM, nM or pM' : 'mg/mL, µg/mL, ng/mL or pg/mL'}`); }
    }
    drugs.set(d.name, { fluid: f, mw: d.mw ?? null, stock: st });
  }
  const fluidOf = (name) => { if (name == null) return null; const x = drugs.get(name); if (!x) throw new Error(`Drug "${name}" is used in the design but not listed under drugs`); return x.fluid.id; };
  const axis = (a, single) => {
    if (single) return { fluidId: null, high: 1, factor: 2, levels: 0, includeZero: true, replicates: Math.max(1, a.replicates ?? 1) };
    const top = parseAmount(a.top, `top concentration of ${a.drug}`);
    const bottom = a.bottom ?? a.lowest;
    if (bottom != null && a.dilution != null) throw new Error(`${a.drug}: give either "dilution" or "bottom", not both`);
    const levels = a.levels ?? 8;
    if (bottom != null) {
      const low = toBase(parseAmount(bottom, `bottom concentration of ${a.drug}`));
      if (!(low < toBase(top))) throw new Error(`${a.drug}: bottom (${bottom}) must be below top (${a.top})`);
      if (levels < 2) throw new Error(`${a.drug}: a top–bottom range needs at least 2 levels`);
      return { fluidId: fluidOf(a.drug), high: toBase(top), low, factor: rangeStep(toBase(top), low, levels), levels, includeZero: a.zero ?? true, replicates: Math.max(1, a.replicates ?? 1) };
    }
    return { fluidId: fluidOf(a.drug), high: toBase(top), factor: parseDilution(a.dilution ?? '1:3').factor, levels, includeZero: a.zero ?? true, replicates: Math.max(1, a.replicates ?? 1) };
  };
  const D = spec.design || {};
  if (!D.primary) throw new Error('design.primary is required');
  const partners = (D.partners && D.partners.length ? D.partners : [{ drug: null, replicates: D.primary.rowReplicates ?? 3 }]).map((p) => ({
    ...axis(p, p.drug == null), normalization: p.drug == null && !D.normalize ? null : NORM[p.normalize ?? D.normalize ?? 'block'] && { ...NORM[p.normalize ?? D.normalize ?? 'block'], param: (p.normalize ?? D.normalize) === 'plate' ? dmsoLimit : undefined },
  }));
  const cells = spec.cells || {};
  const arrangement = cells.arrangement || 'same';
  const split = arrangement === 'splitRows' ? 'rows' : arrangement === 'splitCols' ? 'cols' : null;
  const bspec = {
    plate: { plateType, assayVolume: assay, dmsoLimit, dontShake: !(pl.shake ?? false) },
    border, plateReplicates: pl.replicates ?? 3, scrap: pl.scrap ?? true, split,
    primary: axis(D.primary, false), partners,
  };
  const lines = (cells.lines || []).map((n) => addCellLine(meta, n));
  const sets = arrangement === 'perLine' && lines.length ? lines.map((l) => [l])
    : split ? (lines.length ? Array.from({ length: Math.ceil(lines.length / 2) }, (_, i) => lines.slice(2 * i, 2 * i + 2)) : [[]])
    : arrangement === 'none' || !lines.length ? [[]] : [[lines[0]]];
  if (arrangement === 'same' && lines.length > 1) throw new Error(`arrangement "same" puts one cell line on every plate, but ${lines.length} were given: use "perLine", "splitRows" or "splitCols"`);
  const stockNotes = pl.dilutedStocks === false ? [] : resolveStocks(protocol, bspec);
  for (const set of sets) {
    const built = buildExperiment(bspec, protocol.fluids);
    applyExperiment(protocol, meta, built);
    seedBlocks(meta, protocol, meta.blocks.slice(-built.blocks.length), set);
    for (const bl of meta.blocks.slice(-built.blocks.length)) bl.cellLine = set.map((c) => c.name).join(' / ');
  }
  if (pl.randomize) {
    if (pl.randomize !== 'cellLine' && pl.randomize !== true) throw new Error(`plate.randomize must be "cellLine" (or false), not "${pl.randomize}"`);
    if (!lines.length) throw new Error('plate.randomize "cellLine" needs cells.lines (wells are shuffled within each cell line)');
    const seed = pl.randomSeed ?? 1;
    randomizeByCellLine(protocol, meta, protocol.plates.map((_, i) => i), seededRng(seed));
    meta.experiment.randomSeed = seed;
  }
  meta.experiment.stockNotes = stockNotes;
  return { protocol, meta, spec, stockNotes };
}

const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const fmtConc = (v) => (v >= 100 ? v.toFixed(0) : v >= 1 ? +v.toPrecision(3) : +v.toPrecision(3)).toString();

/** Everything needed at the bench, from a protocol + meta (any source: designed, opened, edited). */
export function makePlan(protocol, meta, spec = {}) {
  const computed = computeProtocol(protocol);
  const run = planRun(protocol, computed);
  const unitOf = unitOfFn(meta, protocol);
  const axisUnit = (id) => { const f = protocol.fluids.find((x) => x.id === id); return f ? drugUnit(meta, protocol, f) : null; };
  const inUnit = (v, u) => (u ? fromDisplay(v, 'µM') / fromDisplay(1, u) : v); // base → display unit
  const issues = []; let maxDmso = 0, maxDmsoScrap = 0;
  const vehicleDmso = new Map(); // block name → DMSO % of its vehicle (0/0) wells
  computed.forEach(({ wells }, pi) => { for (const [k, w] of wells) {
    const scrap = meta.plates[pi]?.roles[k] === 'scrap';
    if (Number.isFinite(w.dmsoFraction)) { if (scrap) maxDmsoScrap = Math.max(maxDmsoScrap, w.dmsoFraction); else maxDmso = Math.max(maxDmso, w.dmsoFraction); } for (const x of w.warnings) issues.push({ plate: pi + 1, well: wellName(...k.split(',').map(Number)), code: x.code, fluid: x.fluidId != null ? protocol.fluids.find((f) => f.id === x.fluidId)?.name : null }); } });
  const priming = primingIssues(protocol, computed).filter((x) => x.lacking.length).map((x) => ({ plate: x.plate + 1, fluids: x.lacking.map((l) => protocol.fluids.find((f) => f.id === l.fluidId)?.name) }));
  const mwOf = new Map((spec.drugs || []).map((d) => [d.name, d.mw ?? null]));
  // drugs to prepare: what the cassette heads take, plus a pipetting margin
  const prepare = run.fluids.map((f) => {
    const fl = f.fluidId != null ? protocol.fluids.find((x) => x.id === f.fluidId) : null;
    const prep = Math.ceil((f.load * 1.1 + 2) * 2) / 2; // +10 % +2 µL, to 0.5 µL
    const stock = fl ? `${fmtConc(fl.concentration / (MOLARITY_UNITS[fl.concentrationUnit] || MASS_UNITS[fl.concentrationUnit] || 1))} ${unitLabel(fl.concentrationUnit)}` : 'pure DMSO';
    const root = fl && fl.rootFluidId != null ? protocol.fluids.find((x) => x.id === fl.rootFluidId) : null;
    const mw = fl ? mwOf.get(root ? root.name : fl.name) : null;
    const molar = fl && fl.concentrationUnit in MOLARITY_UNITS;
    const massMg = mw && molar ? (fl.concentration * 1e-6) * 1e-3 * mw * 1e3 : null; // powder for 1 mL of stock: µM→M × 1 mL × g/mol → mg
    // a diluted stock (shift/extend) is made from its root stock: 1 part stock + (N − 1) parts DMSO / solvent
    // pipette at least 1 µL of stock (to 0.5 µL), however little of the dilution the heads need
    const stockPart = fl && fl.dilutionFactor ? Math.max(1, Math.ceil((prep / fl.dilutionFactor) * 2) / 2) : 0;
    const dilution = root && fl.dilutionFactor ? { from: root.name, factor: fl.dilutionFactor, stockUL: stockPart, solventUL: +(stockPart * (fl.dilutionFactor - 1)).toPrecision(4),
      levels: (meta.experiment?.stockNotes || []).filter((n) => n.fluid === fl.name).flatMap((n) => n.levels).map((v) => inUnit(v, unitOf(fl))), unit: unitLabel(unitOf(fl)) } : null;
    return { name: f.name, stock, dispensedUL: round(f.dispensed, 2), loadUL: round(f.load, 1), heads: f.heads.length, prepareUL: prep, massMg: root ? null : massMg != null ? +massMg.toPrecision(3) : null, dilution };
  });
  // cells
  const c = spec.cells || {};
  const seedUL = c.seedingVolumeUL ?? (protocol.plates[0]?.assayVolume ?? 50000) / 1000, over = (c.overagePct ?? 15) / 100;
  const wellsPerLine = new Map();
  meta.plates.forEach((pm) => { for (const id of Object.values(pm.cellLines)) wellsPerLine.set(id, (wellsPerLine.get(id) || 0) + 1); });
  const seeding = meta.cellLines.map((cl) => {
    const wells = wellsPerLine.get(cl.id) || 0;
    const plates = meta.plates.map((pm, i) => (Object.values(pm.cellLines).includes(cl.id) ? i + 1 : null)).filter(Boolean);
    const out = { cellLine: cl.name, plates, wells, seedingVolumeUL: seedUL, suspensionML: round((wells * seedUL * (1 + over)) / 1000, 2) };
    if (c.cellsPerWell) { const perML = Math.round((c.cellsPerWell / seedUL) * 1000); Object.assign(out, { cellsPerWell: c.cellsPerWell, cellsPerML: perML, totalCells: Math.round(perML * out.suspensionML) }); }
    return out;
  });
  let pbsWells = 0, unused = 0;
  protocol.plates.forEach((p, i) => { for (let r = 0; r < p.rows; r++) for (let col = 0; col < p.cols; col++) { const role = wellRole(meta, p, i, r, col); if (role === 'pbs') pbsWells++; else if (role === 'empty') unused++; } });
  const pbsUL = spec.pbsVolumeUL ?? seedUL;
  const plates = protocol.plates.map((p, i) => ({ plate: i + 1, type: PLATE_TYPES[p.plateType]?.label || p.plateType, wellVolumeUL: p.assayVolume / 1000, dmsoLimitPct: p.dmsoLimit * 100,
    cellLines: [...new Set(Object.values(meta.plates[i]?.cellLines || {}))].map((id) => meta.cellLines.find((x) => x.id === id)?.name),
    block: (meta.blocks || []).find((b) => b.plates.includes(i))?.name || null,
    scrapWells: Object.entries(meta.plates[i]?.roles || {}).filter(([, r]) => r === 'scrap').map(([k]) => wellName(...k.split(',').map(Number))) }));
  const byCode = {}; for (const x of issues) (byCode[x.code] ||= []).push(x);
  return {
    name: meta.experiment.title || spec.name || '',
    plates, blocks: (meta.blocks || []).map((b) => ({ name: b.name, cellLine: b.cellLine || null, plates: b.plates.map((p) => p + 1),
      region: b.copies ? b.copies.map((r) => `${wellName(r.r0, r.c0)}–${wellName(r.r0 + r.rows - 1, r.c0 + r.cols - 1)}`) : [], primaryLevels: (b.primaryLevels || []).map((v) => inUnit(v, axisUnit(b.primary))), partnerLevels: (b.partnerLevels || []).map((v) => inUnit(v, axisUnit(b.partner))),
      primaryUnit: axisUnit(b.primary) ? unitLabel(axisUnit(b.primary)) : null, partnerUnit: axisUnit(b.partner) ? unitLabel(axisUnit(b.partner)) : null })),
    prepare, cassettes: run.cassettes.map((c2) => ({ index: c2.index, type: c2.type, heads: c2.heads.map((h) => ({ head: h.head, fluid: h.name, stock: prepare.find((x) => x.name === h.name)?.stock || '', dispensedUL: round(h.dispensed, 3), loadUL: h.load })) })),
    seeding, pbs: { wells: pbsWells, volumePerWellUL: pbsUL, totalML: round((pbsWells * pbsUL * 1.1) / 1000, 2) },
    maxDmsoPct: round(maxDmso * 100, 4), maxDmsoScrapPct: round(maxDmsoScrap * 100, 4), unusedInnerWells: unused,
    vehicleDmsoPct: vehicleDmsoByBlock(protocol, meta, computed),
    doses: doseLevels(protocol, { skip: scrapTest(protocol, meta, wellRole), unitOf }),
    stockNotes: meta.experiment?.stockNotes || [],
    randomized: protocol.plates.map((p, i) => (p.randomization?.length ? i + 1 : null)).filter(Boolean),
    warnings: Object.entries(byCode).map(([code, list]) => ({ code, count: list.length, examples: list.slice(0, 8).map((x) => `P${x.plate} ${x.well}${x.fluid ? ' ' + x.fluid : ''}`) })),
    priming,
  };
}

const fmtLevel = (v) => (v === 0 ? '0' : +v.toPrecision(3) + '');
function vehicleDmsoByBlock(protocol, meta, computed) {
  const out = {};
  for (const b of meta.blocks || []) {
    let v = null;
    for (const pi of b.plates) for (const reg of b.copies || [b.region]) for (let r = reg.r0; r < reg.r0 + reg.rows; r++) for (let c = reg.c0; c < reg.c0 + reg.cols; c++) {
      const m = protocol.plates[pi].wells.get(`${r},${c}`); if (m && m.size) continue;
      const w = computed[pi].wells.get(`${r},${c}`); if (w && Number.isFinite(w.dmsoFraction)) v = Math.max(v ?? 0, w.dmsoFraction);
    }
    out[b.name] = v == null ? 0 : round(v * 100, 4);
  }
  return out;
}

const WARN_TEXT = { dmso_limit: 'DMSO above the plate limit', below_min_volume: 'below the smallest drop (lower top concentration or use a diluted stock)', above_max_volume: 'above 10 µL per fluid per well', no_solution: 'concentrations cannot be reached', above_stock: 'requested ≥ stock concentration' };

/** The plan as Markdown, for people (and for Claude to show). */
export function planMarkdown(plan, { files = [] } = {}) {
  const L = [];
  L.push(`# ${plan.name || 'D300e experiment'} — plan`, '');
  L.push(`**${plan.plates.length} plate${plan.plates.length > 1 ? 's' : ''}** · highest DMSO in assay wells ${plan.maxDmsoPct} %${plan.maxDmsoScrapPct ? ` (priming wells ${plan.maxDmsoScrapPct} %)` : ''} · ${plan.cassettes.length} cassette${plan.cassettes.length > 1 ? 's' : ''} (${[...new Set(plan.cassettes.map((c) => c.type))].map((t) => `${plan.cassettes.filter((c) => c.type === t).length} × ${t}`).join(', ')})`, '');
  if (plan.warnings.length || plan.priming.length) {
    L.push('## ⚠ Check before printing', '');
    for (const w of plan.warnings) L.push(`- ${w.count} well${w.count > 1 ? 's' : ''}: ${WARN_TEXT[w.code] || w.code} (${w.examples.join(', ')}${w.count > w.examples.length ? ', …' : ''})`);
    for (const p of plan.priming) L.push(`- Plate ${p.plate}: no well with ≥ 30 nL of ${p.fluids.join(', ')} (add a scrap well)`);
    L.push('');
  } else L.push('✓ No dispense warnings: every well is within the DMSO limit and above the smallest drop.', '');
  for (const n of plan.stockNotes || []) if (n.kind === 'impossible') L.push(`⚠ ${n.drug}: ${n.levels.length} level(s) stay below one drop even with a 1:9000 dilution (${n.levels.map(fmtLevel).join(', ')}); they are flagged. Use a lower stock.`, '');
  if (plan.randomized && plan.randomized.length) L.push(`Plate${plan.randomized.length > 1 ? 's' : ''} ${plan.randomized.join(', ')} ${plan.randomized.length > 1 ? 'are' : 'is'} **randomized within each cell line**: the D300e dispenses each design well into another well of the same cell line (stored in the .tdd). Paste readouts as read from the plate; Tecan D300 Craft maps them back. Do not re-randomize in D300e Control (it would mix the cell lines).`, '');
  L.push('## Layout', '', '| Plates | Design | Cell line(s) | Grid |', '|---|---|---|---|');
  for (const b of plan.blocks) L.push(`| ${b.plates.join(', ')} | ${b.name} | ${b.cellLine || '–'} | ${b.region.join(' and ')} |`);
  for (const b of plan.blocks) {
    const [pa, pb] = b.name.split(' × ');
    L.push('', `**${b.name}** (plates ${b.plates.join(', ')}): ${pa} along the columns ${b.primaryLevels.map(fmtLevel).join(', ')} ${b.primaryUnit || 'µM'}` + (pb ? `; ${pb} along the rows ${b.partnerLevels.map(fmtLevel).join(', ')} ${b.partnerUnit || 'µM'}` : '') + ` (replicates in adjacent wells). Vehicle DMSO ${plan.vehicleDmsoPct[b.name] ?? '–'} %.`);
  }
  const vd = [...new Set(Object.values(plan.vehicleDmsoPct))];
  if (vd.length > 1) L.push('', `⚠ The plate sets have different vehicle DMSO (${vd.join(' vs ')} %): compare viabilities within a set, or normalize all sets to the same DMSO.`);
  L.push('', 'Outer row/column = PBS (evaporation barrier) unless noted; scrap (priming) wells: ' + ([...new Set(plan.plates.flatMap((p) => p.scrapWells))].join(', ') || 'none') + '.'
    + (plan.unusedInnerWells ? ` ${plan.unusedInnerWells} inner wells are not part of a grid: no cells, fill with medium.` : ''), '');
  if (plan.doses && plan.doses.length) {
    const svg = files.find((f) => /_dosemap\.svg$/.test(f));
    L.push('## Dose gradients', '', `Concentrations per drug (scrap wells left out)${svg ? `; colour map of every plate: \`${svg.split(/[\\/]/).pop()}\`` : ''}.`, '', '| Drug | Levels | Range | Fold | Plates |', '|---|---|---|---|---|');
    for (const d of plan.doses) L.push(`| ${d.drug} | ${d.levels.length}: ${d.levels.map(fmtLevel).join(', ')} | ${fmtLevel(d.min)}–${fmtLevel(d.max)} ${d.unit} | ${d.foldRange}× | ${d.plates.join(', ')} |`);
    L.push('');
  }
  L.push('## 1. Prepare the drug stocks', '', '| Drug | Stock | Dispensed | Load into heads | Prepare | Powder per 1 mL stock |', '|---|---|---|---|---|---|');
  for (const d of plan.prepare) L.push(`| ${d.name} | ${d.stock} | ${d.dispensedUL} µL | ${d.loadUL.toFixed(1)} µL (${d.heads} head${d.heads > 1 ? 's' : ''}) | **${d.prepareUL} µL**${d.dilution ? ` (mix ${d.dilution.stockUL} µL ${d.dilution.from} stock + ${d.dilution.solventUL} µL solvent = 1:${d.dilution.factor})` : ''} | ${d.massMg == null ? '–' : d.massMg < 0.1 ? +(d.massMg * 1000).toPrecision(3) + ' µg' : d.massMg + ' mg'} |`);
  const dil = plan.prepare.filter((d) => d.dilution);
  if (dil.length) L.push('', `Diluted stocks (D300e "fluid shift / extend"): ${dil.map((d) => `**${d.name}** = ${d.dilution.from} 1:${d.dilution.factor}${d.dilution.levels.length ? ` (dispenses ${d.dilution.levels.map(fmtLevel).join(', ')} ${d.dilution.unit})` : ''}`).join('; ')}. These levels need less than one drop (13 pL for DMSO) of the original stock, so the D300e dispenses them from a second, diluted stock in its own dispense head. Make it in the same solvent as the stock (DMSO for DMSO stocks).`);
  L.push('', '"Dispensed" includes the priming (scrap) wells. "Prepare" = what the heads take + 10 % + 2 µL for pipetting; take it from your stock. "Powder per 1 mL" only if you make the stock fresh (needs a molecular weight).', '');
  L.push('## 2. Seed the cells', '');
  if (plan.seeding.length) {
    L.push('| Cell line | Plates | Wells | Cells/well | Density | Suspension (+overage) | Total cells |', '|---|---|---|---|---|---|---|');
    for (const s of plan.seeding) L.push(`| ${s.cellLine} | ${s.plates.join(', ')} | ${s.wells} | ${s.cellsPerWell ?? '?'} | ${s.cellsPerML ? s.cellsPerML.toLocaleString('en-US') + ' /mL' : '?'} | ${s.suspensionML} mL of ${s.seedingVolumeUL} µL/well | ${s.totalCells ? s.totalCells.toLocaleString('en-US') : '?'} |`);
  } else L.push('No cell lines given.');
  L.push('', `PBS / medium in the border: ${plan.pbs.wells} wells × ${plan.pbs.volumePerWellUL} µL ≈ ${plan.pbs.totalML} mL (+10 %).`, '');
  const lsvg = files.find((f) => /_loading\.svg$/.test(f));
  L.push('## 3. Load the D300e', '', `Open the .tdd in D300e Control, Run. Fill each head with the bold volume (D300e shows the same numbers on its fill screen).${lsvg ? ` Drawing of the cassettes: \`${lsvg.split(/[\\/]/).pop()}\`.` : ''}`, '');
  for (const c of plan.cassettes) {
    L.push(`**Cassette ${c.index} · ${c.type}**`, '', '| Head | Solution | Concentration | Load |', '|---|---|---|---|');
    for (const h of c.heads) L.push(`| ${h.head} | ${h.fluid} | ${h.stock || '–'} | **${c.type === 'D4+' ? h.loadUL : h.loadUL.toFixed(1)} µL** |`);
    L.push('');
  }
  L.push('## 4. After the incubation', '', 'Read the plates (e.g. CellTiter-Glo), open the protocol in Tecan D300 Craft, paste each plate\'s values in Results, and export Excel / the SynergyFinder package.', '');
  if (files.length) { L.push('## Files', ''); for (const f of files) L.push(`- \`${f}\``); L.push(''); }
  return L.join('\n');
}

/** Convenience: spec → { tdd text, sidecar text, plan, markdown }. */
export function designAndPlan(spec, baseName = 'experiment') {
  const { protocol, meta } = designExperiment(spec);
  const tdd = writeTdd(protocol);
  // fingerprint the protocol as written (13 significant digits), so reopening the files is not "stale"
  const sidecar = serializeMeta(meta, parseTdd(tdd), `${baseName}.tdd`);
  const plan = makePlan(protocol, meta, spec);
  return { protocol, meta, tdd, sidecar, plan };
}
