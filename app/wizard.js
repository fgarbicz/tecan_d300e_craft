// Experiment wizard: five steps from "what plates" to "create". Keeps its own state (W) and only touches the
// document once, on Create (one undo step). The layout itself comes from buildExperiment() in
// src/experiment.js, which is tested to rebuild the hand-made D3 protocol byte for byte.

import { newProtocol, wellKey } from '../src/tdd.js';
import { PLATE_TYPES, addFluid, titrationLevels, parseDilution } from '../src/ops.js';
import { computeProtocol, validRange, FLUID_CLASSES, MOLARITY_UNITS, MASS_UNITS, unitLabel, fromDisplay, toDisplay } from '../src/dispense.js';
import { buildExperiment, applyExperiment, newMeta, addCellLine, assignCellLine, isBorder } from '../src/experiment.js';
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
    drugs: drugs.length ? drugs : [{ name: '', stock: 10, unit: 'mM', classId: 0 }, { name: '', stock: 10, unit: 'mM', classId: 0 }],
    primary: { drug: 0, high: '', factor: 3, levels: 8, zero: true, reps: 2 },
    partners: [{ drug: drugs.length > 1 ? 1 : 1, high: '', factor: 2, levels: 6, zero: true, reps: 2, norm: 'block' }],
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
      <input data-a="factor" data-p="${prefix}" value="${o.factor}" title="Any step: 1:3, 1.5, ÷2, ×0.667, −33 %, 1:0.33 (= remove a third)">
      <input data-a="levels" data-p="${prefix}" type="number" min="0" value="${o.levels}">
      <input data-a="reps" data-p="${prefix}" type="number" min="1" value="${o.reps}">
      <label class="chk"><input data-a="zero" data-p="${prefix}" type="checkbox" ${o.zero ? 'checked' : ''}> 0</label>`;
    b.innerHTML = `<p>The <b>primary drug</b> runs along the columns; each <b>partner</b> runs along the rows and gets its own set of ${W.reps} plate${W.reps > 1 ? 's' : ''}. Replicates sit next to each other. Inside the border there are <b>${inner.rows} rows × ${inner.cols} columns</b>.</p>
      <div class="wz-row head"><span>Drug</span><span>Top conc. (µM)</span><span>Dilution step</span><span>Levels</span><span>Replicates</span><span>Add 0</span><span>Normalization</span><span></span></div>
      <div class="wz-row">${axis(W.primary, 'p', false)}<span class="muted">columns</span><span></span></div>
      <div class="wz-levels" id="lv_p"></div>
      ${W.partners.map((o, i) => `<div class="wz-row">${axis(o, i, true)}<select data-a="norm" data-p="${i}">${Object.entries(NORM).map(([k, v]) => `<option value="${k}" ${o.norm === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select><button class="small icon-only" data-delp="${i}" title="Remove">${icon('trash', 14)}</button></div><div class="wz-levels" id="lv_${i}"></div>`).join('')}
      <p><button id="w_addP" class="small">${icon('plus', 14)} Add partner drug</button></p>
      <p class="hint">Dilution step: 1:3 divides by 3 per level; 1.5 or 1:0.33 (remove a third) gives 10 → 6.67 → 4.44 µM. "Add 0" adds a no-drug level, so the matrix contains each drug alone and the vehicle control (both 0). Levels: top, top/N, top/N², … Concentrations in µM for molar stocks.</p>`;
    $w('w_addP').onclick = () => { save(); W.partners.push({ drug: Math.min(W.partners.length + 1, W.drugs.length - 1), high: '', factor: 2, levels: 6, zero: true, reps: 2, norm: 'block' }); draw(ctx); };
    for (const x of b.querySelectorAll('[data-delp]')) x.onclick = () => { save(); W.partners.splice(+x.dataset.delp, 1); draw(ctx); };
    const upd = () => { save(); levelsPreview(ctx); };
    b.oninput = upd; upd();
  } else if (W.step === 3) {
    b.innerHTML = `<p>Which cells go on the plates? Cell lines are stored in the experiment file next to the .tdd (the D300e ignores them) and label every well in the Excel results.</p>
      <div class="form"><label>Cell lines</label><input id="w_cells" value="${esc(W.cellLines)}" placeholder="e.g. MM.1S, KMS-11, U266 (comma separated)">
      <label>Arrangement</label><select id="w_cellMode">
        <option value="same" ${W.cellMode === 'same' ? 'selected' : ''}>One cell line on every plate (the first one)</option>
        <option value="perLine" ${W.cellMode === 'perLine' ? 'selected' : ''}>Each cell line gets its own plates (plates × cell lines)</option>
        <option value="splitRows" ${W.cellMode === 'splitRows' ? 'selected' : ''}>Two cell lines per plate: top half / bottom half</option>
        <option value="splitCols" ${W.cellMode === 'splitCols' ? 'selected' : ''}>Two cell lines per plate: left half / right half</option>
        <option value="none" ${W.cellMode === 'none' ? 'selected' : ''}>Assign later (Annotate tab)</option></select></div>
      <p class="hint" id="w_cellInfo"></p>`;
    const info = () => {
      save(); const n = Math.max(1, splitNames(W.cellLines).length), split = W.cellMode.startsWith('split');
      const sets = W.cellMode === 'perLine' ? n : split ? Math.ceil(n / 2) : 1;
      $w('w_cellInfo').textContent = `${W.partners.length} layout${W.partners.length > 1 ? 's' : ''} × ${W.reps} replicate${W.reps > 1 ? 's' : ''}${sets > 1 ? ` × ${sets} ${split ? 'cell-line pairs' : 'cell lines'}` : ''} = ${W.partners.length * W.reps * sets} plates.`
        + (split ? ' Each half gets the same drug layout, so it must fit in half the plate (check the Layout step).' : '');
    };
    b.oninput = info; info();
  } else if (W.step === 4) {
    let pv;
    try { pv = preview(ctx); } catch (e) { b.innerHTML = `<div class="callout warn">${esc(e.message)}</div>`; return; }
    const { protocol, meta, computed, plan, first } = pv;
    let warn = 0, dmso = 0, low = 0;
    computed.forEach(({ wells }, pi) => { if (pi < first) return; for (const w of wells.values()) for (const x of w.warnings) { warn++; if (x.code === 'dmso_limit') dmso++; if (x.code === 'below_min_volume') low++; } });
    const nPl = protocol.plates.length - first;
    const cass = {}; for (const c of plan.cassettes) cass[c.type] = (cass[c.type] || 0) + 1;
    b.innerHTML = `<div class="wz-preview"><div id="w_mini"></div><div>
      <h3 style="margin-top:0">${nPl} plate${nPl > 1 ? 's' : ''}${W.target === 'append' ? ` added after the current ${first}` : ''}</h3>
      <ul>${(meta.blocks || []).slice(-W.partners.length * Math.max(1, W.cellMode === 'perLine' ? splitNames(W.cellLines).length : 1)).map((bl) => `<li>${esc(bl.name)}${bl.cellLine ? ` · ${esc(bl.cellLine)}` : ''}: plates ${bl.plates.map((p) => p + 1).join(', ')} — ${bl.region.rows} × ${bl.region.cols} wells</li>`).join('')}</ul>
      <p>${warn ? `<span style="color:var(--warn)">⚠ ${warn} well warnings${dmso ? ` (${dmso} over the DMSO limit)` : ''}${low ? ` (${low} below the smallest drop: use a lower top concentration, a diluted stock, or fewer levels)` : ''}</span>` : '<span style="color:var(--ok)">✓ No warnings: every well can be dispensed within the DMSO limit</span>'}</p>
      <p><b>Cassettes:</b> ${Object.entries(cass).map(([t, n]) => `${n} × ${t}`).join(', ') || '–'} · loads per head are in the <b>Run</b> tab after creating.</p>
      <p class="hint">Plate 1 preview on the left: colours = drugs, stripes = PBS border, S = priming well.</p></div></div>`;
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
    W.scrap = $w('w_scrap').checked; W.dontShake = $w('w_shake').checked; W.target = v('w_target');
  } else if (W.step === 1) {
    for (const el of document.querySelectorAll('#wzBody [data-d]')) { const x = W.drugs[+el.dataset.i]; const k = el.dataset.d; x[k] = k === 'stock' || k === 'classId' ? +el.value : el.value; }
  } else if (W.step === 2) {
    for (const el of document.querySelectorAll('#wzBody [data-a]')) {
      const o = el.dataset.p === 'p' ? W.primary : W.partners[+el.dataset.p]; const k = el.dataset.a;
      o[k] = k === 'zero' ? el.checked : k === 'norm' || k === 'high' || k === 'factor' ? el.value : +el.value;
    }
  } else if (W.step === 3 && $w('w_cells')) { W.cellLines = v('w_cells'); W.cellMode = v('w_cellMode'); }
}

function levelsFor(o) {
  const high = +o.high;
  const lv = o.levels > 0 && high > 0 ? titrationLevels({ mode: 'high', distribution: 'dilution', high, factor: parseDilution(o.factor).factor, levels: Math.floor(o.levels) }) : [];
  return o.zero ? [...lv, 0] : lv;
}
function levelsPreview(ctx) {
  const dm = dims(), inner = { rows: dm.rows - 2 * W.border, cols: dm.cols - 2 * W.border };
  const plateLike = { assayVolume: W.assayUL * 1000, dmsoLimit: W.dmsoPct / 100 };
  const show = (o, el, axisLen, axisName) => {
    if (!el) return;
    if (o.drug === -1) { el.innerHTML = `Single drug: ${o.reps} row${o.reps > 1 ? 's' : ''} of replicates.`; return; }
    try {
      const lv = levelsFor(o); const n = lv.length * o.reps;
      const x = W.drugs[o.drug]; const fl = x && { concentration: fromDisplay(x.stock, x.unit), concentrationUnit: x.unit, classId: x.classId, byVol: false };
      const rg = fl && fl.concentration > 0 ? validRange(fl, plateLike, 2) : null;
      const bad = rg ? lv.filter((v) => v && (v < rg.min || v > rg.max)).length : 0;
      el.innerHTML = `<span class="pill">${parseDilution(o.factor).label}</span> ${lv.map((v) => ctx.fmt(v, 3)).join(' · ')} → <b style="color:${n > axisLen ? 'var(--danger)' : 'inherit'}">${n} ${axisName}</b> of ${axisLen}${rg ? ` · valid ${ctx.fmt(rg.min, 2)}–${ctx.fmt(rg.max, 2)}${bad ? ` <span style="color:var(--warn)">(${bad} outside)</span>` : ''}` : ''}`;
    } catch (e) { el.textContent = o.high ? e.message : 'Enter the top concentration'; }
  };
  show(W.primary, $w('lv_p'), inner.cols, 'columns');
  W.partners.forEach((o, i) => show(o, $w(`lv_${i}`), inner.rows, 'rows'));
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
  const axis = (o) => ({ fluidId: o.drug === -1 ? null : ids[o.drug], high: +o.high, factor: o.drug === -1 ? 2 : parseDilution(o.factor).factor, levels: o.drug === -1 ? 0 : Math.floor(o.levels), includeZero: o.drug === -1 ? true : o.zero, replicates: Math.max(1, Math.floor(o.reps)) });
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
  for (const set of sets) {
    const built = buildExperiment(spec, protocol.fluids);
    const at = applyExperiment(protocol, meta, built);
    for (let i = at; i < protocol.plates.length; i++) {
      const p = protocol.plates[i], d = W.border || 0;
      const innerR = p.rows - 2 * d, innerC = p.cols - 2 * d;
      set.forEach((cl, half) => {
        const cells = [];
        for (let r = d; r < p.rows - d; r++) for (let c = d; c < p.cols - d; c++) {
          const h = !split ? 0 : split === 'rows' ? (r - d < Math.floor(innerR / 2) ? 0 : 1) : (c - d < Math.floor(innerC / 2) ? 0 : 1);
          if (h === half) cells.push([r, c]);
        }
        assignCellLine(meta, p, i, cells, cl.id);
      });
    }
    for (const bl of meta.blocks.slice(-built.blocks.length)) bl.cellLine = set.map((c) => c.name).join(' / ');
  }
  const computed = computeProtocol(protocol);
  return { protocol, meta, computed, plan: planRun(protocol, computed), first };
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
  try { localStorage.setItem('d300.wizard', JSON.stringify({ plateType: W.plateType, assayUL: W.assayUL, dmsoPct: W.dmsoPct, border: W.border, reps: W.reps, dontShake: W.dontShake })); } catch { /* not remembered */ }
  const ok = ctx.mutate('experiment wizard', () => {
    if (W.target === 'replace') ctx.replaceDoc();
    ctx.S.protocol = pv.protocol; ctx.S.meta = pv.meta;
    ctx.S.plateIdx = pv.first; ctx.S.sel.clear(); ctx.S.layer = 'drugs'; ctx.S.tab = 'run';
    ctx.S.fluidId = pv.protocol.fluids[0]?.id ?? null; ctx.S.cellLineId = pv.meta.cellLines[0]?.id ?? null;
  });
  if (ok) { document.getElementById('wiz').close(); ctx.toast(`Created ${pv.protocol.plates.length - pv.first} plates. The Run tab shows which cassettes to load.`, 6000); }
}
