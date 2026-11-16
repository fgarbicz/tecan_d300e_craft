// Experiment wizard: five steps from "what plates" to "create". Keeps its own state (W) and only touches the
// document once, on Create (one undo step). The layout itself comes from buildExperiment() in
// src/experiment.js, which is tested to rebuild the hand-made D3 protocol byte for byte.

import { newProtocol, wellKey } from '../src/tdd.js';
import { PLATE_TYPES, addFluid, titrationLevels, parseDilution } from '../src/ops.js';
import { computeProtocol, validRange, FLUID_CLASSES, MOLARITY_UNITS, MASS_UNITS, unitLabel, fromDisplay, toDisplay } from '../src/dispense.js';
import { buildExperiment, applyExperiment, newMeta, addCellLine, seedBlocks, isBorder, axisLevels, rangeStep, resolveStocks, randomizeByCellLine, seededRng } from '../src/experiment.js';
import { suggestShift } from '../src/ops.js';
import { planRun } from '../src/cassette.js';
import { icon } from './icons.js';

const STEPS = ['Plates', 'Drugs', 'Layout', 'Cell lines', 'Review'];
const NORM = {
  block: { label: 'DMSO to highest, across the plate set', nz: { type: 'ToMaxVolume', scope: 'block' } },
  plate: { label: 'DMSO to the DMSO limit (% of total), per plate', nz: { type: 'ToAssayVolumePct', param: 0.01, scope: 'plate' } },
  none: { label: 'No normalization', nz: null },
};
let W = null;

function defaults(S) {
  const cur = S.protocol.plates[0];
  const empty = !S.protocol.plates.some((p) => p.wells.size) && !S.protocol.fluids.length;
  let last = null; try { last = JSON.parse(localStorage.getItem('d300.wizard') || 'null'); } catch { /* none */ }
  const drugs = S.protocol.fluids.filter((f) => !f.byVol).map((f) => ({ existingId: f.id, name: f.name, stock: +toDisplay(f.concentration, f.concentrationUnit).toPrecision(10), unit: f.concentrationUnit, classId: f.classId }));
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

function draw(ctx) {
  const { esc } = ctx;
  $w('wzSteps').innerHTML = STEPS.map((s, i) => `<span class="${i === W.step ? 'on' : i < W.step ? 'done' : ''}">${i + 1}. ${s}</span>`).join('');
  $w('wzBack').disabled = W.step === 0;
  $w('wzNext').innerHTML = W.step === STEPS.length - 1 ? `${icon('check', 15)} Create ${W.target === 'replace' ? 'protocol' : 'plates'}` : `Next ${icon('next', 15)}`;
  note('');
  const b = $w('wzBody');
  if (W.step === 0) {
    b.innerHTML = `<p>What goes on the plates? Every layout you design next is repeated on this many plates.</p><div class="form">
      <label>Plate</label><select id="w_type">${Object.entries(PLATE_TYPES).map(([k, v]) => `<option value="${k}" ${k === W.plateType ? 'selected' : ''}>${v.label} (${v.rows} × ${v.cols})</option>`).join('')}</select>
      <label title="Medium + cells already in each well">Well volume</label><span><input id="w_assay" type="number" step="any" value="${W.assayUL}"> µL (medium + cells)</span>
      <label>DMSO limit</label><span><input id="w_dmso" type="number" step="any" value="${+(+W.dmsoPct).toPrecision(6)}"> % per well</span>
      <label>PBS border</label><select id="w_border"><option value="0" ${W.border == 0 ? 'selected' : ''}>None</option><option value="1" ${W.border == 1 ? 'selected' : ''}>Outer row/column (recommended)</option><option value="2" ${W.border == 2 ? 'selected' : ''}>Outer 2 rows/columns</option></select>
      <label>Plate replicates</label><span><input id="w_reps" type="number" min="1" max="20" value="${W.reps}"> plates per layout</span>
      <label class="full chk"><input type="checkbox" id="w_scrap" ${W.scrap ? 'checked' : ''}> Add priming ("scrap") wells in the border for drugs dispensed below 30 nL</label>
      <label class="full chk"><input type="checkbox" id="w_shake" ${W.dontShake ? 'checked' : ''}> Don't shake plates</label>
      <label class="full chk" title="D300e 'fluid shift / extend': a series that needs less than one drop of the stock gets a second, diluted stock (Drug - 1:N) in its own dispense head"><input type="checkbox" id="w_dil" ${W.dilutedStocks ? 'checked' : ''}> Add a diluted stock automatically when a series goes below one drop of the stock (like D300e's fluid shift / extend)</label>
      <label>Result</label><select id="w_target"><option value="replace" ${W.target === 'replace' ? 'selected' : ''}>New protocol (replace the current one)</option><option value="append" ${W.target === 'append' ? 'selected' : ''}>Add plates to the current protocol</option></select>
      </div><p class="hint">The border wells get PBS or medium by hand to limit evaporation; the D300e does not dispense into them (except priming wells).</p>`;
  } else if (W.step === 1) {
    b.innerHTML = `<p>Which drugs, and what are their stock concentrations (what you load into the cassette)?</p>
      <div class="wz-row head"><span>Name</span><span>Stock</span><span>Unit</span><span colspan="2">Class</span><span></span><span></span><span></span></div>
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
      <input data-a="high" data-p="${prefix}" type="number" step="any" value="${o.high}" placeholder="top">
      <input data-a="low" data-p="${prefix}" type="number" step="any" value="${o.low}" placeholder="optional" title="Lowest concentration: with it, the dilution step is calculated so the levels run evenly (log scale) from top to lowest">
      <input data-a="factor" data-p="${prefix}" value="${o.factor}" ${+o.low > 0 ? 'disabled' : ''} title="Any step: 1:3, 1.5, ÷2, ×0.667, −33 %, 1:0.33 (= remove a third). Calculated when a lowest concentration is given.">
      <input data-a="levels" data-p="${prefix}" type="number" min="0" value="${o.levels}">
      <input data-a="reps" data-p="${prefix}" type="number" min="1" value="${o.reps}">
      <label class="chk"><input data-a="zero" data-p="${prefix}" type="checkbox" ${o.zero ? 'checked' : ''}> 0</label>`;
    b.innerHTML = `<p>The <b>primary drug</b> runs along the columns; each <b>partner</b> runs along the rows and gets its own set of ${W.reps} plate${W.reps > 1 ? 's' : ''}. Replicates sit next to each other. Inside the border there are <b>${inner.rows} rows × ${inner.cols} columns</b>.</p>
      <div class="wz-row head wz-axis"><span>Drug</span><span>Top conc. (µM)</span><span>Lowest (µM)</span><span>Dilution step</span><span>Levels</span><span>Replicates</span><span>Add 0</span><span>Normalization</span><span></span></div>
      <div class="wz-row wz-axis">${axis(W.primary, 'p', false)}<span class="muted">columns</span><span></span></div>
      <div class="wz-levels" id="lv_p"></div>
      ${W.partners.map((o, i) => `<div class="wz-row wz-axis">${axis(o, i, true)}<select data-a="norm" data-p="${i}">${Object.entries(NORM).map(([k, v]) => `<option value="${k}" ${o.norm === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select><button class="small icon-only" data-delp="${i}" title="Remove">${icon('trash', 14)}</button></div><div class="wz-levels" id="lv_${i}"></div>`).join('')}
      <p><button id="w_addP" class="small">${icon('plus', 14)} Add partner drug</button></p>
      <div class="callout" id="w_sum"></div>
      <p class="hint">Either a dilution step (1:3 divides by 3 per level; 1.5 or 1:0.33 = remove a third gives 10 → 6.67 → 4.44 µM) or a <b>lowest</b> concentration: then the step is calculated so that the levels run evenly on a log scale from top to lowest, e.g. 10 µM → 0.0001 µM in 6 levels = 1:10. "Add 0" adds a no-drug level, so the matrix contains each drug alone and the vehicle control (both 0). <b>Valid range</b> = what the stock can reach in this well: from one drop (13 pL for DMSO) up to the DMSO limit. Concentrations in µM for molar stocks.</p>`;
    $w('w_addP').onclick = () => { save(); W.partners.push({ drug: Math.min(W.partners.length + 1, W.drugs.length - 1), high: '', low: '', factor: 2, levels: 6, zero: true, reps: 2, norm: 'block' }); draw(ctx); };
    for (const x of b.querySelectorAll('[data-delp]')) x.onclick = () => { save(); W.partners.splice(+x.dataset.delp, 1); draw(ctx); };
    let tmr = null;
    const upd = () => {
      save(); levelsPreview(ctx);
      for (const el of b.querySelectorAll('[data-a="factor"]')) { const o = el.dataset.p === 'p' ? W.primary : W.partners[+el.dataset.p]; el.disabled = +o.low > 0; }
      clearTimeout(tmr); tmr = setTimeout(() => summary(ctx, $w('w_sum')), 250);
    };
    b.oninput = upd; upd();
  } else if (W.step === 3) {
    b.innerHTML = `<p>Which cells go on the plates? Cell lines are stored in the experiment file next to the .tdd (the D300e ignores them) and label every well in the Excel results.</p>
      <div class="form"><label>Cell lines</label><input id="w_cells" value="${esc(W.cellLines)}" placeholder="e.g. MM.1S, KMS-11, U266 (comma separated)">
      <label>Arrangement</label><select id="w_cellMode">
        <option value="same" ${W.cellMode === 'same' ? 'selected' : ''}>One cell line on every plate (the first one)</option>
        <option value="perLine" ${W.cellMode === 'perLine' ? 'selected' : ''}>Each cell line gets its own plates (plates × cell lines)</option>
        <option value="splitRows" ${W.cellMode === 'splitRows' ? 'selected' : ''}>Two cell lines per plate: top half / bottom half</option>
        <option value="splitCols" ${W.cellMode === 'splitCols' ? 'selected' : ''}>Two cell lines per plate: left half / right half</option>
        <option value="none" ${W.cellMode === 'none' ? 'selected' : ''}>Assign later (Annotate tab)</option></select>
      <label class="full chk" title="Each plate gets its own random permutation; wells only move to other wells of the same cell line, so cells stay where you seed them. Stored in the .tdd (D300e Randomize)."><input type="checkbox" id="w_rand" ${W.randomize ? 'checked' : ''}> Randomize well positions within each cell line (against edge and gradient effects)</label></div>
      <p class="hint" id="w_cellInfo"></p>`;
    const info = () => {
      save(); const n = Math.max(1, splitNames(W.cellLines).length), split = W.cellMode.startsWith('split');
      const sets = W.cellMode === 'perLine' ? n : split ? Math.ceil(n / 2) : 1;
      $w('w_cellInfo').textContent = (W.randomize && W.cellMode === 'none' ? 'Randomizing needs cell lines assigned here. ' : '') + `${W.partners.length} layout${W.partners.length > 1 ? 's' : ''} × ${W.reps} replicate${W.reps > 1 ? 's' : ''}${sets > 1 ? ` × ${sets} ${split ? 'cell-line pairs' : 'cell lines'}` : ''} = ${W.partners.length * W.reps * sets} plate${W.partners.length * W.reps * sets > 1 ? 's' : ''}.`
        + (split ? ' Each half gets the same drug layout, so it must fit in half the plate (check the Layout step).' : '');
    };
    b.oninput = info; info();
  } else if (W.step === 4) {
    let pv;
    try { pv = preview(ctx); } catch (e) { b.innerHTML = `<div class="callout warn">${esc(e.message)}</div>`; return; }
    const { protocol, meta, first } = pv;
    const nPl = protocol.plates.length - first;
    b.innerHTML = `<div class="wz-preview"><div id="w_mini"></div><div>
      <h3 style="margin-top:0">${nPl} plate${nPl > 1 ? 's' : ''}${W.target === 'append' ? ` added after the current ${first}` : ''}</h3>
      <ul>${(meta.blocks || []).slice(-W.partners.length * Math.max(1, W.cellMode === 'perLine' ? splitNames(W.cellLines).length : W.cellMode.startsWith('split') ? Math.ceil(splitNames(W.cellLines).length / 2) : 1)).map((bl) => `<li>${esc(bl.name)}${bl.cellLine ? ` · ${esc(bl.cellLine)}` : ''}: plates ${bl.plates.map((p) => p + 1).join(', ')} — ${bl.region.rows} × ${bl.region.cols} wells</li>`).join('')}</ul>
      <p>${needsHtml(pv, ctx)}</p>
      <p class="hint">Plate 1 preview on the left (design positions${W.randomize ? '; the D300e dispenses them randomized' : ''}): colours = drugs, stripes = PBS border, S = priming well.</p></div></div>`;
    miniPlate($w('w_mini'), protocol, meta, first, ctx);
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
      o[k] = k === 'zero' ? el.checked : k === 'norm' || k === 'high' || k === 'low' || k === 'factor' ? el.value : +el.value;
    }
  } else if (W.step === 3 && $w('w_cells')) { W.cellLines = v('w_cells'); W.cellMode = v('w_cellMode'); W.randomize = $w('w_rand').checked; }
}

const lowOf = (o) => (+o.low > 0 ? +o.low : null);
function levelsFor(o) {
  const high = +o.high, low = lowOf(o);
  if (low != null && !(low < high)) throw new Error('Lowest must be below the top concentration');
  if (low != null && Math.floor(o.levels) < 2) throw new Error('A top–lowest range needs at least 2 levels');
  if (!(o.levels > 0 && high > 0)) return o.zero ? [0] : [];
  return axisLevels({ high, low, factor: low != null ? null : parseDilution(o.factor).factor, levels: Math.floor(o.levels), includeZero: o.zero });
}
const stepLabel = (o) => { const st = rangeStep(+o.high, lowOf(o), Math.floor(o.levels)); return st ? `1:${+st.toPrecision(3)} (calculated)` : parseDilution(o.factor).label; };
function levelsPreview(ctx) {
  const dm = dims(), inner = { rows: dm.rows - 2 * W.border, cols: dm.cols - 2 * W.border };
  W.split = W.cellMode === 'splitRows' || W.cellMode === 'splitCols';
  if (W.cellMode === 'splitRows') inner.rows = Math.floor(inner.rows / 2);
  if (W.cellMode === 'splitCols') inner.cols = Math.floor(inner.cols / 2);
  const plateLike = { assayVolume: W.assayUL * 1000, dmsoLimit: W.dmsoPct / 100 };
  const show = (o, el, axisLen, axisName) => {
    if (!el) return;
    if (o.drug === -1) { el.innerHTML = `Single drug: ${o.reps} row${o.reps > 1 ? 's' : ''} of replicates.`; return; }
    try {
      const lv = levelsFor(o); const n = lv.length * o.reps;
      const x = W.drugs[o.drug]; const fl = x && { concentration: fromDisplay(x.stock, x.unit), concentrationUnit: x.unit, classId: x.classId, byVol: false };
      const rg = fl && fl.concentration > 0 ? validRange(fl, plateLike, 2) : null;
      const below = rg ? lv.filter((v) => v && v < rg.min) : [], above = rg ? lv.filter((v) => v > rg.max) : [];
      const msgs = [];
      if (n > axisLen) {
        const zero = o.zero ? 1 : 0, maxLv = Math.floor(axisLen / o.reps) - zero, maxRep = Math.floor(axisLen / lv.length);
        msgs.push(`<span style="color:var(--danger)">needs ${n} ${axisName} (${lv.length - zero} levels${zero ? ' + 0' : ''} × ${o.reps} replicates) but only ${axisLen} fit${W.split ? ' in half the plate' : ' inside the border'}: use ${[maxLv >= 1 ? `≤ ${maxLv} levels` : null, maxRep >= 1 && maxRep < o.reps ? `${maxRep} replicate${maxRep > 1 ? 's' : ''} per plate (and more plate replicates)` : null, W.border ? 'no PBS border' : null].filter(Boolean).join(', or ')}</span>`);
      }
      if (below.length && fl) {
        const sh = suggestShift(fl, plateLike, Math.max(...lv), Math.min(...lv.filter((v) => v > 0)));
        if (sh && sh.kind !== 'impossible' && W.dilutedStocks) msgs.push(`<span style="color:var(--accent)">${below.length} level${below.length > 1 ? 's' : ''} (${below.map((v) => ctx.fmt(v, 3)).join(', ')}) need less than one drop of the ${x.stock} ${unitLabel(x.unit)} stock → ${sh.kind === 'shift' ? `the whole series uses a diluted stock <b>${x.name || 'drug'} - 1:${sh.factor}</b>` : `a second stock <b>${x.name || 'drug'} - 1:${sh.factor}</b> (${+(x.stock / sh.factor).toPrecision(3)} ${unitLabel(x.unit)}) dispenses them`}: one more solution to prepare and one more dispense head</span>`);
        else msgs.push(`<span style="color:var(--warn)">${below.length} level${below.length > 1 ? 's' : ''} below one drop of the stock (${ctx.fmt(rg.min, 2)}): ${sh?.kind === 'impossible' ? 'even a 1:9000 dilution is not enough — use a lower stock' : 'they will be flagged — tick "Add a diluted stock" on the Plates step, or use a lower stock'}</span>`);
      }
      if (above.length) msgs.push(`<span style="color:var(--danger)">${above.length} level${above.length > 1 ? 's' : ''} above ${ctx.fmt(rg.max, 3)}: more DMSO than the ${W.dmsoPct} % limit allows with this stock (with ${W.partners.some((p) => p.drug !== -1) ? 'two drugs sharing the limit' : 'one drug'}) — use a more concentrated stock or a lower top</span>`);
      el.innerHTML = `<span class="pill">${stepLabel(o)}</span> ${lv.map((v) => ctx.fmt(v, 3)).join(' · ')} → <b>${n} ${axisName}</b> of ${axisLen}${rg ? ` · valid range of this stock ${ctx.fmt(rg.min, 2)}–${ctx.fmt(rg.max, 2)}` : ''}${msgs.length ? '<br>' + msgs.join('<br>') : ''}`;
    } catch (e) { el.textContent = o.high ? e.message : 'Enter the top concentration'; }
  };
  show(W.primary, $w('lv_p'), inner.cols, 'columns');
  W.partners.forEach((o, i) => show(o, $w(`lv_${i}`), inner.rows, 'rows'));
}

/** What the current design needs: plates, cassettes / heads, solutions to prepare, warnings (HTML). */
function needsHtml(pv, ctx) {
  const { esc } = ctx;
  const { protocol, computed, plan, first, stockNotes } = pv;
  const nPl = protocol.plates.length - first;
  const names = splitNames(W.cellLines), split = W.cellMode.startsWith('split');
  const sets = W.cellMode === 'perLine' ? Math.max(1, names.length) : split ? Math.max(1, Math.ceil(names.length / 2)) : 1;
  let dmso = 0, low = 0;
  computed.forEach(({ wells }, pi) => { if (pi < first) return; for (const w of wells.values()) for (const x of w.warnings) { if (x.code === 'dmso_limit') dmso++; if (x.code === 'below_min_volume') low++; } });
  const byType = {}; for (const c of plan.cassettes) { const t = (byType[c.type] ||= { n: 0, heads: 0 }); t.n++; t.heads += c.heads.length; }
  const cas = Object.entries(byType).map(([t, x]) => `${x.n} × ${t} cassette${x.n > 1 ? 's' : ''} (${x.heads} of ${x.n * (t === 'T8+' ? 8 : 4)} heads used)`).join(' + ') || '–';
  const sol = plan.fluids.map((f) => `${esc(f.name)}: ${f.heads.length} head${f.heads.length > 1 ? 's' : ''}, load ${+f.load.toFixed(1)} µL`).join('<br>');
  const L = [];
  L.push(`<b>${nPl} plate${nPl > 1 ? 's' : ''}</b> = ${W.partners.length} layout${W.partners.length > 1 ? 's' : ''} × ${W.reps} plate replicate${W.reps > 1 ? 's' : ''}${sets > 1 ? ` × ${sets} ${split ? 'cell-line pairs' : 'cell lines'}` : ''}.`);
  L.push(`<b>Cassettes:</b> ${cas}. A head holds one solution; one solution needs several heads when it dispenses more than a head takes (20 µL on a T8+ head, 10 µL while any well gets less than 1 nL; 200 µL on a D4+ head).`);
  L.push(`<b>${plan.fluids.length} solution${plan.fluids.length > 1 ? 's' : ''} to load</b> (exact per-head volumes in the Run tab):<br>${sol}`);
  for (const n of stockNotes || []) {
    if (n.kind === 'impossible') L.push(`<span style="color:var(--warn)">⚠ ${esc(n.drug)}: ${n.levels.length} level(s) stay below one drop even after a 1:9000 dilution.</span>`);
    else L.push(`<span style="color:var(--accent)">${esc(n.fluid)} = ${esc(n.drug)} stock diluted 1:${n.factor} ${n.kind === 'shift' ? 'replaces the stock for the whole series' : `dispenses ${n.levels.map((v) => ctx.fmt(v, 3)).join(', ')} µM`}.</span>`);
  }
  if (W.randomize) L.push(W.cellMode === 'none' || !names.length ? '<span style="color:var(--warn)">Randomization skipped: assign cell lines in this wizard.</span>' : 'Well positions are randomized within each cell line (one permutation per plate, stored in the .tdd).');
  L.push(dmso || low ? `<span style="color:var(--warn)">⚠ ${dmso ? `${dmso} wells over the DMSO limit` : ''}${dmso && low ? ', ' : ''}${low ? `${low} wells below the smallest drop` : ''}.</span>` : '<span style="color:var(--ok)">✓ Every well can be dispensed within the DMSO limit.</span>');
  return L.join('<br>');
}
function summary(ctx, el) {
  if (!el) return;
  try { el.innerHTML = needsHtml(preview(ctx), ctx); el.className = 'callout'; } catch (e) { el.innerHTML = ctx.esc(e.message); el.className = 'callout warn'; }
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
  const axis = (o) => ({ fluidId: o.drug === -1 ? null : ids[o.drug], high: +o.high, low: o.drug === -1 ? null : lowOf(o), factor: o.drug === -1 ? 2 : lowOf(o) != null ? rangeStep(+o.high, lowOf(o), Math.floor(o.levels)) : parseDilution(o.factor).factor, levels: o.drug === -1 ? 0 : Math.floor(o.levels), includeZero: o.drug === -1 ? true : o.zero, replicates: Math.max(1, Math.floor(o.reps)) });
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
  if (W.randomize && W.cellMode !== 'none' && lines.length) {
    randomizeByCellLine(protocol, meta, protocol.plates.map((_, i) => i).filter((i) => i >= first), seededRng(W.seed));
    meta.experiment.randomSeed = W.seed;
  }
  meta.experiment.stockNotes = [...(meta.experiment.stockNotes || []), ...stockNotes];
  const computed = computeProtocol(protocol);
  return { protocol, meta, computed, plan: planRun(protocol, computed), first, stockNotes };
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
