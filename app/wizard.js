// Experiment wizard: five steps from "what plates" to "create". Keeps its own state (W) and only touches the
// document once, on Create (one undo step). The layout itself comes from buildExperiment() in
// src/experiment.js, which is tested to rebuild the hand-made D3 protocol byte for byte.

import { newProtocol, wellKey } from '../src/tdd.js';
import { PLATE_TYPES, addFluid, titrationLevels, parseDilution } from '../src/ops.js';
import { computeProtocol, validRange, FLUID_CLASSES, MOLARITY_UNITS, MASS_UNITS, unitLabel, fromDisplay, toDisplay } from '../src/dispense.js';
import { buildExperiment, applyExperiment, newMeta, addCellLine, seedBlocks, isBorder, axisLevels, rangeStep, resolveStocks, randomizeByCellLine, seededRng } from '../src/experiment.js';
import { suggestShift, extendThreshold } from '../src/ops.js';
import { planRun } from '../src/cassette.js';
import { drugUnit, unitsFor, setDrugUnit } from '../src/units.js';
import { cassetteSvg, levelStripSvg, plateSvg, plateStackSvg, fluidLook, THEME_VARS, shortNum } from '../src/draw.js';
import { icon } from './icons.js';

const STEPS = ['Plates', 'Drugs', 'Layout', 'Cell lines', 'Review'];
const NORM = {
  block: { label: 'Same DMSO in every well (recommended)', nz: { type: 'ToMaxVolume', scope: 'block' } },
  plate: { label: 'Every well up to the DMSO limit', nz: { type: 'ToAssayVolumePct', param: 0.01, scope: 'plate' } },
  none: { label: 'No top-up', nz: null },
};
let W = null;

function defaults(S) {
  const cur = S.protocol.plates[0];
  const empty = !S.protocol.plates.some((p) => p.wells.size) && !S.protocol.fluids.length;
  let last = null; try { last = JSON.parse(localStorage.getItem('d300.wizard') || 'null'); } catch { /* none */ }
  const drugs = S.protocol.fluids.filter((f) => !f.byVol && f.rootFluidId == null).map((f) => ({ existingId: f.id, name: f.name, stock: +toDisplay(f.concentration, f.concentrationUnit).toPrecision(10), unit: f.concentrationUnit, classId: f.classId, doseUnit: drugUnit(S.meta, S.protocol, f) }));
  return {
    step: 0, target: empty ? 'replace' : 'append',
    plateType: last?.plateType || cur?.plateType || 'Default384', assayUL: last?.assayUL ?? (cur ? cur.assayVolume / 1000 : 50), dmsoPct: last?.dmsoPct ?? (cur ? cur.dmsoLimit * 100 : 1),
    border: last?.border ?? (S.meta.settings.borderPBS ? S.meta.settings.borderDepth || 1 : 1), reps: last?.reps ?? 3, scrap: true, dontShake: last?.dontShake ?? true,
    dilutedStocks: last?.dilutedStocks ?? true, randomize: false, seed: Math.floor(Math.random() * 1e9),
    drugs: drugs.length ? drugs : [{ name: '', stock: 10, unit: 'mM', classId: 0 }, { name: '', stock: 10, unit: 'mM', classId: 0 }],
    primary: { drug: 0, high: '', low: '', factor: 3, levels: 8, zero: true, reps: 2 },
    partners: [{ drug: drugs.length > 1 ? 1 : 1, high: '', low: '', factor: 2, levels: 6, zero: true, reps: 2, norm: 'block' }],
    cellLines: S.meta.cellLines.map((c) => c.name).join(', '), cellMode: 'same',
  };
}

export function openWizard(ctx) {
  W = defaults(ctx.S);
  const d = document.getElementById('wiz');
  d.innerHTML = `<div class="wz-head">${icon('wizard', 20)}<h2>Experiment wizard</h2><div class="wz-steps" id="wzSteps"></div><button class="small icon-only" id="wzClose" title="Close">${icon('x', 15)}</button></div>
    <div class="wz-body" id="wzBody"></div>
    <div class="wz-foot"><span id="wzNote" class="muted"></span><span class="spacer"></span><button id="wzBack">${icon('prev', 15)} Back</button><button id="wzNext" class="primary">Next ${icon('next', 15)}</button></div>`;
  d.showModal();
  document.getElementById('wzClose').onclick = () => d.close();
  document.getElementById('wzBack').onclick = () => { save(); if (W.step > 0) { W.step--; draw(ctx); } };
  document.getElementById('wzNext').onclick = () => {
    save();
    const err = validate(ctx);
    if (err) { note(err, true); return; }
    if (W.step < STEPS.length - 1) { W.step++; draw(ctx); } else create(ctx);
  };
  draw(ctx);
}

const $w = (id) => document.getElementById(id);
const note = (t, bad = false) => { const n = $w('wzNote'); n.textContent = t || ''; n.style.color = bad ? 'var(--danger)' : ''; };
const unitOpts = (sel) => [...Object.keys(MOLARITY_UNITS), ...Object.keys(MASS_UNITS)].map((u) => `<option value="${u}" ${u === sel ? 'selected' : ''}>${unitLabel(u)}</option>`).join('');
const drugOpts = (sel, withNone = false) => (withNone ? `<option value="-1" ${sel === -1 ? 'selected' : ''}>— none (single drug) —</option>` : '') + W.drugs.map((x, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${x.name || `Drug ${i + 1}`}</option>`).join('');
const dims = () => PLATE_TYPES[W.plateType];
/** Unit in which a drug's doses are typed and shown (same kind as its stock; default µM or ng/mL). */
function doseUnit(x) {
  const ok = x ? unitsFor({ concentrationUnit: x.unit, byVol: false }) : Object.keys(MOLARITY_UNITS);
  if (x && (!x.doseUnit || !ok.includes(x.doseUnit))) x.doseUnit = x.unit in MASS_UNITS ? 'ng_mL' : 'µM';
  return x ? x.doseUnit : 'µM';
}
const unitOfAxis = (o) => doseUnit(W.drugs[o.drug]);
const toBase = (o, v) => fromDisplay(+v, unitOfAxis(o));
const pic = (svg, cls = '') => `<div class="drawing ${cls}">${svg}</div>`;

function draw(ctx) {
  const { esc } = ctx;
  $w('wzSteps').innerHTML = STEPS.map((s, i) => `<span class="${i === W.step ? 'on' : i < W.step ? 'done' : ''}">${i + 1}. ${s}</span>`).join('');
  $w('wzBack').disabled = W.step === 0;
  $w('wzNext').innerHTML = W.step === STEPS.length - 1 ? `${icon('check', 15)} Create ${W.target === 'replace' ? 'protocol' : 'plates'}` : `Next ${icon('next', 15)}`;
  note('');
  const b = $w('wzBody');
  b.oninput = null; b.onchange = null;
  if (W.step === 0) {
    b.innerHTML = `<div class="wz-split"><div><p>Which plates do you print on? Every layout you design next is repeated on this many identical plates.</p><div class="form">
      <label>Plate</label><select id="w_type">${Object.entries(PLATE_TYPES).map(([k, v]) => `<option value="${k}" ${k === W.plateType ? 'selected' : ''}>${v.label} (${v.rows} × ${v.cols})</option>`).join('')}</select>
      <label title="Medium + cells already in each well">Well volume</label><span><input id="w_assay" type="number" step="any" value="${W.assayUL}"> µL (medium + cells)</span>
      <label>DMSO limit</label><span><input id="w_dmso" type="number" step="any" value="${+(+W.dmsoPct).toPrecision(6)}"> % per well</span>
      <label>PBS border</label><select id="w_border"><option value="0" ${W.border == 0 ? 'selected' : ''}>None</option><option value="1" ${W.border == 1 ? 'selected' : ''}>Outer row/column (recommended)</option><option value="2" ${W.border == 2 ? 'selected' : ''}>Outer 2 rows/columns</option></select>
      <label>Plate replicates</label><span><input id="w_reps" type="number" min="1" max="20" value="${W.reps}"> plates per layout</span>
      <label class="full chk"><input type="checkbox" id="w_scrap" ${W.scrap ? 'checked' : ''}> Add priming ("scrap") wells in the border for drugs dispensed below 30 nL</label>
      <label class="full chk"><input type="checkbox" id="w_shake" ${W.dontShake ? 'checked' : ''}> Don't shake plates</label>
      <label class="full chk" title="D300e 'fluid shift / extend': a series that needs less than one drop of the stock gets a second, diluted stock (Drug - 1:N) in its own dispense head"><input type="checkbox" id="w_dil" ${W.dilutedStocks ? 'checked' : ''}> Add a diluted stock automatically when a series goes below one drop of the stock (like D300e's fluid shift / extend)</label>
      <label>Result</label><select id="w_target"><option value="replace" ${W.target === 'replace' ? 'selected' : ''}>New protocol (replace the current one)</option><option value="append" ${W.target === 'append' ? 'selected' : ''}>Add plates to the current protocol</option></select>
      </div></div><div class="wz-pic"><h4>Your plate</h4><div id="w_platePic"></div><p class="hint" id="w_plateInfo"></p></div></div>`;
    const drawPlate = () => {
      save(); const dm = dims();
      $w('w_platePic').innerHTML = pic(plateSvg({ rows: dm.rows, cols: dm.cols, wells: new Map() }, { colorOf: () => '#888', border: W.border, theme: THEME_VARS }), 'narrow');
      const inR = dm.rows - 2 * W.border, inC = dm.cols - 2 * W.border;
      $w('w_plateInfo').innerHTML = W.border ? `Shaded wells = border: fill them with PBS or medium by hand so the inner wells do not dry out. The D300e does not dispense there (except priming wells). <b>${inR} rows × ${inC} columns</b> = ${inR * inC} wells are left for the experiment.` : `No border: all ${dm.rows * dm.cols} wells are used. Edge wells evaporate faster.`;
    };
    b.oninput = drawPlate; b.onchange = drawPlate; drawPlate();
  } else if (W.step === 1) {
    b.innerHTML = `<p>Which drugs, and how concentrated is each stock, i.e. the tube you pipette into the dispense head?</p>
      <div class="wz-row head"><span>Name</span><span>Stock conc.</span><span>Unit</span><span style="grid-column: span 3">Solvent (fluid class)</span><span></span><span></span></div>
      ${W.drugs.map((x, i) => `<div class="wz-row"><input data-d="name" data-i="${i}" value="${esc(x.name)}" placeholder="e.g. Bortezomib" ${x.existingId != null ? 'title="Already in this protocol"' : ''}>
        <input data-d="stock" data-i="${i}" type="number" step="any" value="${x.stock}"><select data-d="unit" data-i="${i}">${unitOpts(x.unit)}</select>
        <select data-d="classId" data-i="${i}" style="grid-column: span 3">${Object.entries(FLUID_CLASSES).filter(([, c]) => !c.byVolumeOnly).map(([id, c]) => `<option value="${id}" ${+id === x.classId ? 'selected' : ''}>${c.label}</option>`).join('')}</select>
        <span class="muted">${x.existingId != null ? 'in protocol' : 'new'}</span><button class="small icon-only" data-del="${i}" title="Remove">${icon('trash', 14)}</button></div>`).join('')}
      <p><button id="w_addDrug" class="small">${icon('plus', 14)} Add drug</button></p>`;
    $w('w_addDrug').onclick = () => { save(); W.drugs.push({ name: '', stock: 10, unit: 'mM', classId: 0 }); draw(ctx); };
    for (const x of b.querySelectorAll('[data-del]')) x.onclick = () => { save(); W.drugs.splice(+x.dataset.del, 1); W.primary.drug = Math.min(W.primary.drug, W.drugs.length - 1); draw(ctx); };
  } else if (W.step === 2) {
    const dm = dims(), inner = { rows: dm.rows - 2 * W.border, cols: dm.cols - 2 * W.border };
    const axis = (o, prefix, withNone) => `<select data-a="drug" data-p="${prefix}">${drugOpts(o.drug, withNone)}</select>
      <input data-a="high" data-p="${prefix}" type="number" step="any" value="${o.high}" placeholder="highest" ${o.drug === -1 ? 'disabled' : ''}>
      <input data-a="low" data-p="${prefix}" type="number" step="any" value="${o.low}" placeholder="optional" ${o.drug === -1 ? 'disabled' : ''} title="Lowest dose. If you fill it in, the dilution step is calculated so the doses run evenly from highest to lowest.">
      ${o.drug === -1 ? '<span></span>' : `<select data-a="unit" data-p="${prefix}" title="Unit for this drug's doses">${unitsFor({ concentrationUnit: W.drugs[o.drug]?.unit || 'mM', byVol: false }).map((u) => `<option value="${u}" ${u === unitOfAxis(o) ? 'selected' : ''}>${unitLabel(u)}</option>`).join('')}</select>`}
      <input data-a="factor" data-p="${prefix}" value="${o.factor}" ${+o.low > 0 || o.drug === -1 ? 'disabled' : ''} title="How much less each next dose is: 1:3, 1.5, ÷2, ×0.667, −33 %, 1:0.33 (= remove a third). Calculated for you when a lowest dose is given.">
      <input data-a="levels" data-p="${prefix}" type="number" min="0" value="${o.levels}" ${o.drug === -1 ? 'disabled' : ''} title="Number of doses, not counting 0">
      <input data-a="reps" data-p="${prefix}" type="number" min="1" value="${o.reps}" title="Wells per dose next to each other on the plate">
      <label class="chk" title="Adds wells without this drug: the other drug alone, and the vehicle control"><input data-a="zero" data-p="${prefix}" type="checkbox" ${o.zero ? 'checked' : ''}> 0</label>`;
    b.innerHTML = `<div class="wz-split"><div>
      <p>The <b>first drug</b> runs across the columns. Each <b>second drug</b> runs down the rows and gets its own set of ${W.reps} plate${W.reps > 1 ? 's' : ''}. Space inside the border: <b>${inner.rows} rows × ${inner.cols} columns</b>.</p>
      <div class="wz-row head wz-axis"><span>Drug</span><span>Highest dose</span><span>Lowest dose</span><span>Unit</span><span>Dilution step</span><span>Doses</span><span>Wells per dose</span><span>Add 0</span><span>DMSO top-up</span><span></span></div>
      <div class="wz-row wz-axis">${axis(W.primary, 'p', false)}<span class="muted">columns →</span><span></span></div>
      <div class="wz-levels" id="lv_p"></div>
      ${W.partners.map((o, i) => `<div class="wz-row wz-axis">${axis(o, i, true)}<select data-a="norm" data-p="${i}" title="Tops every well up with DMSO so all wells, including the controls, contain the same amount">${Object.entries(NORM).map(([k, v]) => `<option value="${k}" ${o.norm === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select><button class="small icon-only" data-delp="${i}" title="Remove">${icon('trash', 14)}</button></div><div class="wz-levels" id="lv_${i}"></div>`).join('')}
      <p><button id="w_addP" class="small">${icon('plus', 14)} Add another second drug (its own plate set)</button></p>
      <div class="wz-key"><span><i style="background:var(--accent)"></i>dose from the stock</span><span><i style="background:repeating-linear-gradient(45deg,var(--accent) 0 2px,#fff 2px 4px)"></i>dose from a diluted stock</span><span><i style="border:2px dashed var(--warn);box-sizing:border-box"></i>cannot be dispensed</span><span><i style="background:var(--well-empty);border:1px solid var(--line);box-sizing:border-box"></i>0 = no drug</span></div>
      <p class="hint">Give a <b>dilution step</b> (1:3 = each dose is a third of the one before) <b>or</b> a <b>lowest dose</b> — then the step is worked out for you. Darker circle = higher dose. "Add 0" gives you each drug alone and the vehicle control.</p>
      </div><div class="wz-pic" id="w_pic"></div></div>`;
    $w('w_addP').onclick = () => { save(); W.partners.push({ drug: Math.min(W.partners.length + 1, W.drugs.length - 1), high: '', low: '', factor: 2, levels: 6, zero: true, reps: 2, norm: 'block' }); draw(ctx); };
    for (const x of b.querySelectorAll('[data-delp]')) x.onclick = () => { save(); W.partners.splice(+x.dataset.delp, 1); draw(ctx); };
    let tmr = null;
    const upd = (e) => {
      // a new unit keeps the doses: 10 µM becomes 10000 nM (for every row that uses this drug)
      if (e?.target?.dataset?.a === 'unit') {
        const o = e.target.dataset.p === 'p' ? W.primary : W.partners[+e.target.dataset.p], x = W.drugs[o.drug], from = unitOfAxis(o), to = e.target.value;
        save(); x.doseUnit = to;
        const k = fromDisplay(1, from) / fromDisplay(1, to);
        for (const ax of [W.primary, ...W.partners]) if (ax.drug === o.drug) for (const f of ['high', 'low']) if (+ax[f] > 0) ax[f] = String(+(+ax[f] * k).toPrecision(10));
        return draw(ctx);
      }
      if (e?.target?.dataset?.a === 'drug') { save(); return draw(ctx); }
      save(); levelsPreview(ctx);
      for (const el of b.querySelectorAll('[data-a="factor"]')) { // with a lowest dose the step is calculated: show it
        const o = el.dataset.p === 'p' ? W.primary : W.partners[+el.dataset.p]; el.disabled = +o.low > 0 || o.drug === -1;
        if (+o.low > 0 && o.drug !== -1) { const st = rangeStep(toBase(o, o.high), lowOf(o), Math.floor(o.levels)); if (st) { el.value = `1:${+st.toPrecision(3)}`; o.factor = el.value; } }
      }
      clearTimeout(tmr); tmr = setTimeout(() => picture(ctx, $w('w_pic')), 200);
    };
    b.oninput = upd; b.onchange = null; upd();
  } else if (W.step === 3) {
    b.innerHTML = `<div class="wz-split"><div><p>Which cells go on the plates? Cell lines are saved in the experiment file next to the protocol (the D300e does not need them) and label every well in the results.</p>
      <div class="form"><label>Cell lines</label><input id="w_cells" value="${esc(W.cellLines)}" placeholder="e.g. MM.1S, KMS-11, U266 (comma separated)">
      <label>Arrangement</label><select id="w_cellMode">
        <option value="same" ${W.cellMode === 'same' ? 'selected' : ''}>One cell line on every plate (the first one)</option>
        <option value="perLine" ${W.cellMode === 'perLine' ? 'selected' : ''}>Each cell line gets its own plates</option>
        <option value="splitRows" ${W.cellMode === 'splitRows' ? 'selected' : ''}>Two cell lines per plate: top half / bottom half</option>
        <option value="splitCols" ${W.cellMode === 'splitCols' ? 'selected' : ''}>Two cell lines per plate: left half / right half</option>
        <option value="none" ${W.cellMode === 'none' ? 'selected' : ''}>Decide later (Annotate tab)</option></select>
      <label class="full chk" title="Each plate gets its own random order. A well only swaps places with wells of the same cell line, so you seed the cells exactly as drawn. Saved in the protocol file; the D300e prints it that way."><input type="checkbox" id="w_rand" ${W.randomize ? 'checked' : ''}> Shuffle the well positions within each cell line (reduces edge and position effects)</label></div>
      <p class="hint" id="w_cellInfo"></p></div><div class="wz-pic" id="w_pic"></div></div>`;
    let tmr = null;
    const info = () => {
      save(); const n = Math.max(1, splitNames(W.cellLines).length), split = W.cellMode.startsWith('split');
      const sets = W.cellMode === 'perLine' ? n : split ? Math.ceil(n / 2) : 1, tot = W.partners.length * W.reps * sets;
      $w('w_cellInfo').textContent = `${W.partners.length} layout${W.partners.length > 1 ? 's' : ''} × ${W.reps} replicate${W.reps > 1 ? 's' : ''}${sets > 1 ? ` × ${sets} ${split ? 'cell-line pairs' : 'cell lines'}` : ''} = ${tot} plate${tot > 1 ? 's' : ''}.`
        + (split ? ' Each half gets the same drug layout, so the layout must fit in half the plate.' : '')
        + (W.cellMode === 'same' && n > 1 ? ' Only the first cell line is used with this arrangement.' : '');
      clearTimeout(tmr); tmr = setTimeout(() => picture(ctx, $w('w_pic')), 200);
    };
    b.oninput = info; b.onchange = info; info();
  } else if (W.step === 4) {
    let pv;
    try { pv = preview(ctx); } catch (e) { b.innerHTML = `<div class="callout warn">${esc(e.message)}</div>`; return; }
    const { protocol, meta, first } = pv;
    const nPl = protocol.plates.length - first;
    const nBlocks = W.partners.length * Math.max(1, W.cellMode === 'perLine' ? splitNames(W.cellLines).length : W.cellMode.startsWith('split') ? Math.ceil(splitNames(W.cellLines).length / 2) : 1);
    b.innerHTML = `<div class="wz-split"><div>
      <h3 style="margin-top:0">${nPl} plate${nPl > 1 ? 's' : ''}${W.target === 'append' ? ` added after the current ${first}` : ''}</h3>
      <ul>${(meta.blocks || []).slice(-nBlocks).map((bl) => `<li><b>${esc(bl.name)}</b>${bl.cellLine ? ` · ${esc(bl.cellLine)}` : ''}: plate${bl.plates.length > 1 ? 's' : ''} ${bl.plates.map((p) => p + 1).join(', ')} — ${bl.region.rows} rows × ${bl.region.cols} columns of wells</li>`).join('')}</ul>
      <h3>What happens next</h3>
      <ol class="wz-next">
        <li><b>Create</b> — the plates open in the editor; the <b>Run</b> tab shows the cassette drawing and a loading sheet.</li>
        <li><b>Save</b> — one .tdd file for the D300e and one experiment file (cell lines, units) next to it.</li>
        <li><b>Seed the cells</b> where the picture shows them, and fill the border with PBS.</li>
        <li><b>At the D300e</b>: open the .tdd, press Run, pipette each head as drawn, load the plates when asked.</li>
        <li><b>After reading the plates</b>: paste the values in the <b>Results</b> tab for viability, synergy and Excel.</li>
      </ol></div><div class="wz-pic">${pictureHtml(pv, ctx)}</div></div>`;
    W._preview = pv;
  }
  if (W.step <= 3) for (const id of ['w_type']) $w(id)?.addEventListener('change', () => { save(); });
}

function splitNames(s) { return String(s || '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean); }

function save() {
  const v = (id) => $w(id)?.value;
  if (W.step === 0 && $w('w_type')) {
    W.plateType = v('w_type'); W.assayUL = +v('w_assay'); W.dmsoPct = +v('w_dmso'); W.border = +v('w_border'); W.reps = Math.max(1, Math.floor(+v('w_reps') || 1));
    W.scrap = $w('w_scrap').checked; W.dontShake = $w('w_shake').checked; W.target = v('w_target'); W.dilutedStocks = $w('w_dil').checked;
  } else if (W.step === 1) {
    for (const el of document.querySelectorAll('#wzBody [data-d]')) { const x = W.drugs[+el.dataset.i]; const k = el.dataset.d; x[k] = k === 'stock' || k === 'classId' ? +el.value : el.value; }
  } else if (W.step === 2) {
    for (const el of document.querySelectorAll('#wzBody [data-a]')) {
      const o = el.dataset.p === 'p' ? W.primary : W.partners[+el.dataset.p]; const k = el.dataset.a;
      if (k === 'unit') continue; // handled on change (converts the doses)
      o[k] = k === 'zero' ? el.checked : k === 'norm' || k === 'high' || k === 'low' || k === 'factor' ? el.value : +el.value;
    }
  } else if (W.step === 3 && $w('w_cells')) { W.cellLines = v('w_cells'); W.cellMode = v('w_cellMode'); W.randomize = $w('w_rand').checked; }
}

const lowOf = (o) => (+o.low > 0 ? toBase(o, o.low) : null);
/** Dose levels of a row in the file's base unit (µM / ng/mL), highest first, then 0. */
function levelsFor(o) {
  const high = toBase(o, o.high), low = lowOf(o);
  if (low != null && !(low < high)) throw new Error('The lowest dose must be below the highest');
  if (low != null && Math.floor(o.levels) < 2) throw new Error('From highest to lowest needs at least 2 doses');
  if (!(o.levels > 0 && high > 0)) return o.zero ? [0] : [];
  return axisLevels({ high, low, factor: low != null ? null : parseDilution(o.factor).factor, levels: Math.floor(o.levels), includeZero: o.zero });
}
const stepLabel = (o) => { const st = rangeStep(toBase(o, o.high), lowOf(o), Math.floor(o.levels)); return st ? `1:${+st.toPrecision(3)} per step (calculated)` : parseDilution(o.factor).label; };

/** One row's doses as a strip of wells, with plain-language notes on anything that cannot be dispensed as asked. */
function levelsPreview(ctx) {
  const dm = dims(), inner = { rows: dm.rows - 2 * W.border, cols: dm.cols - 2 * W.border };
  W.split = W.cellMode === 'splitRows' || W.cellMode === 'splitCols';
  if (W.cellMode === 'splitRows') inner.rows = Math.floor(inner.rows / 2);
  if (W.cellMode === 'splitCols') inner.cols = Math.floor(inner.cols / 2);
  const plateLike = { assayVolume: W.assayUL * 1000, dmsoLimit: W.dmsoPct / 100 };
  const show = (o, el, axisLen, axisName) => {
    if (!el) return;
    if (o.drug === -1) { el.innerHTML = `<div class="wz-msg"><div>One drug only: ${o.reps} row${o.reps > 1 ? 's' : ''} with the same doses (replicates).</div></div>`; return; }
    try {
      const x = W.drugs[o.drug], u = unitOfAxis(o), ul = unitLabel(u), sh = (v) => shortNum(toDisplay(v, u));
      if (!(+o.high > 0)) { el.innerHTML = '<div class="wz-msg"><div class="muted">Enter the highest dose.</div></div>'; return; }
      const lv = levelsFor(o); const n = lv.length * o.reps;
      const fl = x && { concentration: fromDisplay(x.stock, x.unit), concentrationUnit: x.unit, classId: x.classId, byVol: false };
      const two = W.partners.some((p) => p.drug !== -1);
      const rg = fl && fl.concentration > 0 ? validRange(fl, plateLike, two ? 2 : 1) : null;
      const below = rg ? lv.filter((v) => v && v < rg.min) : [], above = rg ? lv.filter((v) => v > rg.max) : [];
      const sug = below.length && fl ? suggestShift(fl, plateLike, Math.max(...lv), Math.min(...lv.filter((v) => v > 0))) : null;
      const canDilute = sug && sug.kind !== 'impossible' && W.dilutedStocks;
      const dilName = canDilute ? `${x.name || 'drug'} - 1:${sug.factor}` : null;
      // extension: every dose that needs up to ~180 nL of the diluted stock comes from it (as D300e Control does)
      const thr = canDilute && sug.kind === 'extend' ? extendThreshold(fl.concentration / sug.factor, plateLike) * (1 + 1e-9) : 0;
      const onDil = lv.filter((v) => v > 0 && v < thr);
      const kinds = lv.map((v) => ({ v: toDisplay(v, u), kind: v === 0 ? 'zero' : rg && v > rg.max ? 'above' : canDilute && (sug.kind === 'shift' || v < thr) ? 'diluted' : rg && v < rg.min ? 'below' : 'stock' }));
      const color = ctx.fluidColor({ id: x.existingId ?? o.drug });
      const msgs = [];
      msgs.push(`<div><span class="pill">${stepLabel(o)}</span> <b style="color:${n > axisLen ? 'var(--danger)' : 'inherit'}">${n} ${axisName}</b> of ${axisLen} available${rg ? ` · this ${x.stock} ${unitLabel(x.unit)} stock can give ${sh(rg.min)}–${sh(rg.max)} ${ul} in a well` : ''}</div>`);
      if (n > axisLen) {
        const zero = o.zero ? 1 : 0, maxLv = Math.floor(axisLen / o.reps) - zero, maxRep = Math.floor(axisLen / lv.length);
        msgs.push(`<div style="color:var(--danger)">Too wide for the plate: ${lv.length - zero} doses${zero ? ' + 0' : ''} × ${o.reps} wells each = ${n} ${axisName}, but only ${axisLen} fit${W.split ? ' in half the plate' : ' inside the border'}. Use ${[maxLv >= 1 ? `at most ${maxLv} doses` : null, maxRep >= 1 && maxRep < o.reps ? `${maxRep} well${maxRep > 1 ? 's' : ''} per dose (and more plate replicates)` : null, W.border ? 'no PBS border' : null].filter(Boolean).join(', or ')}.</div>`);
      }
      if (below.length && canDilute) msgs.push(`<div style="color:var(--accent)">${sug.kind === 'shift' ? `All doses come from a diluted stock, <b>${ctx.esc(dilName)}</b>` : `The ${onDil.length} lowest dose${onDil.length > 1 ? 's' : ''} (${onDil.map(sh).join(', ')} ${ul}) come from a second, diluted stock: <b>${ctx.esc(dilName)}</b>`} (${+(x.stock / sug.factor).toPrecision(3)} ${unitLabel(x.unit)}). You prepare one more tube (1 part stock + ${sug.factor - 1} parts solvent) and it takes one more dispense head. Why: the lowest dose${below.length > 1 ? 's need' : ' needs'} less than one drop of the ${x.stock} ${unitLabel(x.unit)} stock.</div>`);
      else if (below.length) msgs.push(`<div style="color:var(--warn)">${below.length} dose${below.length > 1 ? 's are' : ' is'} too low for this stock (below ${sh(rg.min)} ${ul} = less than one drop): ${sug?.kind === 'impossible' ? 'even a 1:9000 dilution is not enough. Start from a less concentrated stock.' : 'tick "Add a diluted stock automatically" on the Plates step, or start from a less concentrated stock.'}</div>`);
      if (above.length) msgs.push(`<div style="color:var(--danger)">${above.length} dose${above.length > 1 ? 's are' : ' is'} too high for this stock (above ${sh(rg.max)} ${ul}): the well would get more DMSO than the ${W.dmsoPct} % limit${two ? ', which the two drugs share' : ''}. Use a more concentrated stock or a lower highest dose.</div>`);
      el.innerHTML = pic(levelStripSvg(kinds, color, { unit: ul, replicates: o.reps, theme: THEME_VARS, dilutedName: dilName })) + `<div class="wz-msg">${msgs.join('')}</div>`;
    } catch (e) { el.innerHTML = `<div class="wz-msg"><div style="color:var(--danger)">${ctx.esc(e.message)}</div></div>`; }
  };
  show(W.primary, $w('lv_p'), inner.cols, 'columns');
  W.partners.forEach((o, i) => show(o, $w(`lv_${i}`), inner.rows, 'rows'));
}

/** Short text: plates, cassettes, solutions, warnings (HTML lines). */
function needsLines(pv, ctx) {
  const { esc } = ctx;
  const { protocol, computed, plan, first, stockNotes } = pv;
  const nPl = protocol.plates.length - first;
  const names = splitNames(W.cellLines), split = W.cellMode.startsWith('split');
  const sets = W.cellMode === 'perLine' ? Math.max(1, names.length) : split ? Math.max(1, Math.ceil(names.length / 2)) : 1;
  let dmso = 0, low = 0;
  computed.forEach(({ wells }, pi) => { if (pi < first) return; for (const w of wells.values()) for (const x of w.warnings) { if (x.code === 'dmso_limit') dmso++; if (x.code === 'below_min_volume') low++; } });
  const byType = {}; for (const c of plan.cassettes) { const t = (byType[c.type] ||= { n: 0, heads: 0 }); t.n++; t.heads += c.heads.length; }
  const L = { plates: `<b>${nPl} plate${nPl > 1 ? 's' : ''}</b> = ${W.partners.length} layout${W.partners.length > 1 ? 's' : ''} × ${W.reps} replicate${W.reps > 1 ? 's' : ''}${sets > 1 ? ` × ${sets} ${split ? 'cell-line pairs' : 'cell lines'}` : ''}`, notes: [] };
  L.cassettes = Object.entries(byType).map(([t, x]) => `<b>${x.n} × ${t}</b> (${x.heads} of ${x.n * (t === 'T8+' ? 8 : 4)} heads filled)`).join(' + ') || 'none';
  L.solutions = `${plan.fluids.length} solution${plan.fluids.length > 1 ? 's' : ''} to pipette`;
  for (const n of stockNotes || []) {
    if (n.kind === 'impossible') L.notes.push(`<span style="color:var(--warn)">⚠ ${esc(n.drug)}: ${n.levels.length} dose(s) stay below one drop even after a 1:9000 dilution.</span>`);
    else L.notes.push(`<span style="color:var(--accent)">Prepare <b>${esc(n.fluid)}</b>: ${esc(n.drug)} stock diluted 1:${n.factor} (striped head).</span>`);
  }
  if (W.randomize) L.notes.push(`The plate picture shows the wells <b>as printed</b>: shuffled ${W.cellMode === 'none' || !names.length ? 'within the drug grid' : 'within each cell line'}, a different order on every plate. You can de-randomize later with one click.`);
  L.notes.push(dmso || low ? `<span style="color:var(--warn)">⚠ ${[dmso ? `${dmso} wells get more DMSO than the limit` : '', low ? `${low} wells need less than one drop` : ''].filter(Boolean).join(', ')}. See the notes under each drug.</span>` : '<span style="color:var(--ok)">✓ Every well can be printed as planned.</span>');
  return L;
}
/** The picture panel: plate 1, the plates needed, the cassettes with every head to fill. */
function pictureHtml(pv, ctx) {
  const { protocol, meta, plan, first } = pv, p = protocol.plates[first], pm = meta.plates[first];
  const fl = new Map(protocol.fluids.map((f) => [f.id, f]));
  const scrap = new Set(Object.entries(pm?.roles || {}).filter(([, r]) => r === 'scrap').map(([k]) => k));
  const blocks = (meta.blocks || []).filter((bl) => bl.plates.some((i) => i >= first));
  const b0 = blocks.find((bl) => bl.plates.includes(first));
  const lineColor = (name) => meta.cellLines.find((c) => c.name === name)?.color || 'var(--ink)';
  const names = (b0?.cellLine || '').split(' / ').filter(Boolean);
  const regions = b0 ? (b0.copies || [b0.region]).map((g, i) => ({ ...g, label: names[i] ?? (names.length === 1 ? names[0] : ''), color: names[i] ? lineColor(names[i]) : names.length === 1 ? lineColor(names[0]) : '#6b7385' })) : [];
  const groups = blocks.map((bl) => ({ label: `${bl.name}${bl.cellLine ? ' · ' + bl.cellLine : ''}`, count: bl.plates.length, first: bl.plates[0] + 1, color: ctx.fluidColor(fl.get(bl.primary) || { id: 0 }), split: (bl.copies || []).length > 1 }));
  const L = needsLines(pv, ctx);
  // a randomized plate is drawn as printed: each planned well at the position the D300e dispenses it into
  const moved = new Map((p.randomization || []).map((x) => [`${x.r},${x.c}`, `${x.toR},${x.toC}`]));
  const shown = moved.size ? { rows: p.rows, cols: p.cols, wells: new Map([...p.wells].map(([k, m]) => [moved.get(k) || k, m])) } : p;
  return `<h4>Plate ${first + 1}${moved.size ? ' as printed (shuffled)' : ''}${regions.some((g) => g.label) ? ' · outlined = where each cell line is seeded' : ''}</h4>${pic(plateSvg(shown, { colorOf: (id) => ctx.fluidColor(fl.get(id) || { id }), border: W.border, scrap, regions, theme: THEME_VARS }))}
    <div class="wz-key">${[...new Set([...p.wells.values()].flatMap((m) => [...m.keys()]).map((id) => fl.get(id)).filter(Boolean).map((f) => (f.rootFluidId != null ? fl.get(f.rootFluidId) || f : f)))].map((f) => `<span><i style="background:${ctx.fluidColor(f)}"></i>${ctx.esc(f.name)}</span>`).join('')}${scrap.size ? '<span><i style="border:1px dashed var(--ink);box-sizing:border-box"></i>priming well</span>' : ''}${W.border ? '<span><i style="background:var(--accent);opacity:.25"></i>PBS border</span>' : ''}</div>
    <h4>Plates to print</h4>${pic(plateStackSvg(groups, { theme: THEME_VARS }))}<div class="wz-msg"><div>${L.plates}</div></div>
    <h4>Cassettes and dispense heads</h4>${pic(cassetteSvg(plan.cassettes, (h) => fluidLook(protocol, h.fluidId, h.classId === 0), { theme: THEME_VARS }))}
    <div class="wz-msg"><div>${L.cassettes} · ${L.solutions}. Pipette the bold volume into each head.</div>${L.notes.map((x) => `<div>${x}</div>`).join('')}</div>`;
}
function picture(ctx, el) {
  if (!el) return;
  try { el.innerHTML = pictureHtml(preview(ctx), ctx); } catch (e) { el.innerHTML = `<h4>Not ready yet</h4><div class="wz-msg"><div style="color:var(--warn)">${ctx.esc(e.message)}</div></div>`; }
}

function validate(ctx) {
  if (W.step === 0) { if (!(W.assayUL > 0)) return 'Well volume must be above 0'; if (!(W.dmsoPct > 0 && W.dmsoPct <= 100)) return 'DMSO limit must be between 0 and 100 %'; }
  if (W.step === 1) {
    if (!W.drugs.length) return 'Add at least one drug';
    const names = W.drugs.map((d) => d.name.trim());
    if (names.some((n) => !n)) return 'Every drug needs a name';
    if (new Set(names).size !== names.length) return 'Drug names must be different';
    if (W.drugs.some((d) => !(d.stock > 0))) return 'Every stock concentration must be above 0';
    const clash = W.drugs.find((d) => d.existingId == null && ctx.S.protocol.fluids.some((f) => f.name === d.name.trim()) && W.target === 'append');
    if (clash) return `"${clash.name}" already exists in the protocol with another stock; rename it`;
  }
  if (W.step === 2) {
    if (!(+W.primary.high > 0)) return 'Enter the primary drug\'s top concentration';
    if (!W.partners.length) return 'Add a partner, or choose "none (single drug)"';
    for (const o of W.partners) if (o.drug !== -1 && !(+o.high > 0)) return 'Enter every partner\'s top concentration';
    if (W.partners.some((o) => o.drug === W.primary.drug)) return 'A partner cannot be the primary drug';
    try { preview(ctx); } catch (e) { return e.message; }
  }
  return null;
}

/** Build the result on copies (never touches the document). */
function preview(ctx) {
  const S = ctx.S;
  const protocol = W.target === 'replace' ? newProtocol() : structuredClone(S.protocol);
  const meta = W.target === 'replace' ? newMeta(protocol) : structuredClone(S.meta);
  meta.settings.borderPBS = W.border > 0; meta.settings.borderDepth = W.border || 1;
  // drugs → fluids (reuse fluids that are already in the protocol)
  const ids = W.drugs.map((d) => {
    const ex = d.existingId != null && W.target === 'append' ? protocol.fluids.find((f) => f.id === d.existingId) : protocol.fluids.find((f) => f.name === d.name.trim());
    if (ex) return ex.id;
    return addFluid(protocol, { name: d.name.trim(), concentration: fromDisplay(d.stock, d.unit), concentrationUnit: d.unit, classId: d.classId }).id;
  });
  W.drugs.forEach((d, i) => { const f = protocol.fluids.find((x) => x.id === ids[i]); if (f) setDrugUnit(meta, protocol, f, doseUnit(d)); });
  const axis = (o) => ({ fluidId: o.drug === -1 ? null : ids[o.drug], high: o.drug === -1 ? 1 : toBase(o, o.high), low: o.drug === -1 ? null : lowOf(o), factor: o.drug === -1 ? 2 : lowOf(o) != null ? rangeStep(toBase(o, o.high), lowOf(o), Math.floor(o.levels)) : parseDilution(o.factor).factor, levels: o.drug === -1 ? 0 : Math.floor(o.levels), includeZero: o.drug === -1 ? true : o.zero, replicates: Math.max(1, Math.floor(o.reps)) });
  const spec = {
    plate: { plateType: W.plateType, assayVolume: W.assayUL * 1000, dmsoLimit: W.dmsoPct / 100, dontShake: W.dontShake },
    border: W.border, plateReplicates: W.reps, scrap: W.scrap,
    primary: axis(W.primary),
    partners: W.partners.map((o) => ({ ...axis(o), normalization: NORM[o.norm]?.nz && { ...NORM[o.norm].nz, param: NORM[o.norm].nz.param != null ? W.dmsoPct / 100 : undefined } })),
  };
  const first = protocol.plates.length;
  const names = splitNames(W.cellLines);
  const lines = names.map((n) => meta.cellLines.find((c) => c.name === n) || addCellLine(meta, n));
  const split = W.cellMode === 'splitRows' ? 'rows' : W.cellMode === 'splitCols' ? 'cols' : null;
  if (split) spec.split = split;
  // cell-line sets: one line for all plates, one plate set per line, or pairs of lines sharing plates (split)
  const sets = W.cellMode === 'perLine' && lines.length ? lines.map((l) => [l])
    : split ? (lines.length ? Array.from({ length: Math.ceil(lines.length / 2) }, (_, i) => lines.slice(2 * i, 2 * i + 2)) : [[]])
    : [W.cellMode === 'none' || !lines[0] ? [] : [lines[0]]];
  const stockNotes = W.dilutedStocks ? resolveStocks(protocol, spec) : [];
  for (const set of sets) {
    const built = buildExperiment(spec, protocol.fluids);
    applyExperiment(protocol, meta, built);
    seedBlocks(meta, protocol, meta.blocks.slice(-built.blocks.length), set);
    for (const bl of meta.blocks.slice(-built.blocks.length)) bl.cellLine = set.map((c) => c.name).join(' / ');
  }
  if (W.randomize) { // within each cell line; without cell lines, within each drug grid
    randomizeByCellLine(protocol, meta, protocol.plates.map((_, i) => i).filter((i) => i >= first), seededRng(W.seed));
    meta.experiment.randomSeed = W.seed;
  }
  meta.experiment.stockNotes = [...(meta.experiment.stockNotes || []), ...stockNotes];
  const computed = computeProtocol(protocol);
  return { protocol, meta, computed, plan: planRun(protocol, computed, { usedT8Heads: meta.settings?.usedT8Heads }), first, stockNotes };
}

function miniPlate(el, protocol, meta, pi, ctx) {
  const p = protocol.plates[pi]; if (!p) return;
  const s = p.cols > 24 ? 7 : 13;
  el.style.display = 'grid'; el.style.gridTemplateColumns = `repeat(${p.cols}, ${s}px)`; el.style.gap = '2px';
  el.style.background = 'var(--plate)'; el.style.padding = '8px'; el.style.borderRadius = '8px';
  const fl = new Map(protocol.fluids.map((f) => [f.id, f]));
  let html = '';
  for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) {
    const m = p.wells.get(wellKey(r, c));
    const scrap = meta.plates[pi]?.roles[wellKey(r, c)] === 'scrap';
    const border = W.border && isBorder(r, c, p.rows, p.cols, W.border) && !scrap;
    let bg = 'var(--well-empty)';
    if (m && m.size) { const cols = [...m.keys()].map((id) => ctx.fluidColor(fl.get(id) || { id })); bg = cols.length === 1 ? cols[0] : `linear-gradient(135deg, ${cols[0]} 50%, ${cols[1]} 50%)`; }
    html += `<i style="width:${s}px;height:${s}px;border-radius:50%;display:block;background:${bg};${border ? 'background-image:repeating-linear-gradient(45deg,var(--accent) 0 1px,transparent 1px 3px);opacity:.6' : ''};font-size:8px;line-height:${s}px;text-align:center;font-style:normal;font-weight:700">${scrap ? 'S' : ''}</i>`;
  }
  el.innerHTML = html;
}

function create(ctx) {
  const pv = W._preview || preview(ctx);
  try { localStorage.setItem('d300.wizard', JSON.stringify({ plateType: W.plateType, assayUL: W.assayUL, dmsoPct: W.dmsoPct, border: W.border, reps: W.reps, dontShake: W.dontShake, dilutedStocks: W.dilutedStocks })); } catch { /* not remembered */ }
  const ok = ctx.mutate('experiment wizard', () => {
    if (W.target === 'replace') ctx.replaceDoc();
    ctx.S.protocol = pv.protocol; ctx.S.meta = pv.meta;
    ctx.S.plateIdx = pv.first; ctx.S.sel.clear(); ctx.S.layer = 'drugs'; ctx.S.tab = 'run';
    ctx.S.fluidId = pv.protocol.fluids[0]?.id ?? null; ctx.S.cellLineId = pv.meta.cellLines[0]?.id ?? null;
  });
  if (ok) { document.getElementById('wiz').close(); ctx.toast(`Created ${pv.protocol.plates.length - pv.first} plates. The Run tab shows which cassettes to load.`, 6000); }
}
