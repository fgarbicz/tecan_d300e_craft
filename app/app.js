// Tecan D300 Craft — user interface. All protocol logic lives in ../src (tested with node --test); this file
// is state, rendering and event handling. The experiment layer (cell lines, PBS border, roles, readouts) is
// kept in S.meta and saved next to the .tdd as "<name>.craft.json" (src/experiment.js).

import { parseTdd, writeTdd, newProtocol, wellKey, splitKey, wellName } from '../src/tdd.js';
import { computeProtocol, validRange, fluidTotals, primingIssues, scrapWellValues, PRIMING_VOLUME, FLUID_CLASSES, MOLARITY_UNITS, MASS_UNITS, unitKind, unitLabel, toDisplay, fromDisplay } from '../src/dispense.js';
import { PLATE_TYPES, newPlate, addFluid, removeFluid, setWell, setValue, conflicts, clearWells, titrationLevels, applyTitration, suggestShift, dilutedFluid, extendThreshold,
  buildSynergy, synergyLevels, TITRATION_PATTERNS, NORMALIZE_TYPES, NORMALIZE_PARAM, addNormalization, removeNormalization, removePlate, replicatePlate, clearPlate,
  copyWells, pasteWells, copyNormalization, pasteNormalization } from '../src/ops.js';
import { randomizeByCellLine } from '../src/experiment.js';
import { newMeta, reconcileMeta, serializeMeta, parseMeta, sidecarName, wellRole, assignCellLine, setRole, addCellLine, removeCellLine, ROLE_LABEL,
  metaAddPlate, metaRemovePlate, metaReplicatePlate, metaClearPlate, metaCopyWells, metaPasteWells, isBorder } from '../src/experiment.js';
import { planRun, normalizeUsedHeads } from '../src/cassette.js';
import { drugUnit, setDrugUnit, unitsFor, unitOfFn } from '../src/units.js';
import { cassetteSvg, fluidLook, THEME_VARS, standalone, LIGHT } from '../src/draw.js';
import { icon } from './icons.js';
import { openWizard } from './wizard.js';
import { synergyMatrices, heatmapSvg, exportFigure, chouFor, ciHeatmapSvg, isobologramSvg, normalizedIsobologramSvg, faCiSvg, chouSummaryHtml } from './synergy_view.js';
import { fluidColor as rootFluidColor, DRUG_PALETTE, drugScales, wellBackground, rampColor, rampCss, doseMapSvg, scrapTest } from '../src/dosemap.js';
// Shortcut glyphs: the interface is written with Mac keys; Windows and Linux show Ctrl / Shift instead.
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const keys = (s) => IS_MAC ? s : String(s).replace(/⇧⌘/g, 'Ctrl+Shift+').replace(/⌘-/g, 'Ctrl-').replace(/⇧-/g, 'Shift-').replace(/⌘/g, 'Ctrl+').replace(/⇧/g, 'Shift+');


export const APP_NAME = 'Tecan D300 Craft';
const APP_VERSION = '0.4.0';
const REVISION_USER = `${IS_MAC ? "Mac" : /Win/.test(navigator.platform || navigator.userAgent) ? "Windows" : "Linux"}\\D300 Craft`; // DOMAIN\\user, as D300e Control writes it (was always Mac)

// ---------------- state ----------------
export const S = {
  protocol: null, meta: null, fileName: 'untitled.tdd', fileHandle: null, diskPath: null, dirty: false,
  plateIdx: 0, fluidId: null, cellLineId: null, sel: new Set(), anchor: null, showFluid: 'all', layer: 'drugs',
  undo: [], redo: [], computed: null, clip: null, tab: 'set', form: {}, metaStale: false, resultsMetric: 'viability',
};
export const $ = (id) => document.getElementById(id);
const PALETTE = DRUG_PALETTE; // shared with the dose maps (src/dosemap.js)
export const fluidColor = (f) => rootFluidColor(f); // a diluted stock has its root drug's colour
export const plate = () => S.protocol.plates[S.plateIdx];
export const fluidById = (id) => S.protocol.fluids.find((f) => f.id === id);
const cellLineById = (id) => S.meta.cellLines.find((c) => c.id === id);

function snapshot() { return { protocol: structuredClone(S.protocol), meta: structuredClone(S.meta) }; }
function restore(s) { S.protocol = s.protocol; S.meta = s.meta; }
/** Every change goes through here: one undo step, recompute, re-render. Throwing inside fn rolls back. */
export function mutate(label, fn) {
  const before = snapshot();
  try { fn(); } catch (e) { restore(before); toast(e.message, 6000); render(); return false; }
  S.undo.push({ label, state: before }); if (S.undo.length > 200) S.undo.shift();
  S.redo = []; S.dirty = true; recompute(); render();
  return true;
}
function undo() { const u = S.undo.pop(); if (!u) return; S.redo.push({ label: u.label, state: snapshot() }); restore(u.state); afterHistory(`Undid ${u.label}`); }
function redo() { const r = S.redo.pop(); if (!r) return; S.undo.push({ label: r.label, state: snapshot() }); restore(r.state); afterHistory(`Redid ${r.label}`); }
function afterHistory(msg) { S.plateIdx = Math.min(S.plateIdx, Math.max(0, S.protocol.plates.length - 1)); S.dirty = true; recompute(); render(); toast(msg); }

function recompute() {
  try { S.computed = computeProtocol(S.protocol); } catch (e) { S.computed = null; console.error(e); toast(`Volume calculation failed: ${e.message}`); }
  try { S.plan = S.computed ? planRun(S.protocol, S.computed, { usedT8Heads: S.meta?.settings?.usedT8Heads }) : null; } catch (e) { S.plan = null; console.error(e); }
}

export function toast(msg, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------------- units ----------------
const fluidKind = (f) => (f.byVol ? 'volume' : unitKind(f.concentrationUnit));
// Doses are shown and typed in each drug's own unit (experiment file: meta.drugUnits); the .tdd keeps µM / ng/mL.
export const wellUnit = (f) => drugUnit(S.meta, S.protocol, f);
const cv = (f, v) => (f && v != null ? toDisplay(v, wellUnit(f)) : v);  // stored value → shown number
const cb = (f, x) => (f ? fromDisplay(x, wellUnit(f)) : x);              // typed number → stored value
export const fmt = (x, d = 4) => (x == null || Number.isNaN(x) ? '–' : Math.abs(x) >= 1e4 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(d - 1) : Number(x.toPrecision(d)).toString());
const stockDisplay = (f) => (f.byVol ? '' : `${fmt(toDisplay(f.concentration, f.concentrationUnit), 5)} ${unitLabel(f.concentrationUnit)}`);
export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------------- in-app dialogs (no window.confirm/prompt: they may not block in the desktop shell) ----------------
export function dialog(html, onOk, okLabel = 'OK', { danger = false, cancel = 'Cancel' } = {}) {
  const d = $('dlg'), f = $('dlgForm');
  f.innerHTML = `${html}<div class="actions" style="margin-top:14px;display:flex;gap:6px;justify-content:flex-end">${cancel ? `<button value="cancel" formnovalidate>${cancel}</button>` : ''}<button value="ok" class="primary${danger ? ' danger-fill' : ''}">${okLabel}</button></div>`;
  d.returnValue = ''; d.showModal();
  return new Promise((resolve) => {
    d.onclose = () => { if (d.returnValue === 'ok') { const ok = onOk ? onOk(f) : true; resolve(ok); } else resolve(false); };
  });
}
export const ask = (question, okLabel = 'OK', opts = {}) => dialog(`<p style="max-width:420px">${question}</p>`, null, okLabel, opts);
export function askText(title, value = '', label = 'Name') {
  return new Promise((resolve) => {
    dialog(`<h3>${esc(title)}</h3><div class="form"><label>${esc(label)}</label><input name="v" required value="${esc(value)}" autofocus></div>`,
      (f) => { resolve(String(new FormData(f).get('v')).trim()); return true; }).then((ok) => { if (!ok) resolve(null); });
  });
}

// ---------------- file I/O ----------------
// Inside the desktop app (Tauri) files go through the Rust engine: native dialogs, and every .tdd save is
// cross-checked by d300-core before anything is written. In a browser the web file APIs are used.
const TAURI = window.__TAURI__?.core;
export const invoke = (cmd, args) => TAURI.invoke(cmd, args);
export const inTauri = !!TAURI;

async function confirmDiscard() { return !S.dirty || ask('Discard unsaved changes?', 'Discard', { danger: true }); }

async function openFile() {
  if (!(await confirmDiscard())) return;
  if (TAURI) {
    try { const r = await invoke('open_tdd'); if (r) { loadText(r.text, r.name, null, r.sidecar ?? null); S.diskPath = r.path; render(); } }
    catch (e) { toast(String(e), 8000); }
    return;
  }
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description: 'D300e protocol', accept: { 'application/xml': ['.tdd'] } }] });
      loadText(await (await h.getFile()).text(), h.name, h);
    } catch (e) { if (e.name !== 'AbortError') toast(e.message); }
  } else $('fileInput').click();
}

export function loadText(text, name, handle = null, sidecarText = null) {
  try {
    const p = parseTdd(text);
    let meta = null, stale = false, note = '';
    if (sidecarText) {
      try { ({ meta, stale } = parseMeta(sidecarText, p)); note = stale ? ' — the protocol changed since the experiment file was saved; check cell lines and roles' : ', experiment file loaded'; }
      catch (e) { note = ` (experiment file could not be read: ${e.message}; it will be kept as a backup when you save)`; }
    }
    S.protocol = p; S.meta = meta || reconcileMeta(null, p); S.metaStale = stale;
    S.fileName = name; S.fileHandle = handle; S.dirty = false; S.undo = []; S.redo = [];
    S.plateIdx = 0; S.sel.clear(); S.fluidId = p.fluids[0]?.id ?? null; S.cellLineId = S.meta.cellLines[0]?.id ?? null;
    hideStart(); recompute(); render(); toast(`Opened ${name}: ${p.fluids.length} fluids, ${p.plates.length} plates${note}`, stale ? 9000 : 4000);
  } catch (e) { toast(`Could not open ${name}: ${e.message}`, 8000); }
}

function localIsoWithOffset(d = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

function serialize() {
  const p = structuredClone(S.protocol);
  p.revisions = [...(p.revisions || []), { time: localIsoWithOffset(), userId: REVISION_USER }];
  p.thumbnail = renderThumbnail(p) ?? p.thumbnail;
  return writeTdd(p);
}
async function save(as = false) {
  const text = serialize();
  let name = S.fileName.endsWith('.tdd') ? S.fileName : `${S.fileName}.tdd`;
  try {
    const saved = parseTdd(text);
    if (TAURI) {
      const r = await invoke('save_tdd', { path: as ? null : S.diskPath || null, suggested: name, text });
      if (!r) return; // dialog cancelled
      S.diskPath = r.path; name = r.name;
      await invoke('save_sidecar', { tddPath: r.path, text: serializeMeta(S.meta, saved, name) });
    } else if (window.showSaveFilePicker) {
      let h = as ? null : S.fileHandle;
      if (!h) h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'D300e protocol', accept: { 'application/xml': ['.tdd'] } }] });
      const w = await h.createWritable(); await w.write(new Blob([text], { type: 'application/xml' })); await w.close();
      S.fileHandle = h; name = h.name;
      download(sidecarName(name), serializeMeta(S.meta, saved, name), 'application/json');
    } else {
      if (as) { const n = await askText('Save as', name, 'File name'); if (!n) return; name = n.endsWith('.tdd') ? n : `${n}.tdd`; }
      download(name, text, 'application/xml');
      download(sidecarName(name), serializeMeta(S.meta, saved, name), 'application/json');
    }
    // keep the revision we just wrote
    S.protocol = saved; S.fileName = name; S.dirty = false; S.metaStale = false; recompute(); render(); toast(`Saved ${name} and ${sidecarName(name)}`);
  } catch (e) { if (e?.name !== 'AbortError') toast(`Save failed: ${e?.message ?? e}`, 10000); }
}
export function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// 140x95 PNG of the first plate, like the thumbnail D300e Control stores (its exact look is not reproduced).
function renderThumbnail(p) {
  const pl = p.plates[0]; if (!pl) return null;
  const c = document.createElement('canvas'); c.width = 140; c.height = 95;
  const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, 140, 95);
  const cw = 136 / pl.cols, ch = 91 / pl.rows;
  for (let r = 0; r < pl.rows; r++) for (let col = 0; col < pl.cols; col++) {
    const m = pl.wells.get(wellKey(r, col));
    g.fillStyle = m && m.size ? PALETTE[[...m.keys()][0] % PALETTE.length] : '#e6e8ec';
    g.beginPath(); g.arc(2 + cw * (col + 0.5), 2 + ch * (r + 0.5), Math.max(0.6, Math.min(cw, ch) * 0.4), 0, 7); g.fill();
  }
  return c.toDataURL('image/png').split(',')[1];
}

// ---------------- rendering ----------------
export function render() {
  if (!S.protocol) return;
  $('fileName').textContent = S.fileName;
  $('dirty').hidden = !S.dirty;
  $('btnUndo').disabled = !S.undo.length; $('btnRedo').disabled = !S.redo.length;
  $('btnUndo').title = S.undo.length ? keys(`Undo ${S.undo.at(-1).label} (⌘Z)`) : 'Undo';
  $('btnPaste').disabled = !S.clip;
  renderFluids(); renderCellLines(); renderPlates(); renderPlateParams(); renderSettings(); renderShowSelect(); renderGrid(); renderInspector(); renderOpPanel(); renderStatus();
}

function renderFluids() {
  const t = $('fluidTable');
  t.innerHTML = S.protocol.fluids.length ? '' : '<tr><td class="muted">No drugs yet. Add one, or start with the experiment wizard.</td></tr>';
  for (const f of S.protocol.fluids) {
    const tr = document.createElement('tr'); if (f.id === S.fluidId) tr.className = 'active';
    const cls = FLUID_CLASSES[f.classId]?.short ?? `class ${f.classId}`;
    tr.innerHTML = `<td><span class="swatch" style="background:${fluidColor(f)}"></span></td><td>${esc(f.name)}</td><td class="muted">${f.byVol ? 'by volume' : esc(stockDisplay(f))}</td><td class="muted">${esc(cls)}</td><td>${f.byVol || f.rootFluidId != null ? '' : `<select class="unit-pick" data-unit="${f.id}" title="Unit for this drug's doses: what you read and type. The file for the D300e is not affected.">${unitsFor(f).map((u) => `<option value="${u}" ${u === wellUnit(f) ? 'selected' : ''}>${unitLabel(u)}</option>`).join('')}</select>`}</td><td><button class="small icon-only" data-edit="${f.id}" title="Edit">${icon('edit', 14)}</button></td>`;
    tr.onclick = (e) => { if (e.target.closest('[data-unit]')) return; const b = e.target.closest('[data-edit]'); if (b) return editFluid(fluidById(+b.dataset.edit)); S.fluidId = f.id; render(); };
    tr.querySelector('[data-unit]')?.addEventListener('change', (e) => mutate('dose unit', () => setDrugUnit(S.meta, S.protocol, f, e.target.value)));
    t.appendChild(tr);
  }
}

function renderCellLines() {
  const el = $('cellLineList');
  el.innerHTML = S.meta.cellLines.length ? '' : '<span class="muted" style="font-size:12px">None yet. Cell lines are saved with the experiment, not in the .tdd.</span>';
  for (const c of S.meta.cellLines) {
    const n = S.meta.plates.reduce((s, p) => s + Object.values(p.cellLines).filter((x) => x === c.id).length, 0);
    const chip = document.createElement('span'); chip.className = 'chip' + (c.id === S.cellLineId ? ' active' : '');
    chip.title = `${c.name}: ${n} wells. Click to pick, double-click to rename.`;
    chip.innerHTML = `<span class="dot" style="background:${c.color}"></span>${esc(c.name)} <span class="muted">${n}</span><span class="x" data-del="${c.id}" title="Remove">×</span>`;
    chip.onclick = async (e) => {
      if (e.target.dataset.del) { if (await ask(`Remove cell line <b>${esc(c.name)}</b> from all wells?`, 'Remove', { danger: true })) mutate('remove cell line', () => removeCellLine(S.meta, c.id)); return; }
      S.cellLineId = c.id; S.tab = 'annotate'; if (S.layer === 'drugs') S.layer = 'cells'; render();
    };
    chip.ondblclick = async () => { const n2 = await askText('Rename cell line', c.name); if (n2) mutate('rename cell line', () => { cellLineById(c.id).name = n2; }); };
    el.appendChild(chip);
  }
}
async function addCellLineUi() {
  const name = await askText('Add cell line', '', 'Name (e.g. MM.1S)');
  if (!name) return;
  mutate('add cell line', () => { const c = addCellLine(S.meta, name); S.cellLineId = c.id; });
  S.tab = 'annotate'; S.layer = 'cells'; render();
}

function renderPlates() {
  const ol = $('plateList'); ol.innerHTML = '';
  S.protocol.plates.forEach((p, i) => {
    const li = document.createElement('li'); if (i === S.plateIdx) li.className = 'active';
    const nW = [...p.wells.values()].filter((m) => m.size).length;
    const pm = S.meta.plates[i];
    const cls = pm ? [...new Set(Object.values(pm.cellLines))].map((id) => cellLineById(id)?.name).filter(Boolean) : [];
    li.innerHTML = `${icon('plate', 15)}<span class="pn">${i + 1}. ${esc(p.name || PLATE_TYPES[p.plateType]?.label || p.plateType)}${cls.length ? ` <span class="muted">· ${esc(cls.join(', '))}</span>` : ''}</span>${pm?.readout ? '<span class="badge ok" title="Readout pasted">data</span>' : ''}<span class="muted">${nW}</span>`;
    li.onclick = () => { S.plateIdx = i; S.sel.clear(); render(); };
    ol.appendChild(li);
  });
  const none = !S.protocol.plates.length;
  for (const id of ['btnReplicatePlate', 'btnRemovePlate']) $(id).disabled = none;
}

function renderPlateParams() {
  const el = $('plateParams'); const p = plate();
  if (!p) { el.innerHTML = '<h2>Plate</h2><p class="muted">Add a plate to start.</p>'; return; }
  el.innerHTML = `<h2><span>Plate ${S.plateIdx + 1} settings</span></h2><div class="form">
    <label>Type</label><span>${esc(PLATE_TYPES[p.plateType]?.label || p.plateType)} (${p.rows}×${p.cols})</span>
    <label>Name</label><input id="ppName" value="${esc(p.name || '')}" placeholder="optional">
    <label title="Volume already in the well before dispensing (medium + cells)">Well volume</label><span><input id="ppAssay" type="number" step="any" value="${p.assayVolume / 1000}"> µL</span>
    <label>DMSO limit</label><span><input id="ppDmso" type="number" step="any" value="${+(p.dmsoLimit * 100).toPrecision(10)}"> %</span>
    <label class="full chk"><input type="checkbox" id="ppDontShake" ${p.dontShake ? 'checked' : ''}> Don't shake</label>
    <label class="full chk"><input type="checkbox" id="ppDeion" ${p.deionize ? 'checked' : ''}> Deionize</label>
    <label class="full chk"><input type="checkbox" id="ppPrompt" ${p.promptPlateLoad ? 'checked' : ''}> Prompt plate load</label></div>`;
  const bind = (id, fn) => { $(id).onchange = (e) => mutate('plate settings', () => fn(e.target)); };
  bind('ppName', (t) => { p.name = t.value; });
  bind('ppAssay', (t) => { const v = +t.value; if (!(v >= 0)) throw new Error('Well volume must be ≥ 0'); p.assayVolume = v * 1000; });
  bind('ppDmso', (t) => { const v = +t.value; if (!(v > 0 && v <= 100)) throw new Error('DMSO limit must be between 0 and 100 %'); p.dmsoLimit = v / 100; });
  bind('ppDontShake', (t) => { p.dontShake = t.checked; });
  bind('ppDeion', (t) => { p.deionize = t.checked; });
  bind('ppPrompt', (t) => { p.promptPlateLoad = t.checked; });
}

function renderSettings() {
  const s = S.protocol.settings;
  const b = (k, label) => `<label class="full chk"><input type="checkbox" data-set="${k}" ${s[k] === 'True' ? 'checked' : ''}> ${label}</label>`;
  $('protocolSettings').innerHTML = `<div class="form">
    ${b('ShakePerWell', 'Shake during dispense')}
    <label>Threshold</label><span><input data-num="ShakeThresholdVolume" type="number" value="${esc(s.ShakeThresholdVolume ?? '')}"> nL</span>
    ${b('ShakePerFluid', 'Shake after each dispense head')}
    <label>Duration</label><span><input data-num="ShakePlateDuration" type="number" value="${esc(s.ShakePlateDuration ?? '')}"> s</span>
    <label>Normalize order</label><select data-sel="BackfillOrder">${['Before', 'Mixed', 'After'].map((o) => `<option ${s.BackfillOrder === o ? 'selected' : ''} value="${o}">${o === 'Mixed' ? 'With the fluids' : o + ' fluids'}</option>`).join('')}</select>
    ${b('BackfillNoDispense', "Don't dispense normalization")}
    ${b('PrioritizeSurfactantFreeCassettes', 'Prioritize surfactant-free cassettes')}
    ${b('FluidOrderRun', 'Run in fluid order')}
    ${b('BlockFluidOnCellFail', 'Block fluid on cell fail')}
    </div>`;
  for (const i of $('protocolSettings').querySelectorAll('[data-set]')) i.onchange = () => mutate('protocol settings', () => { s[i.dataset.set] = i.checked ? 'True' : 'False'; });
  for (const i of $('protocolSettings').querySelectorAll('[data-num]')) i.onchange = () => mutate('protocol settings', () => { if (!(+i.value >= 0)) throw new Error('Must be ≥ 0'); s[i.dataset.num] = String(+i.value); });
  for (const i of $('protocolSettings').querySelectorAll('[data-sel]')) i.onchange = () => mutate('protocol settings', () => { s[i.dataset.sel] = i.value; });
}

function renderShowSelect() {
  const sel = $('showFluid');
  sel.innerHTML = `<option value="all">All drugs</option>` + S.protocol.fluids.map((f) => `<option value="${f.id}" ${String(f.id) === String(S.showFluid) ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  if (S.showFluid !== 'all' && !fluidById(+S.showFluid)) S.showFluid = 'all';
  sel.value = String(S.showFluid);
  $('showFluidBox').hidden = S.layer !== 'drugs' && S.layer !== 'doses';
  for (const b of $('layerSeg').children) b.classList.toggle('on', b.dataset.layer === S.layer);
}

function wellResult(r, c) { return S.computed?.[S.plateIdx]?.wells.get(wellKey(r, c)); }
const ROLE_COLOR = { pbs: 'transparent', scrap: '#f08c00', blank: '#ffffff', exclude: '#c92a2a', vehicle: '#2f9e44', treated: '#868e96', empty: 'transparent' };
const ROLE_MARK = { scrap: 'S', blank: 'B', vehicle: 'V' };

function readoutValue(pi, r, c) {
  const ro = S.meta.plates[pi]?.readout; if (!ro?.values) return null;
  const v = ro.values[r]?.[c]; return v == null || Number.isNaN(v) ? null : v;
}

function renderGrid() {
  const g = $('plateGrid'); const p = plate();
  if (!p) { g.innerHTML = ''; $('legend').innerHTML = ''; return; }
  const size = p.cols > 24 ? 12 : p.cols > 12 ? 24 : 36;
  g.style.gridTemplateColumns = `20px repeat(${p.cols}, ${size}px)`;
  g.style.gridAutoRows = `${size}px`;
  const frag = document.createDocumentFragment();
  const hdr = (txt, fn, title) => { const d = document.createElement('div'); d.className = 'hdr'; d.textContent = txt; d.onclick = fn; if (title) d.title = title; frag.appendChild(d); };
  hdr('⌗', () => selectRect(0, 0, p.rows - 1, p.cols - 1), 'Select all');
  for (let c = 0; c < p.cols; c++) hdr(p.cols > 24 && c % 2 ? '' : c + 1, (e) => selectLine('col', c, e), keys(`Column ${c + 1} (⌘-click to add)`));
  const showId = S.showFluid === 'all' ? null : +S.showFluid;
  const range = showId != null ? fluidRange(p, showId) : null;
  const normSet = new Set(S.protocol.backfills.flatMap((b) => b.wells.filter((w) => w.p === S.plateIdx).map((w) => wellKey(w.r, w.c))));
  const pm = S.meta.plates[S.plateIdx];
  const res = S.layer === 'results' ? resultsScale(S.plateIdx) : null;
  const doseSkip = S.layer === 'doses' ? doseScrap() : null;
  const doses = doseSkip ? drugScales(S.protocol, { skip: doseSkip }) : null;
  // Randomized plate, "as printed" view: every position shows the planned well that the D300e dispenses INTO it.
  const printed = printedView(), from = new Map(), to = new Map();
  for (const x of p.randomization || []) { from.set(wellKey(x.toR, x.toC), [x.r, x.c]); to.set(wellKey(x.r, x.c), [x.toR, x.toC]); }
  g.classList.toggle('printed', printed);
  for (let r = 0; r < p.rows; r++) {
    hdr(rowLabel(r), (e) => selectLine('row', r, e), `Row ${rowLabel(r)}`);
    for (let c = 0; c < p.cols; c++) {
      const pk = wellKey(r, c), d = document.createElement('div');
      const [sr, sc] = printed ? from.get(pk) || [r, c] : [r, c];   // planned well shown at this position
      const [vr, vc] = printed ? [r, c] : to.get(pk) || [r, c];     // position where its signal is read
      const k = wellKey(sr, sc), m = p.wells.get(k);
      d.className = 'well'; d.dataset.r = r; d.dataset.c = c;
      if (S.sel.has(pk) && !printed) d.classList.add('sel');
      const role = wellRole(S.meta, p, S.plateIdx, sr, sc);
      if (role === 'pbs') d.classList.add('pbs');
      if (role === 'exclude') d.classList.add('excl');
      const wr = wellResult(sr, sc);
      if (wr && wr.warnings.length && S.layer === 'drugs') d.classList.add('warn');
      if (S.layer === 'drugs') {
        if (m && m.size) {
          if (showId != null) { const v = m.get(showId); if (v) d.style.background = heat(fluidById(showId), v, range); }
          else {
            const cols = [...m.keys()].map((id) => tint(fluidColor(fluidById(id) || { id }), 0.8));
            d.style.background = cols.length === 1 ? cols[0] : `conic-gradient(${cols.map((col, i) => `${col} ${(i * 360) / cols.length}deg ${((i + 1) * 360) / cols.length}deg`).join(', ')})`;
          }
        }
        if (role === 'scrap') mark(d, 'S');
        if ($('showNorm').checked && normSet.has(k)) { const n = document.createElement('span'); n.className = 'norm'; d.appendChild(n); }
      } else if (S.layer === 'doses') {
        const bg = wellBackground(m, doses, showId);
        if (bg) d.style.background = bg;
        if (role === 'scrap' || doseSkip(S.plateIdx, k)) { d.classList.add('scrap-ring'); mark(d, 'S'); }
        else if (role === 'vehicle') mark(d, 'V');
      } else if (S.layer === 'cells') {
        const clk = wellKey(vr, vc); // cells are where they were seeded
        const cl = pm?.cellLines[clk] && cellLineById(pm.cellLines[clk]);
        if (cl) d.style.background = tint(cl.color, m && m.size ? 0.85 : 0.45);
        if (role === 'blank' || role === 'scrap') mark(d, ROLE_MARK[role]);
      } else if (S.layer === 'roles') {
        if (role !== 'pbs' && role !== 'empty') d.style.background = role === 'treated' ? tint('#868e96', 0.35) : tint(ROLE_COLOR[role], role === 'blank' ? 1 : 0.7);
        if (role === 'blank') d.style.border = '1px solid var(--muted)';
        if (ROLE_MARK[role]) mark(d, ROLE_MARK[role]);
      } else if (S.layer === 'results' && res) {
        const v = res.value(vr, vc);
        if (v != null) d.style.background = res.color(v);
      }
      d.title = (printed && (sr !== r || sc !== c) ? `Position ${wellName(r, c)} is printed with planned well ${wellName(sr, sc)}\n` : !printed && (vr !== r || vc !== c) ? `Printed into ${wellName(vr, vc)} (randomized)\n` : '') + wellTitle(sr, sc, role);
      frag.appendChild(d);
    }
  }
  g.replaceChildren(frag);
  renderLegend(showId, range, res, doses);
  renderRandBar();
}
/** A randomized plate can be looked at as planned (editable) or as the D300e prints it (shuffled, read-only). */
const printedView = () => !!(plate()?.randomization?.length && S.viewPrinted !== false);
function renderRandBar() {
  const bar = $('randBar'), p = plate(), n = p?.randomization?.length || 0;
  if (!n) { bar.hidden = true; bar.innerHTML = ''; return; }
  const moved = p.randomization.filter((x) => x.r !== x.toR || x.c !== x.toC).length, pr = printedView();
  bar.hidden = false;
  bar.innerHTML = `<b>${icon('dup', 14)} Randomized</b><span>${moved} wells change place</span>
    <span class="seg"><button class="${pr ? 'active' : ''}" id="rvPrinted" title="Where the D300e actually puts each dose: this is what is on the plate">As printed</button><button class="${pr ? '' : 'active'}" id="rvPlanned" title="The tidy layout you designed. Edit here.">As planned</button></span>
    <button id="rvAgain" title="A new random order, still within each cell line">Shuffle again</button>
    <button id="rvOff" class="danger" title="Remove the randomization: the D300e prints the plate exactly as planned">De-randomize</button>
    <span class="muted">${pr ? 'Read-only view. Switch to "As planned" to edit.' : 'Each well is printed somewhere else on the plate; hover a well to see where.'}</span>`;
  $('rvPrinted').onclick = () => { S.viewPrinted = true; S.sel.clear(); render(); };
  $('rvPlanned').onclick = () => { S.viewPrinted = false; render(); };
  $('rvAgain').onclick = () => mutate('randomize plate', () => randomizeByCellLine(S.protocol, S.meta, [S.plateIdx]));
  $('rvOff').onclick = async () => {
    const all = S.protocol.plates.filter((x) => x.randomization?.length).length;
    if (all > 1) {
      const which = await new Promise((resolve) => { dialog(`<h3>De-randomize</h3><p>${all} plates are randomized.</p><label class="chk"><input type="radio" name="w" value="one" checked> Only plate ${S.plateIdx + 1}</label><br><label class="chk"><input type="radio" name="w" value="all"> All ${all} plates</label>`, (form) => { resolve(new FormData(form).get('w')); return true; }, 'De-randomize').then((ok) => { if (!ok) resolve(null); }); });
      if (!which) return;
      mutate('de-randomize', () => { for (const x of which === 'all' ? S.protocol.plates : [p]) x.randomization = []; });
    } else mutate('de-randomize', () => { p.randomization = []; });
    toast(keys('De-randomized: the plate is printed exactly as planned (⌘Z brings the shuffle back)'));
  };
}
function mark(d, t) { const s = document.createElement('span'); s.className = 'lbl'; s.textContent = t; d.appendChild(s); }

// Dose scales over the whole protocol (same colour = same concentration on every plate), scrap wells left out.
function doseScrap() { return scrapTest(S.protocol, S.meta, wellRole); }
function doseScales() { return drugScales(S.protocol, { skip: doseScrap() }); }
function exportDoseMap(format) {
  const roleOf = (pi, r, c) => wellRole(S.meta, S.protocol.plates[pi], pi, r, c);
  const base = S.fileName.replace(/\.tdd$/, '');
  return exportFigure(doseMapSvg(S.protocol, { title: `${base} — dose map`, roleOf, unitOf: unitOfFn(S.meta, S.protocol) }), `${base}_dosemap`, format, saveBlob);
}

function renderLegend(showId, range, res, doses) {
  const L = $('legend');
  if (S.layer === 'doses') {
    const here = [...doses.values()].filter((sc) => sc.plates.has(S.plateIdx) && (showId == null || sc.fluid.id === showId));
    L.innerHTML = (here.length ? here.map((sc) => `<span class="dose-key"><b>${esc(sc.fluid.name)}</b><span>${fmt(cv(sc.fluid, sc.min), 3)}</span><span class="bar" style="background:${rampCss(sc.color)}"></span><span>${fmt(cv(sc.fluid, sc.max), 3)} ${esc(unitLabel(wellUnit(sc.fluid)))}</span><span class="muted">${sc.levels.length} level${sc.levels.length === 1 ? '' : 's'}</span></span>`).join('')
      : '<span>No drugs on this plate.</span>') +
      '<span class="muted">log scale, same colours on every plate · two drugs: left / right half · S = scrap well (off scale)</span>' +
      `<span class="spacer"></span><button class="small" id="doseSvg">${icon('save', 13)} Dose map SVG</button><button class="small" id="dosePng">PNG</button>`;
    $('doseSvg').onclick = () => exportDoseMap('svg');
    $('dosePng').onclick = () => exportDoseMap('png');
    return;
  }
  if (S.layer === 'drugs') {
    if (showId != null && range) {
      const f = fluidById(showId);
      L.innerHTML = `<span>${esc(f.name)}</span><span>${fmt(cv(f, range.min))}</span><span class="bar" style="background:${rampCss(fluidColor(f))}"></span><span>${fmt(cv(f, range.max))} ${esc(unitLabel(wellUnit(f)))} (log scale)</span>`;
    } else L.innerHTML = S.protocol.fluids.map((f) => `<span><span class="swatch" style="background:${fluidColor(f)}"></span> ${esc(f.name)}</span>`).join('') + legendCommon();
  } else if (S.layer === 'cells') {
    L.innerHTML = S.meta.cellLines.map((c) => `<span><span class="sw" style="background:${c.color}"></span>${esc(c.name)}</span>`).join('') + (S.meta.cellLines.length ? '' : '<span>Add a cell line on the left, select wells, then Annotate → Assign.</span>') + legendCommon();
  } else if (S.layer === 'roles') {
    L.innerHTML = ['treated', 'vehicle', 'blank', 'scrap', 'exclude'].map((r) => `<span><span class="sw" style="background:${r === 'treated' ? tint('#868e96', 0.35) : ROLE_COLOR[r]}"></span>${ROLE_LABEL[r]}</span>`).join('') + legendCommon();
  } else if (S.layer === 'results') {
    L.innerHTML = res ? `<span>${esc(res.label)}</span><span>${fmt(res.min, 3)}</span><span class="bar" style="background:${res.gradient}"></span><span>${fmt(res.max, 3)}</span>` : '<span>No readout for this plate yet — paste it in the Results tab.</span>';
  }
}
const legendCommon = () => (S.meta.settings.borderPBS ? '<span><span class="sw pbs-sw" style="background:repeating-linear-gradient(45deg,var(--accent) 0 2px,transparent 2px 5px)"></span>PBS border</span>' : '') + (S.layer === 'drugs' ? '<span style="color:var(--danger)">● warning</span>' : '');

const rowLabel = (r) => wellName(r, 0).replace(/\d+$/, '');
function fluidRange(p, id) {
  let min = Infinity, max = -Infinity;
  for (const m of p.wells.values()) { const v = m.get(id); if (v) { min = Math.min(min, v); max = Math.max(max, v); } }
  return min <= max ? { min, max } : null;
}
function heat(f, v, rg) {
  const t = rg.max > rg.min ? (Math.log(v) - Math.log(rg.min)) / (Math.log(rg.max) - Math.log(rg.min)) : 1;
  return rampColor(fluidColor(f), t);
}
export function tint(hex, a) {
  if (hex === 'transparent') return hex;
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}
function wellTitle(r, c, role) {
  const m = plate().wells.get(wellKey(r, c)); const res = wellResult(r, c);
  const pm = S.meta.plates[S.plateIdx];
  const lines = [`${wellName(r, c)} — ${ROLE_LABEL[role] || role}`];
  const cl = pm?.cellLines[wellKey(r, c)]; if (cl) lines.push(`Cell line: ${cellLineById(cl)?.name ?? cl}`);
  if (m) for (const [id, v] of m) { const f = fluidById(id); lines.push(`${f?.name ?? id}: ${fmt(cv(f, v), 5)} ${unitLabel(wellUnit(f || { byVol: false, concentrationUnit: 'µM' }))}`); }
  if (res && Number.isFinite(res.totalVolume) && (m?.size || res.normalization)) lines.push(`Total ${fmt(res.totalVolume / 1000, 6)} µL, DMSO ${(res.dmsoFraction * 100).toFixed(3)} %`);
  const v = readoutValue(S.plateIdx, r, c); if (v != null) lines.push(`Readout: ${v}`);
  if (res?.warnings.length) lines.push('⚠ ' + res.warnings.map(warnText).join('; '));
  return lines.join('\n');
}

function renderInspector() {
  const el = $('inspector'); const p = plate();
  if (!p || S.sel.size !== 1) {
    el.innerHTML = `<span class="muted">${p ? (S.sel.size ? `${S.sel.size} wells selected. Select a single well to see its volumes.` : 'Click a well to see its volumes. Hover any well for a summary.') : ''}</span>`;
    return;
  }
  const [r, c] = splitKey([...S.sel][0]); const res = wellResult(r, c);
  const role = wellRole(S.meta, p, S.plateIdx, r, c);
  const cl = S.meta.plates[S.plateIdx]?.cellLines[wellKey(r, c)];
  const head = `<strong>${wellName(r, c)}</strong> <span class="muted">· ${esc(ROLE_LABEL[role] || role)}${cl ? ' · ' + esc(cellLineById(cl)?.name) : ''}</span>`;
  if (!res || (!res.fluids.length && !res.normalization)) { el.innerHTML = `${head}<p class="muted">No drugs in this well.</p>`; return; }
  const rows = res.fluids.map((x) => { const f = fluidById(x.fluidId); const u = unitLabel(wellUnit(f));
    return `<tr><td><span class="swatch" style="background:${fluidColor(f)}"></span> ${esc(f.name)}</td><td>${fmt(cv(f, x.requested), 6)} ${u}</td><td>${x.volume} nL</td><td>${x.dispensed != null ? fmt(cv(f, x.dispensed), 8) + ' ' + u : '–'}</td></tr>`; }).join('');
  el.innerHTML = `${head}
    <table><tr><th>Drug</th><th>Requested</th><th>Dispense</th><th>Actual conc.</th></tr>${rows}
    ${res.normalization ? `<tr><td>Normalization (DMSO)</td><td></td><td>${res.normalization} nL</td><td></td></tr>` : ''}</table>
    <p>Total well volume <b>${fmt(res.totalVolume / 1000, 7)} µL</b> · DMSO <b>${(res.dmsoFraction * 100).toFixed(4)} %</b> (limit ${+(p.dmsoLimit * 100).toPrecision(6)} %)</p>
    ${res.warnings.length ? `<ul class="warnlist">${res.warnings.map((w) => `<li class="w">⚠ ${esc(warnText(w))}</li>`).join('')}</ul>` : ''}`;
}

export function warnText(w) {
  const f = w.fluidId != null ? fluidById(w.fluidId)?.name : '';
  switch (w.code) {
    case 'below_min_volume': return `${f}: this dose needs less than one drop of the stock (${fmt(w.requestedVolume * 1000, 3)} pL; the smallest drop is about 13 pL). Use a more dilute stock, or let the wizard add a diluted stock.`;
    case 'above_max_volume': return `${f}: more than 10 µL of one solution in a well, which the D300e does not do. Use a more concentrated stock.`;
    case 'dmso_limit': return `This well gets ${(w.dmsoFraction * 100).toFixed(3)} % DMSO, more than the limit of ${+(w.limit * 100).toPrecision(6)} %. Use a more concentrated stock, a lower dose, or raise the plate's DMSO limit.`;
    case 'no_solution': return 'These doses cannot be reached: the drug solutions alone would be more than the well holds. Use more concentrated stocks.';
    case 'above_stock': return `${f}: the dose is as high as the stock itself, or higher. Use a more concentrated stock.`;
    case 'no_stock': return `${f}: the stock concentration is not set (pencil button next to the drug).`;
    default: return w.code;
  }
}

function renderStatus() {
  const p = plate();
  const hints = {
    drugs: keys('Drag to select a rectangle · ⇧-click extends · ⌘-click adds wells · click row/column headers for whole lines'),
    cells: 'Pick a cell line (left), select wells, then Annotate → Assign. PBS border wells are skipped automatically.',
    roles: 'Roles: treated and vehicle are automatic; mark blanks (medium only) and excluded wells in Annotate.',
    doses: 'Concentration gradients: pale = lowest, dark = highest dose of each drug (log scale, same colours on every plate). Pick one drug under Show, or export the dose map.',
    results: 'Paste plate-reader values in the Results tab; the map shows them as a heatmap.',
  };
  $('statusHint').textContent = hints[S.layer];
  if (!p) { $('statusInfo').textContent = ''; return; }
  const plan = S.plan;
  const cass = plan ? summarizeCassettes(plan) : '';
  $('statusInfo').textContent = `${S.protocol.plates.length} plate${S.protocol.plates.length === 1 ? '' : 's'} · ${S.protocol.fluids.length} drugs${cass ? ' · ' + cass : ''}`;
}
export function summarizeCassettes(plan) {
  const n = {}; for (const c of plan.cassettes) n[c.type] = (n[c.type] || 0) + 1;
  return Object.entries(n).map(([t, k]) => `${k} × ${t}`).join(', ');
}

// ---------------- selection ----------------
let drag = null;
function cellFromEvent(e) { const t = e.target.closest('.well'); return t ? [+t.dataset.r, +t.dataset.c] : null; }
export function selectRect(r0, c0, r1, c1, add = false) {
  if (!add) S.sel.clear();
  for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) S.sel.add(wellKey(r, c));
  selectionChanged();
}
function selectionChanged() { renderGrid(); renderInspector(); updateOpPanel(); }
function selectLine(kind, i, e) {
  const p = plate(); const add = e.metaKey || e.ctrlKey || e.shiftKey;
  if (kind === 'row') selectRect(i, 0, i, p.cols - 1, add); else selectRect(0, i, p.rows - 1, i, add);
}
export function selectedCells() { return [...S.sel].map(splitKey).sort((a, b) => a[0] - b[0] || a[1] - b[1]); }
function selectInner() {
  const p = plate(); if (!p) return;
  const d = S.meta.settings.borderPBS ? S.meta.settings.borderDepth || 1 : 0;
  selectRect(d, d, p.rows - 1 - d, p.cols - 1 - d);
}

function bindGrid() {
  const g = $('plateGrid');
  g.addEventListener('mousedown', (e) => {
    const cell = cellFromEvent(e); if (!cell) return;
    if (printedView()) { e.preventDefault(); toast('This is the plate as printed (shuffled). Switch to "As planned" above the plate to select and edit wells.'); return; }
    e.preventDefault(); g.focus();
    const add = e.metaKey || e.ctrlKey;
    if (e.shiftKey && S.anchor) { selectRect(S.anchor[0], S.anchor[1], cell[0], cell[1], add); return; }
    if (add) { const k = wellKey(...cell); S.sel.has(k) ? S.sel.delete(k) : S.sel.add(k); S.anchor = cell; selectionChanged(); return; }
    S.anchor = cell; drag = { start: cell }; selectRect(cell[0], cell[1], cell[0], cell[1]);
  });
  g.addEventListener('mouseover', (e) => {
    if (!drag || !(e.buttons & 1)) return; const cell = cellFromEvent(e); if (!cell) return;
    selectRect(drag.start[0], drag.start[1], cell[0], cell[1]);
  });
  window.addEventListener('mouseup', () => { drag = null; });
}

// ---------------- fluids & plates ----------------
function editFluid(f) {
  const isNew = !f;
  f = f || { name: '', byVol: false, concentration: 10000, concentrationUnit: 'mM', classId: 0, maxVolume: 1000, maxVolumeUnit: 'nL' };
  const units = [...Object.keys(MOLARITY_UNITS), ...Object.keys(MASS_UNITS)];
  const usedInWells = !isNew && S.protocol.plates.some((p) => [...p.wells.values()].some((m) => m.has(f.id)));
  dialog(`<h3>${isNew ? 'Add drug / fluid' : 'Edit ' + esc(f.name)}</h3><div class="form">
    <label>Name</label><input name="name" required value="${esc(f.name)}" autofocus>
    <label>Dispense by</label><select name="byVol" ${usedInWells ? 'disabled' : ''}><option value="0" ${!f.byVol ? 'selected' : ''}>Concentration</option><option value="1" ${f.byVol ? 'selected' : ''}>Volume</option></select>
    <label>Stock conc.</label><span><input name="conc" type="number" step="any" min="0" value="${f.byVol ? '' : +toDisplay(f.concentration, f.concentrationUnit).toPrecision(12)}">
      <select name="unit">${units.map((u) => `<option ${u === f.concentrationUnit ? 'selected' : ''} value="${u}">${unitLabel(u)}</option>`).join('')}</select></span>
    <label>Fluid class</label><select name="cls">${Object.entries(FLUID_CLASSES).map(([id, c]) => `<option value="${id}" ${+id === f.classId ? 'selected' : ''}>${c.label}</option>`).join('')}</select>
    </div>${usedInWells ? '<p class="hint muted">Dispense mode cannot change while the fluid is used in wells.</p>' : ''}
    ${isNew ? '' : `<p><button value="delete" class="danger" formnovalidate>${icon('trash', 14)} Delete this fluid</button></p>`}`, (form) => {
    const fd = new FormData(form);
    return mutate(isNew ? 'add fluid' : 'edit fluid', () => {
      const byVol = usedInWells ? f.byVol : fd.get('byVol') === '1';
      const unit = fd.get('unit');
      const conc = byVol ? 0 : +fd.get('conc');
      if (!byVol && !(conc > 0)) throw new Error('Stock concentration must be above 0');
      if (usedInWells && !f.byVol && unitKind(unit) !== unitKind(f.concentrationUnit)) throw new Error('Cannot switch between molarity and mass units while the fluid is used in wells');
      const fields = { name: String(fd.get('name')).trim(), byVol, concentrationUnit: unit, concentration: byVol ? 0 : fromDisplay(conc, unit), classId: +fd.get('cls') };
      if (!fields.name) throw new Error('Name is required');
      if (S.protocol.fluids.some((x) => x !== f && x.name === fields.name)) throw new Error(`A fluid named "${fields.name}" already exists`);
      if (isNew) { const nf = addFluid(S.protocol, fields); S.fluidId = nf.id; }
      else { Object.assign(f, fields); delete f._concText; }
    });
  });
  $('dlgForm').querySelector('[value=delete]')?.addEventListener('click', async (e) => {
    e.preventDefault(); $('dlg').close('cancel');
    if (await ask(`Delete <b>${esc(f.name)}</b> and remove it from all wells?`, 'Delete', { danger: true })) mutate('delete fluid', () => removeFluid(S.protocol, f.id));
  });
}

function addPlateDialog() {
  const cur = plate();
  dialog(`<h3>Add plate</h3><div class="form">
    <label>Type</label><select name="type">${Object.entries(PLATE_TYPES).map(([k, v]) => `<option value="${k}" ${k === (cur?.plateType || 'Default384') ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
    <label>Well volume</label><span><input name="assay" type="number" step="any" value="${(cur?.assayVolume ?? 50000) / 1000}"> µL</span>
    <label>DMSO limit</label><span><input name="dmso" type="number" step="any" value="${+((cur?.dmsoLimit ?? 0.01) * 100).toPrecision(8)}"> %</span></div>`, (form) => {
    const fd = new FormData(form);
    return mutate('add plate', () => {
      const p = newPlate({ plateType: fd.get('type'), assayVolume: +fd.get('assay') * 1000, dmsoLimit: +fd.get('dmso') / 100 });
      if (!(p.assayVolume >= 0) || !(p.dmsoLimit > 0)) throw new Error('Check the volume and DMSO limit');
      S.protocol.plates.push(p); metaAddPlate(S.meta); S.plateIdx = S.protocol.plates.length - 1; S.sel.clear();
    });
  }, 'Add');
}

// ---------------- operation panels ----------------
// Typed values survive re-renders: every input in the panel with an id is remembered per tab (S.form) and
// restored when the panel is rebuilt (a selection change used to wipe what had been typed).
function rememberForm(el) {
  el.addEventListener('input', (e) => { const t = e.target; if (t.id) (S.form[S.tab] ||= {})[t.id] = t.type === 'checkbox' ? t.checked : t.value; });
  el.addEventListener('change', (e) => { const t = e.target; if (t.id) (S.form[S.tab] ||= {})[t.id] = t.type === 'checkbox' ? t.checked : t.value; });
}
function restoreForm(el) {
  const saved = S.form[S.tab]; if (!saved) return;
  for (const [id, v] of Object.entries(saved)) {
    const t = el.querySelector('#' + CSS.escape(id)); if (!t) continue;
    if (t.type === 'checkbox') t.checked = v;
    else if (t.tagName === 'SELECT') { if ([...t.options].some((o) => o.value === v)) t.value = v; }
    else t.value = v;
  }
}

function fluidOptions(sel, filter = () => true) {
  return S.protocol.fluids.filter(filter).map((f) => `<option value="${f.id}" ${f.id === sel ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
}
function rangeHint(fid) {
  const f = fluidById(fid), p = plate(); if (!f || !p) return '';
  if (f.byVol) return 'Volume in nL';
  const { min, max } = validRange(f, p); const u = unitLabel(wellUnit(f));
  return `This stock can give ${fmt(cv(f, min), 3)} – ${fmt(cv(f, max), 3)} ${u} in a well (one drop up to the DMSO limit)`;
}
const selCount = () => `${S.sel.size} well${S.sel.size === 1 ? '' : 's'} selected`;

let panelUpdate = null; // light refresh for the current panel (selection count, enabled buttons)
function updateOpPanel() { if (panelUpdate) panelUpdate(); else renderOpPanel(); renderStatus(); }

function renderOpPanel() {
  for (const b of $('opTabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === S.tab);
  const el = $('opPanel');
  panelUpdate = null;
  const need = (msg) => { el.innerHTML = `<div class="callout">${msg}</div>`; };
  const tabs = { check: renderCheck, run: renderRun, synergy: renderSynergy, annotate: renderAnnotate, results: renderResultsTab };
  if (tabs[S.tab]) { tabs[S.tab](el); restoreForm(el); panelUpdate?.(); return; }
  if (!S.protocol.fluids.length && S.tab !== 'normalize') return need(`No drugs yet. Add one under <b>Drugs</b>, or let the <b>Experiment wizard</b> build the whole layout.`);
  if (!plate()) return need('Add a plate first.');
  if (S.tab === 'normalize') { renderNormalize(el); restoreForm(el); panelUpdate?.(); return; }
  if (S.tab === 'set') renderSet(el);
  if (S.tab === 'titration') renderTitration(el);
  restoreForm(el); panelUpdate?.();
}

function renderSet(el) {
  el.innerHTML = `<p class="hint">Give the selected wells one dose of a drug. Select wells on the plate first.</p><div class="form"><label>Drug</label><select id="opFluid">${fluidOptions(S.fluidId)}</select>
    <label>Value</label><span><input id="opVal" type="number" step="any" min="0"> <span id="opUnit"></span></span></div>
    <p class="hint" id="opRange"></p><p class="hint" id="opSel"></p>
    <div class="actions"><button id="opApply" class="primary">${icon('check', 15)} Apply</button><button id="opRemove">Remove drug from selection</button></div>`;
  const upd = () => { const f = fluidById(+$('opFluid').value); if (!f) return; $('opUnit').textContent = unitLabel(wellUnit(f)); $('opRange').textContent = rangeHint(f.id); };
  $('opFluid').addEventListener('change', () => { S.fluidId = +$('opFluid').value; upd(); });
  panelUpdate = () => { upd(); $('opSel').textContent = selCount(); $('opApply').disabled = $('opRemove').disabled = !S.sel.size; };
  $('opApply').onclick = async () => {
    const fid = +$('opFluid').value, v = cb(fluidById(fid), +$('opVal').value); if (!(v > 0)) return toast('Enter a value above 0');
    const cells = selectedCells();
    if (conflicts(plate(), cells, fid).length && !(await ask(`${esc(fluidById(fid).name)} is already in some selected wells. Replace those values?`, 'Replace'))) return;
    await maybeShift(fid, v, v, (useFid) => setValue(plate(), cells, useFid, v), 'set value');
  };
  $('opRemove').onclick = () => mutate('remove drug from wells', () => clearWells(plate(), selectedCells(), +$('opFluid').value));
}

function renderTitration(el) {
  el.innerHTML = `<p class="hint">A series of doses across the selected wells, e.g. 8 doses × 3 wells each = select 24 wells.</p>
    <div class="form"><label>Drug</label><select id="tFluid">${fluidOptions(S.fluidId, (f) => !f.byVol)}</select>
    <label>Specify by</label><select id="tMode"><option value="highLow">Highest & lowest</option><option value="high">Highest</option><option value="low">Lowest</option></select>
    <label>Highest</label><input id="tHigh" type="number" step="any" min="0">
    <label>Lowest</label><input id="tLow" type="number" step="any" min="0">
    <label>Distribution</label><select id="tDist"></select>
    <label id="tFacL">Factor (1:N)</label><input id="tFac" type="number" step="any" min="1" value="2">
    <label>Replicates</label><input id="tRep" type="number" min="1" value="1">
    <label>Pattern</label><select id="tPat">${Object.entries(TITRATION_PATTERNS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
    </div><p class="hint" id="tRange"></p><p class="hint" id="tInfo"></p><p class="hint" id="tPreview"></p>
    <div class="actions"><button id="tApply" class="primary">${icon('check', 15)} Apply</button></div>`;
  const dists = { highLow: [['log', 'Logarithmic'], ['linear', 'Linear']], high: [['halfLog', '1/2 Log'], ['thirdLog', '1/3 Log'], ['quarterLog', '1/4 Log'], ['dilution', '1:N'], ['linear', 'Linear (increment)']] };
  dists.low = dists.high;
  const read = () => {
    const rep = Math.max(1, Math.floor(+$('tRep').value || 1));
    const tf = fluidById(+$('tFluid').value); // typed in the drug's unit
    return { fid: +$('tFluid').value, mode: $('tMode').value, distribution: $('tDist').value, high: cb(tf, +$('tHigh').value), low: cb(tf, +$('tLow').value), factor: +$('tFac').value, increment: cb(tf, +$('tFac').value), replicates: rep, levels: S.sel.size / rep };
  };
  const fillDist = () => {
    const mode = $('tMode').value; const cur = $('tDist').value || (S.form.titration?.tDist);
    $('tDist').innerHTML = dists[mode].map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');
  };
  const upd = () => {
    const o = read();
    $('tHigh').disabled = o.mode === 'low'; $('tLow').disabled = o.mode === 'high';
    const facUse = o.mode !== 'highLow' && (o.distribution === 'dilution' || o.distribution === 'linear');
    $('tFac').disabled = !facUse; $('tFacL').textContent = o.distribution === 'linear' ? 'Increment' : 'Factor (1:N)';
    $('tRange').textContent = rangeHint(o.fid);
    $('tInfo').textContent = `${selCount()} → ${Number.isInteger(o.levels) && o.levels > 0 ? o.levels + ' levels' : 'not a multiple of the replicates'}`;
    try { const lv = titrationLevels(o); const tf = fluidById(o.fid); $('tPreview').textContent = 'Levels: ' + lv.map((x) => fmt(cv(tf, x), 4)).join(', ') + (tf ? ' ' + unitLabel(wellUnit(tf)) : ''); } catch (e) { $('tPreview').textContent = S.sel.size ? e.message : ''; }
    $('tApply').disabled = !S.sel.size;
  };
  fillDist();
  $('tMode').addEventListener('change', () => { fillDist(); upd(); });
  for (const id of ['tFluid', 'tHigh', 'tLow', 'tDist', 'tFac', 'tRep']) $(id).addEventListener('input', upd);
  $('tFluid').addEventListener('change', () => { S.fluidId = +$('tFluid').value; });
  panelUpdate = () => { fillDist(); upd(); };
  $('tApply').onclick = async () => {
    const o = read(); if (!S.sel.size) return toast('Select wells first');
    let levels; try { levels = titrationLevels(o); } catch (e) { return toast(e.message); }
    const cells = selectedCells();
    if (conflicts(plate(), cells, o.fid).length && !(await ask('This drug is already in some selected wells. Replace those values?', 'Replace'))) return;
    const opts = { replicates: o.replicates, pattern: $('tPat').value };
    await maybeShift(o.fid, Math.max(...levels), Math.min(...levels), (useFid, extendFid, stockMin) => {
      if (extendFid == null) return applyTitration(plate(), cells, useFid, levels, opts);
      // Extension (measured on D300e Control, probe-29): levels up to the threshold use the diluted fluid.
      applyTitration(plate(), cells, useFid, levels.map((l) => (l >= stockMin ? l : 0)), opts);
      applyTitration(plate(), cells, extendFid, levels.map((l) => (l < stockMin ? l : 0)), opts);
    }, 'titration');
  };
}

/** Offer a fluid shift/extension when values fall below the one-drop minimum (§3.6). */
async function maybeShift(fid, high, low, apply, label) {
  const f = fluidById(fid), p = plate();
  const s = f.byVol ? null : suggestShift(f, p, high, low);
  if (!s) return mutate(label, () => apply(fid));
  if (s.kind === 'impossible') { if (await ask('Some values are below the smallest drop even with a 1:9000 dilution. Continue anyway (they will be flagged)?', 'Continue')) mutate(label, () => apply(fid)); return; }
  const verb = s.kind === 'shift' ? 'Shift' : 'Extend';
  const choice = await new Promise((resolve) => {
    dialog(`<h3>Fluid ${s.kind}</h3><p>${esc(f.name)}: the lowest value needs less than one drop from the stock.</p>
      <p>Suggested dilution <b>1:${s.factor}</b> → new fluid <b>${esc(f.name)} - 1:${s.factor}</b> (make this dilution and load it as its own fluid).</p>
      <p class="hint">${s.kind === 'shift' ? 'The whole series will use the diluted fluid.' : 'Doses that need up to about 180 nL of the diluted stock use it; higher doses use the original stock (as D300e Control does).'}</p>
      <label class="chk"><input type="radio" name="c" value="use" checked> Use the ${s.kind === 'shift' ? 'shifted' : 'extended'} fluid</label><br>
      <label class="chk"><input type="radio" name="c" value="no"> Do not ${s.kind} (wells below the minimum are flagged)</label>`, (form) => { resolve(new FormData(form).get('c')); return true; }, verb).then((ok) => { if (!ok) resolve(null); });
  });
  if (!choice) return;
  if (choice === 'no') return mutate(label, () => apply(fid));
  mutate(`${label} (${s.kind} 1:${s.factor})`, () => {
    let d = S.protocol.fluids.find((x) => x.name === `${f.name} - 1:${s.factor}`);
    if (!d) d = dilutedFluid(S.protocol, f, s.factor);
    if (s.kind === 'shift') apply(d.id);
    else apply(fid, d.id, extendThreshold(d.concentration, p) * (1 + 1e-9)); // levels needing ≤ ~180 nL of the dilution use it (probe-29)
  });
}

function renderNormalize(el) {
  el.innerHTML = `<p class="hint">Tops up the selected wells with plain DMSO so they all contain the same amount. Include the no-drug wells: they become the vehicle controls.</p>
    <div class="form"><label>Fluid class</label><select id="nCls">${Object.entries(FLUID_CLASSES).map(([id, c]) => `<option value="${id}">${c.label}</option>`).join('')}</select>
    <label>Method</label><select id="nType">${Object.entries(NORMALIZE_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
    <label id="nParamL">Value</label><span><input id="nPct" type="number" step="any" min="0" value="${+(plate().dmsoLimit * 100).toPrecision(6)}"> <span id="nUnit"></span></span></div>
    <p class="hint" id="nSel"></p><p class="hint">A well belongs to one top-up group at a time; applying again replaces the earlier one.</p>
    <div class="actions"><button id="nApply" class="primary">${icon('normalize', 15)} Normalize selection</button><button id="nRemove">Remove from selection</button></div>
    <h3>Groups</h3><ul class="warnlist">${S.protocol.backfills.map((b, i) => `<li>${i + 1}. ${esc(NORMALIZE_TYPES[b.type] || b.type)}${b.param != null ? ` (${NORMALIZE_PARAM[b.type] === '%' ? +(b.param * 100).toPrecision(6) + ' %' : b.param + ' nL'})` : ''} · ${FLUID_CLASSES[b.classId]?.short ?? b.classId} · ${b.wells.length} wells on plate(s) ${[...new Set(b.wells.map((w) => w.p + 1))].join(', ')} <button class="small" data-g="${i}">Select</button></li>`).join('') || '<li class="muted">None</li>'}</ul>`;
  const upd = () => { const u = NORMALIZE_PARAM[$('nType').value]; $('nPct').disabled = !u; $('nUnit').textContent = u ? (u === '%' ? '% of total' : 'nL') : ''; };
  $('nType').addEventListener('change', upd);
  panelUpdate = () => { upd(); $('nSel').textContent = selCount() + ' on this plate'; $('nApply').disabled = $('nRemove').disabled = !S.sel.size; };
  const wells = () => selectedCells().map(([r, c]) => ({ p: S.plateIdx, r, c }));
  $('nApply').onclick = () => {
    const type = $('nType').value, v = +$('nPct').value, u = NORMALIZE_PARAM[type];
    if (u === '%' && !(v > 0 && v < 100)) return toast('Percent must be between 0 and 100');
    if (u === 'nL' && !(v > 0)) return toast('Volume must be above 0 nL');
    mutate('normalize', () => addNormalization(S.protocol, +$('nCls').value, type, u === '%' ? v / 100 : u === 'nL' ? v : undefined, wells()));
  };
  $('nRemove').onclick = () => mutate('remove normalization', () => removeNormalization(S.protocol, wells()));
  for (const b of el.querySelectorAll('[data-g]')) b.onclick = () => {
    const g = S.protocol.backfills[+b.dataset.g]; const p0 = g.wells[0].p; S.plateIdx = p0; S.sel = new Set(g.wells.filter((w) => w.p === p0).map((w) => wellKey(w.r, w.c))); render();
  };
}

// ---- annotate: cell lines, roles, PBS border ----
function renderAnnotate(el) {
  const st = S.meta.settings;
  el.innerHTML = `<h3 style="margin-top:0">${icon('border', 16)} Evaporation barrier</h3>
    <label class="chk"><input type="checkbox" id="aBorder" ${st.borderPBS ? 'checked' : ''}> Outer wells are PBS / medium (no cells, not analyzed)</label>
    <div class="form" style="margin-top:6px"><label>Border depth</label><select id="aDepth">${[1, 2].map((d) => `<option value="${d}" ${st.borderDepth === d ? 'selected' : ''}>${d} row/column${d > 1 ? 's' : ''}</option>`).join('')}</select></div>
    <p class="hint">Border wells that receive a drug (priming wells) do not count as PBS.</p>
    <h3>${icon('cells', 16)} Cell lines</h3>
    ${S.meta.cellLines.length ? `<div class="form"><label>Cell line</label><select id="aCl">${S.meta.cellLines.map((c) => `<option value="${c.id}" ${c.id === S.cellLineId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>` : '<p class="hint">Add a cell line on the left first.</p>'}
    <p class="hint" id="aSel"></p>
    <div class="actions"><button id="aAssign" class="primary">${icon('cells', 15)} Assign to selection</button><button id="aAssignAll" title="Every well inside the border on this plate">Whole plate</button><button id="aClear">Clear</button></div>
    <div class="actions"><button id="aAllPlates" title="Copy this plate's cell-line map to every plate">${icon('dup', 15)} Same layout on all plates</button></div>
    <h3>${icon('cells', 16)} Randomize</h3>
    <p class="hint">Shuffles which well gets which dose, only among wells of the same cell line, so you still seed the cells as drawn. The D300e prints the shuffled positions; when you paste the read-out, the app sorts it back for you. ${plate().randomization?.length ? `<b>This plate is randomized (${plate().randomization.length} wells).</b>` : ''}</p>
    <div class="actions" style="flex-wrap:wrap"><button id="aRand">Randomize this plate</button><button id="aRandAll">All plates</button><button id="aRandOff" class="danger" ${plate().randomization?.length ? '' : 'disabled'}>De-randomize this plate</button><button id="aRandOffAll" class="danger" ${S.protocol.plates.some((x) => x.randomization?.length) ? '' : 'disabled'}>De-randomize all</button></div>
    <h3>${icon('tag', 16)} Well roles</h3>
    <p class="hint">Wells with drug (treated) and wells with cells but no drug (vehicle control) are recognised automatically. Mark the others:</p>
    <div class="actions" style="flex-wrap:wrap">
      <button data-role="blank" title="Medium only, no cells: background for the readout">Blank</button>
      <button data-role="exclude" title="Leave out of the analysis (e.g. a bad well)">Exclude</button>
      <button data-role="pbs">PBS</button>
      <button data-role="scrap" title="Priming well that takes ≥ 30 nL of a drug">Scrap</button>
      <button data-role="">Automatic</button></div>`;
  $('aBorder').onchange = (e) => mutate('PBS border', () => { st.borderPBS = e.target.checked; });
  $('aDepth').onchange = (e) => mutate('PBS border', () => { st.borderDepth = +e.target.value; });
  $('aCl')?.addEventListener('change', (e) => { S.cellLineId = e.target.value; renderCellLines(); });
  const assign = (cells, label) => {
    const id = $('aCl')?.value; if (!id) return toast('Add a cell line first');
    S.cellLineId = id; let skipped = 0;
    if (mutate(label, () => { skipped = assignCellLine(S.meta, plate(), S.plateIdx, cells, id).skipped; }) && skipped) toast(`${skipped} PBS / blank / scrap wells were skipped`);
    if (S.layer === 'drugs') { S.layer = 'cells'; render(); }
  };
  $('aAssign').onclick = () => assign(selectedCells(), 'assign cell line');
  $('aAssignAll').onclick = () => { const p = plate(); const cells = []; for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) cells.push([r, c]); assign(cells, 'assign cell line to plate'); };
  $('aClear').onclick = () => mutate('clear cell line', () => assignCellLine(S.meta, plate(), S.plateIdx, selectedCells(), null));
  $('aAllPlates').onclick = async () => {
    if (!(await ask(`Copy plate ${S.plateIdx + 1}'s cell-line map to all ${S.protocol.plates.length} plates (replacing theirs)?`, 'Copy'))) return;
    mutate('cell lines on all plates', () => { const src = S.meta.plates[S.plateIdx].cellLines; S.meta.plates.forEach((pm, i) => { if (i !== S.plateIdx) pm.cellLines = { ...src }; }); });
  };
  const randomize = (idx, label) => {
    const before = idx.map((i) => S.protocol.plates[i].randomization);
    S.viewPrinted = true;
    mutate(label, () => randomizeByCellLine(S.protocol, S.meta, idx));
    const done = idx.filter((i) => S.protocol.plates[i].randomization?.length).length;
    toast(done ? `Randomized ${done} plate${done > 1 ? 's' : ''}. The plate now shows where each dose is printed; "De-randomize" above the plate undoes it.` : 'Nothing to shuffle: these plates have no drug wells yet');
    void before;
  };
  $('aRand').onclick = () => randomize([S.plateIdx], 'randomize plate');
  $('aRandAll').onclick = () => randomize(S.protocol.plates.map((_, i) => i), 'randomize all plates');
  $('aRandOff').onclick = () => mutate('de-randomize', () => { plate().randomization = []; });
  $('aRandOffAll').onclick = () => mutate('de-randomize all plates', () => { for (const x of S.protocol.plates) x.randomization = []; });
  for (const b of el.querySelectorAll('[data-role]')) b.onclick = () => { if (!S.sel.size) return toast('Select wells first'); mutate('set role', () => setRole(S.meta, S.plateIdx, selectedCells(), b.dataset.role || null)); if (S.layer === 'drugs') { S.layer = 'roles'; render(); } };
  panelUpdate = () => { $('aSel').textContent = selCount(); $('aAssign').disabled = $('aClear').disabled = !S.sel.size || !S.meta.cellLines.length; $('aAssignAll').disabled = $('aAllPlates').disabled = !S.meta.cellLines.length; };
}

// ---- D300e-style synergy tab (kept for parity with D300e Control) ----
function renderSynergy(el) {
  const fl = S.protocol.fluids.filter((f) => !f.byVol);
  if (fl.length < 2) { el.innerHTML = '<div class="callout">Synergy needs at least two drugs dispensed by concentration. The <b>Experiment wizard</b> also builds synergy matrices, with replicates and cell lines.</div>'; return; }
  const st = renderSynergy.state || (renderSynergy.state = { type: 'ABC', n: 2 });
  const cur = plate();
  const fluidBlock = (i) => `<div class="syn-fluid"><div class="form">
      <label>${st.type === 'AxEach' ? (i === 0 ? 'Primary (rows)' : `Secondary ${i}`) : ['A (rows)', 'B (columns)', 'C', 'D', 'E'][i] || `Fluid ${i + 1}`}</label><select id="sy_fid${i}" data-k="fid" data-i="${i}">${fluidOptions(fl[i % fl.length].id, (f) => !f.byVol)}</select>
      <label>Highest</label><input id="sy_high${i}" data-k="high" data-i="${i}" type="number" step="any">
      <label>Lowest</label><input id="sy_low${i}" data-k="low" data-i="${i}" type="number" step="any">
      <label>Levels</label><input id="sy_lv${i}" data-k="levels" data-i="${i}" type="number" min="1" value="${i < 2 ? 6 : 3}">
      <label>Distribution</label><select id="sy_dist${i}" data-k="dist" data-i="${i}"><option value="log">Logarithmic</option><option value="linear">Linear</option></select>
      <label class="full chk"><input id="sy_zero${i}" type="checkbox" data-k="zero" data-i="${i}" checked> Include 0</label>
      <label>Order</label><select id="sy_ord${i}" data-k="order" data-i="${i}"><option value="highFirst" ${i === 1 ? '' : 'selected'}>High → low</option><option value="lowFirst" ${i === 1 ? 'selected' : ''}>Low → high</option></select>
      </div><p class="hint" data-range="${i}"></p></div>`;
  el.innerHTML = `<p class="hint">D300e Control's synergy builder (no replicates). For replicate grids, plate replicates and cell lines use the Experiment wizard.</p><div class="form">
    <label>Type</label><select id="sType"><option value="ABC" ${st.type === 'ABC' ? 'selected' : ''}>A×B×C (all crossed)</option><option value="AxEach" ${st.type === 'AxEach' ? 'selected' : ''}>A×B, A×C … (primary × each)</option></select>
    <label>Fluids</label><input id="sN" type="number" min="2" max="${Math.min(6, fl.length)}" value="${st.n}">
    <label>Plate type</label><select id="sPlate">${Object.entries(PLATE_TYPES).map(([k, v]) => `<option value="${k}" ${k === (cur?.plateType || 'Default384') ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
    <label>Well volume</label><span><input id="sAssay" type="number" step="any" value="${(cur?.assayVolume ?? 50000) / 1000}"> µL</span>
    <label>DMSO limit</label><span><input id="sDmso" type="number" step="any" value="${+((cur?.dmsoLimit ?? 0.01) * 100).toPrecision(8)}"> %</span>
    <label>Exclude rows</label><input id="sExR" placeholder="e.g. A, P">
    <label>Exclude cols</label><input id="sExC" placeholder="e.g. 1, 24">
    <label>Layout</label><select id="sLayout">
      <option value="single">One grid per plate</option><option value="multiple" selected>Multiple grids per plate</option>
      <option value="multipleBreaks">Multiple grids, with plate breaks</option><option value="noEmpty">Leave no empty wells</option></select>
    <label>Grids by</label><select id="sOrder"><option value="rows">Rows</option><option value="cols">Columns</option></select>
    <label class="full chk"><input type="checkbox" id="sNorm" checked> Normalize DMSO to highest class volume</label>
    </div>${Array.from({ length: st.n }, (_, i) => fluidBlock(i)).join('')}
    <div class="actions"><button id="sGo" class="primary">${icon('synergy', 15)} Create plates</button></div>`;
  const upRange = () => { for (const p of el.querySelectorAll('[data-range]')) { const i = p.dataset.range; const f = fluidById(+$(`sy_fid${i}`).value); const { min, max } = validRange(f, { assayVolume: +$('sAssay').value * 1000, dmsoLimit: +$('sDmso').value / 100 }, st.n); p.textContent = `Valid range ${fmt(cv(f, min), 3)} – ${fmt(cv(f, max), 3)} ${unitLabel(wellUnit(f))}`; } };
  el.oninput = upRange; panelUpdate = upRange;
  if (S.meta.settings.borderPBS) { setTimeout(() => { if (!$('sExR').value && !$('sExC').value) { const p = plate() || newPlate(); $('sExR').value = `A, ${rowLabel(p.rows - 1)}`; $('sExC').value = `1, ${p.cols}`; } }, 0); }
  $('sType').onchange = () => { st.type = $('sType').value; renderOpPanel(); };
  $('sN').onchange = () => { st.n = Math.max(2, Math.min(+$('sN').value || 2, fl.length)); renderOpPanel(); };
  $('sGo').onclick = () => {
    const ex = (txt, isRow) => new Set(String(txt).split(/[\s,;]+/).filter(Boolean).map((t) => (isRow ? rowIndex(t) : +t - 1)));
    let spec;
    try {
      const fluids = Array.from({ length: st.n }, (_, i) => {
        const sf = fluidById(+$(`sy_fid${i}`).value); const o = { mode: 'highLow', high: cb(sf, +$(`sy_high${i}`).value), low: cb(sf, +$(`sy_low${i}`).value), levels: Math.floor(+$(`sy_lv${i}`).value), distribution: $(`sy_dist${i}`).value };
        const includeZero = $(`sy_zero${i}`).checked;
        return { fluidId: +$(`sy_fid${i}`).value, levels: synergyLevels({ ...o, includeZero }), includeZero, order: $(`sy_ord${i}`).value };
      });
      if (new Set(fluids.map((f) => f.fluidId)).size !== fluids.length) throw new Error('Each synergy fluid must be different');
      spec = { type: st.type, fluids, plate: { plateType: $('sPlate').value, assayVolume: +$('sAssay').value * 1000, dmsoLimit: +$('sDmso').value / 100 },
        excludedRows: ex($('sExR').value, true), excludedCols: ex($('sExC').value, false), layout: $('sLayout').value, gridOrder: $('sOrder').value };
      for (const s of [...spec.excludedRows, ...spec.excludedCols]) if (!(s >= 0)) throw new Error('Could not read the excluded rows/columns');
    } catch (e) { return toast(e.message); }
    const normalize = $('sNorm').checked;
    mutate('synergy', () => {
      const plates = buildSynergy(spec);
      const first = S.protocol.plates.length;
      S.protocol.plates.push(...plates); plates.forEach(() => metaAddPlate(S.meta));
      if (normalize) addNormalization(S.protocol, 0, 'ToMaxVolume', undefined, plates.flatMap((p, i) => [...p.wells.keys()].map(splitKey).map(([r, c]) => ({ p: first + i, r, c }))));
      S.plateIdx = first; S.sel.clear();
      toast(`Created ${plates.length} plate${plates.length === 1 ? '' : 's'}`);
    });
  };
}
const rowIndex = (t) => { t = t.toUpperCase(); if (!/^[A-Z]{1,2}$/.test(t)) return NaN; return t.length === 1 ? t.charCodeAt(0) - 65 : (t.charCodeAt(0) - 64) * 26 + t.charCodeAt(1) - 65; };

// ---- check ----
function renderCheck(el) {
  if (!S.computed) { el.innerHTML = '<p class="hint">Nothing to check.</p>'; return; }
  const issues = [];
  let maxDmso = 0;
  S.computed.forEach(({ wells }, pi) => { for (const [k, w] of wells) {
    if (Number.isFinite(w.dmsoFraction)) maxDmso = Math.max(maxDmso, w.dmsoFraction);
    for (const x of w.warnings) issues.push({ pi, k, x });
  } });
  const totals = fluidTotals(S.computed);
  const priming = primingIssues(S.protocol, S.computed);
  const byCode = {}; for (const i of issues) (byCode[i.x.code] ||= []).push(i);
  const noCells = S.meta.cellLines.length ? S.protocol.plates.map((p, i) => i).filter((i) => !Object.keys(S.meta.plates[i]?.cellLines || {}).length) : [];
  el.innerHTML = `<h3 style="margin-top:0">Warnings (${issues.length})</h3><ul class="warnlist">${Object.entries(byCode).map(([code, list]) => `<li class="w">⚠ ${list.length} × ${esc(warnText(list[0].x))}${list.length > 1 ? ' …' : ''}<br><span class="muted">${list.slice(0, 12).map((i) => `P${i.pi + 1} ${wellName(...splitKey(i.k))}`).join(', ')}${list.length > 12 ? ' …' : ''}</span> <button class="small" data-code="${code}">Select</button></li>`).join('') || '<li style="color:var(--ok)">✓ No warnings</li>'}</ul>
    <p>Highest DMSO in any well: <b>${(maxDmso * 100).toFixed(4)} %</b></p>
    <h3>Priming (≥ ${PRIMING_VOLUME} nL per drug per plate)</h3>
    <p class="hint">Priming: every plate should have one well that gets at least ${PRIMING_VOLUME} nL of each drug, so the dispense head is running properly before the small doses (Tecan's recommendation). A spare "scrap" well in the border does this.</p>
    <ul class="warnlist">${priming.filter((x) => x.lacking.length).map((x) => `<li class="w">Plate ${x.plate + 1}: ${x.lacking.map((l) => `${esc(fluidById(l.fluidId)?.name)} (max ${fmt(l.maxVolume, 3)} nL)`).join(', ')} <button class="small" data-scrap="${x.plate}">Add scrap well</button></li>`).join('') || '<li style="color:var(--ok)">✓ Every plate primes every drug</li>'}</ul>
    ${noCells.length ? `<h3>Cell lines</h3><ul class="warnlist"><li class="w">No cell line on plate${noCells.length > 1 ? 's' : ''} ${noCells.map((i) => i + 1).join(', ')}</li></ul>` : ''}
    <h3>Dispensed per drug</h3><table class="fluids">${S.protocol.fluids.map((f) => { const t = totals.get(f.id); return `<tr><td><span class="swatch" style="background:${fluidColor(f)}"></span> ${esc(f.name)}</td><td>${t ? fmt(t.volume / 1000, 5) + ' µL' : '–'}</td><td class="muted">${t ? t.wells + ' wells' : ''}</td></tr>`; }).join('')}</table>
    <p class="hint">How much to load into each cassette head: see <b>Run</b>.</p>`;
  for (const b of el.querySelectorAll('[data-scrap]')) b.onclick = () => addScrapWell(+b.dataset.scrap, priming[+b.dataset.scrap].lacking.map((l) => fluidById(l.fluidId)));
  for (const b of el.querySelectorAll('[data-code]')) b.onclick = () => {
    const list = byCode[b.dataset.code]; const p0 = list[0].pi; S.plateIdx = p0; S.sel = new Set(list.filter((i) => i.pi === p0).map((i) => i.k)); render();
  };
}

/** Put all under-primed fluids into one empty well, preferring the plate border from the last column (A24, P24, …). */
function addScrapWell(pi, fluids) {
  const p = S.protocol.plates[pi];
  const border = [];
  for (let c = p.cols - 1; c >= 0; c--) border.push([0, c]);
  for (let r = 1; r < p.rows; r++) border.push([r, p.cols - 1]);
  const cell = border.find(([r, c]) => !p.wells.get(wellKey(r, c))?.size);
  if (!cell) return toast('No empty border well on this plate; set a scrap well by hand');
  mutate('add scrap well', () => {
    for (const [id, v] of scrapWellValues(fluids, p)) setWell(p, cell[0], cell[1], id, v);
    setRole(S.meta, pi, [cell], 'scrap');
    S.plateIdx = pi; S.sel = new Set([wellKey(...cell)]);
  });
  toast(`Scrap well ${wellName(...cell)} on plate ${pi + 1}: ${fluids.map((f) => f.name).join(', ')} at ≥ ${PRIMING_VOLUME} nL`);
}

// ---- run plan: cassettes and load volumes ----
function renderRun(el) {
  const plan = S.plan;
  if (!plan || !plan.cassettes.length) { el.innerHTML = '<div class="callout">Nothing to dispense yet.</div>'; return; }
  const t8 = plan.cassettes.filter((c) => c.type === 'T8+').length, d4 = plan.cassettes.filter((c) => c.type === 'D4+').length;
  el.innerHTML = `<div class="callout"><b>You need ${t8 ? `${t8} × T8+` : ''}${t8 && d4 ? ' and ' : ''}${d4 ? `${d4} × D4+ (high-volume)` : ''} cassette${t8 + d4 > 1 ? 's' : ''}</b> for ${S.protocol.plates.length} plate${S.protocol.plates.length > 1 ? 's' : ''}.
      Pipette the bold volume into each head, left to right. Colour = solution; a striped head is a diluted stock; empty heads stay empty.</div>
    ${usedHeadsPicker(plan)}
    <div class="drawing zoomable" id="runDraw" title="Click to enlarge">${cassetteSvg(plan.cassettes, (h) => fluidLook(S.protocol, h.fluidId, h.classId === 0), { theme: THEME_VARS, compact: (el.clientWidth || 320) < 440 })}</div>
    <div class="actions"><button id="runBig" class="small">Enlarge</button><button id="runSvg" class="small">${icon('save', 13)} Save drawing (SVG)</button><button id="runPng" class="small">PNG</button></div>
    <h3>The same as a table</h3>
    ${plan.cassettes.map((c) => `<div class="cassette-h">${icon('cassette', 16)} Cassette ${c.index} · ${c.type}</div>
      <table class="plan"><tr><th>Head</th><th>Solution</th><th>Conc.</th><th class="num">Dispensed</th><th class="num">Load</th></tr>
      ${headRows(c).map((h) => h.skip ? `<tr class="muted"><td>${h.head}</td><td colspan="4">SKIP — used in an earlier run</td></tr>` : `<tr><td>${h.head}</td><td>${h.fluidId != null ? `<span class="swatch" style="background:${fluidColor(fluidById(h.fluidId))}"></span> ` : ''}${esc(h.name)}</td><td>${esc(fluidLook(S.protocol, h.fluidId, h.classId === 0).conc)}</td><td class="num">${fmt(h.dispensed, 4)} µL</td><td class="load">${c.type === 'D4+' ? h.load : h.load.toFixed(1)} µL</td></tr>`).join('')}</table>`).join('')}
    <h3>Per solution: how much to have ready</h3><table class="plan"><tr><th>Solution</th><th>Conc.</th><th class="num">Heads</th><th class="num">Dispensed</th><th class="num">Total load</th></tr>
    ${plan.fluids.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(fluidLook(S.protocol, f.fluidId, f.classId === 0).conc)}</td><td class="num">${f.heads.length}</td><td class="num">${fmt(f.dispensed, 4)} µL</td><td class="load">${f.heads.some((h) => h.type === 'D4+') ? Math.round(f.load) : f.load.toFixed(1)} µL</td></tr>`).join('')}</table>
    <p class="hint">"Dispensed" is what reaches the plates; "Load" includes what stays in the head. The D300e shows the same volumes on its fill screen before the run. If it ever asks for something different, load what the instrument asks for and report it.</p>
    <div class="actions"><button id="runCsv">${icon('save', 15)} Save loading sheet (CSV)</button></div>`;
  const drawing = () => standalone(cassetteSvg(plan.cassettes, (h) => fluidLook(S.protocol, h.fluidId, h.classId === 0), { theme: LIGHT, title: `${S.fileName.replace(/\.tdd$/, '')} — what to pipette into each dispense head` }));
  const enlarge = () => dialog(`<h3>What to pipette into each dispense head</h3><div class="drawing" style="width:min(820px,84vw)">${cassetteSvg(plan.cassettes, (h) => fluidLook(S.protocol, h.fluidId, h.classId === 0), { theme: THEME_VARS })}</div><p class="hint">Colour = solution · striped = diluted stock · empty circle = leave the head empty. Volumes include what stays in the head.</p>`, () => true, 'Close', { cancel: null });
  $('runDraw').onclick = enlarge; $('runBig').onclick = enlarge;
  for (const cb of el.querySelectorAll('input[data-used-head]')) cb.onchange = () => {
    const h = Number(cb.dataset.usedHead), cur = normalizeUsedHeads(S.meta.settings.usedT8Heads);
    const next = cb.checked ? normalizeUsedHeads([...cur, h]) : cur.filter((x) => x !== h);
    if (next.length >= 8) { cb.checked = false; toast('All 8 heads used: start with a new cassette instead'); return; }
    mutate(cb.checked ? `mark head ${h} used` : `mark head ${h} unused`, () => { S.meta.settings.usedT8Heads = next; });
  };
  $('runSvg').onclick = () => exportFigure(drawing(), S.fileName.replace(/\.tdd$/, '') + '_loading', 'svg', saveBlob);
  $('runPng').onclick = () => exportFigure(drawing(), S.fileName.replace(/\.tdd$/, '') + '_loading', 'png', saveBlob);
  $('runCsv').onclick = () => {
    const rows = [['Cassette', 'Type', 'Head', 'Solution', 'Concentration', 'Dispensed (µL)', 'Load (µL)']];
    for (const c of plan.cassettes) for (const h of headRows(c)) {
      rows.push(h.skip ? [c.index, c.type, h.head, 'SKIP (used in an earlier run)', '', '', '']
        : [c.index, c.type, h.head, h.name, fluidLook(S.protocol, h.fluidId, h.classId === 0).conc, +h.dispensed.toFixed(4), h.load]);
    }
    saveCsv(S.fileName.replace(/\.tdd$/, '') + '_loading.csv', rows);
  };
}

/** A cassette's filled heads and skipped (used) heads together, in head order. */
const headRows = (c) => [...c.heads, ...(c.skipped || []).map((head) => ({ head, skip: true }))].sort((a, b) => a.head - b.head);

// A partly used T8+ cassette: tick the heads used in an earlier run. D300e Control's fill screen has a SKIP button
// for each head; Craft shifts the plan the way D300e does (src/cassette.js skipUsedHeads, probe-33).
function usedHeadsPicker(plan) {
  if (!plan.cassettes.some((c) => c.type === 'T8+')) return '';
  const used = normalizeUsedHeads(S.meta.settings.usedT8Heads);
  const boxes = Array.from({ length: 8 }, (_, i) => `<label class="usedhead"><input type="checkbox" data-used-head="${i + 1}" ${used.includes(i + 1) ? 'checked' : ''}> ${i + 1}</label>`).join(' ');
  const first = plan.cassettes.find((c) => c.type === 'T8+');
  const d4 = plan.cassettes.some((c) => c.type === 'D4+');
  return `<details class="usedheads" ${used.length ? 'open' : ''}><summary>Reusing a partly used T8+ cassette?</summary>
    <p class="hint">Tick the heads already used in an earlier run. Put that cassette in first (cassette ${first.index}). On the D300e fill screen,
    press <b>SKIP</b> when it asks for a used head; the solutions move on to the next free heads, and what does not fit goes to the next T8+
    cassette from its head 1. The volumes stay the same. D300e's pre-run summary is made before any skip, so it still shows the head and
    cassette count without skips.${d4 ? ' <b>Not yet checked against D300e for runs that also use D4+ cassettes:</b> verify the order on the fill screens.' : ''}</p>
    <div class="usedhead-row">Used heads: ${boxes}</div></details>`;
}

export function saveCsv(name, rows) {
  const csv = rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n');
  if (TAURI) { invoke('save_text', { suggested: name, text: csv, extension: 'csv' }).then((p) => p && toast(`Saved ${p}`)).catch((e) => toast(String(e), 8000)); return; }
  download(name, csv, 'text/csv');
}

// ---- results ----
function resultsScale(pi) {
  const ro = S.meta.plates[pi]?.readout; if (!ro?.values) return null;
  const vals = ro.values.flat().filter((v) => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  const min = Math.min(...vals), max = Math.max(...vals);
  const color = (v) => { const t = max > min ? (v - min) / (max - min) : 1; return `hsl(${Math.round(10 + 120 * t)} 65% ${Math.round(88 - 40 * t)}%)`; };
  return { min, max, value: (r, c) => readoutValue(pi, r, c), color, label: 'Raw signal', gradient: 'linear-gradient(90deg, hsl(10 65% 88%), hsl(130 65% 48%))' };
}

async function renderResultsTab(el) {
  const pi = S.plateIdx, p = plate();
  if (!p) { el.innerHTML = '<div class="callout">Add a plate first.</div>'; return; }
  const pm = S.meta.plates[pi];
  const withData = S.meta.plates.filter((x) => x.readout).length;
  el.innerHTML = `<p class="hint">Paste the plate reader's values for <b>plate ${pi + 1}</b> (${p.rows} × ${p.cols}), e.g. CellTiter-Glo luminescence copied from Excel. Row/column labels and extra lines are fine.</p>
    <textarea id="rPaste" rows="9" placeholder="${keys('Paste here (⌘V)…')}"></textarea>
    <div class="actions"><button id="rRead" class="primary">${icon('check', 15)} Use for plate ${pi + 1}</button>${pm?.readout ? `<button id="rDrop" class="danger">${icon('trash', 15)} Remove</button>` : ''}</div>
    <div id="rMsg"></div>
    <h3>Plates with data: ${withData} / ${S.protocol.plates.length}</h3>
    <ul class="warnlist">${S.meta.plates.map((x, i) => `<li>${x.readout ? '✓' : '·'} Plate ${i + 1}${x.readout ? ` <span class="muted">${esc(x.readout.importedAt?.slice(0, 16).replace('T', ' ') || '')}</span>` : ''}</li>`).join('')}</ul>
    <div class="callout">The Excel file has one row per well (cell line, role, every drug's concentration, DMSO %, raw signal, % of vehicle), replicate statistics per condition, Bliss synergy and Chou–Talalay combination indices (with the median-effect fits) for drug pairs. Mark <b>blank</b> wells (medium only) in Annotate to subtract background.</div>
    <div class="actions"><button id="rExport" class="primary" ${withData ? '' : 'disabled'}>${icon('excel', 15)} Export Excel…</button></div>
    <div id="rSynergy"></div>`;
  $('rRead').onclick = async () => {
    let A; try { A = await import('../src/analysis.js'); } catch (e) { return toast('The analysis module is not available in this build'); }
    const text = $('rPaste').value; if (!text.trim()) return toast('Paste the values first');
    try {
      const r = A.parseReadout(text, p.rows, p.cols);
      mutate('paste readout', () => { S.meta.plates[pi].readout = { values: r.values, raw: text, format: r.format, importedAt: new Date().toISOString() }; });
      S.layer = 'results'; render();
      if (r.warnings?.length) $('rMsg').innerHTML = `<div class="callout warn">${r.warnings.map(esc).join('<br>')}</div>`;
      toast(`Plate ${pi + 1}: ${r.values.flat().filter((v) => v != null).length} values read (${r.format})`);
    } catch (e) { $('rMsg').innerHTML = `<div class="callout warn">${esc(e.message)}</div>`; }
  };
  $('rDrop')?.addEventListener('click', async () => { if (await ask(`Remove the readout of plate ${pi + 1}?`, 'Remove', { danger: true })) mutate('remove readout', () => { S.meta.plates[pi].readout = null; }); });
  $('rExport').onclick = exportExcel;
  if (withData) renderSynergySection($('rSynergy'));
}

// ---- synergy: in-app figures + SynergyFinder package ----
const FIG_FORMATS = ['png', 'pdf', 'svg', 'rds'];
async function renderSynergySection(el) {
  let A; try { A = await import('../src/analysis.js'); } catch { return; }
  if (!el.isConnected) return; // the panel was re-rendered while the module loaded; the new one renders itself
  let result; try { result = A.analyze({ protocol: S.protocol, computed: S.computed, meta: S.meta }); } catch (e) { el.innerHTML = `<div class="callout warn">${esc(e.message)}</div>`; return; }
  const mats = synergyMatrices(result);
  if (!mats.length) { el.innerHTML = '<h3>Synergy</h3><p class="hint">No drug pairs with single-agent and combination wells measured yet.</p>'; return; }
  const lim = Math.max(10, ...mats.flatMap((m) => [...m.bliss.values()].map((v) => Math.abs(v))));
  const figsOf = (m, ch) => [{ name: 'viability', svg: heatmapSvg(m, 'viability') }, { name: 'bliss', svg: heatmapSvg(m, 'bliss', { limit: lim }) },
    ...(ch ? [{ name: 'chou_ci', svg: ciHeatmapSvg(m, ch) }, { name: 'isobologram', svg: isobologramSvg(m, ch) },
      { name: 'normalized_isobologram', svg: normalizedIsobologramSvg(m, ch) }, { name: 'fa_ci', svg: faCiSvg(m, ch) }] : [])];
  S.synFormats ||= { png: true, pdf: true, svg: true, rds: true, html: false };
  el.innerHTML = `<h3>${icon('synergy', 16)} Synergy (${mats.length} cell line × drug pair${mats.length > 1 ? 's' : ''})</h3>
    <p class="hint"><b>Bliss excess</b>: how much more (red) or less (blue) the combination kills than expected if the two drugs acted independently, from the mean of the replicates.
      <b>Chou–Talalay</b>: each drug alone is fitted to the median-effect equation; the combination index CI = d<sub>A</sub>/D<sub>x,A</sub> + d<sub>B</sub>/D<sub>x,B</sub> compares each combination with the doses of the drugs alone that give the same effect (CI &lt; 1 synergy, ≈ 1 additive, &gt; 1 antagonism). The isobologram shows, for 50, 75 and 90 % effect, the additive line (dashed) and where the combination actually reaches that effect (solid; below the line = synergy).
      For ZIP, HSA, Loewe and fitted surfaces use the SynergyFinder package below.</p>
    ${mats.map((m, i) => { const ch = chouFor(result, m); return `<div class="syn-card"><div class="syn-figs">${figsOf(m, ch).map((f) => f.svg).join('')}</div>
      ${ch ? chouSummaryHtml(ch, esc) : ''}
      <div class="actions"><button class="small" data-fig="${i}" data-f="svg">Save figures (SVG)</button><button class="small" data-fig="${i}" data-f="png">PNG</button></div></div>`; }).join('')}
    <h3>SynergyFinder (R)</h3>
    <p class="hint">A complete package: the input CSV in SynergyFinder's format, an annotated well table, analysis.R with styled figures (dose–response, response matrix, ZIP/HSA/Bliss/Loewe maps and 3D surfaces), README and the conda environment.</p>
    <div class="actions" style="flex-wrap:wrap">${['png', 'pdf', 'svg', 'rds', 'html'].map((f) => `<label class="chk"><input type="checkbox" data-fmt="${f}" ${S.synFormats[f] ? 'checked' : ''}> ${f.toUpperCase()}${f === 'html' ? ' (3D)' : ''}</label>`).join('')}</div>
    <div class="actions"><button id="synPkg">${icon('save', 15)} Save package (CSV + R code)…</button><button id="synRender" class="primary">${icon('run', 15)} Save + render figures…</button></div>
    <div id="synMsg"></div>`;
  for (const b of el.querySelectorAll('[data-fmt]')) b.onchange = () => { S.synFormats[b.dataset.fmt] = b.checked; };
  for (const b of el.querySelectorAll('[data-fig]')) b.onclick = async () => {
    const m = mats[+b.dataset.fig], base = `${m.cellLine}_${m.drugA}_x_${m.drugB}`.replace(/[^\w.-]+/g, '_');
    for (const f of figsOf(m, chouFor(result, m))) await exportFigure(f.svg, `${base}_${f.name}`, b.dataset.f, saveBlob);
  };
  const pkg = async () => {
    const SX = await import('../src/synergy_export.js');
    const { files } = SX.synergyPackage(result, S.protocol, S.meta, { title: S.meta.experiment.title || S.fileName.replace(/\.tdd$/, ''), appVersion: `${APP_NAME} ${APP_VERSION}` });
    const name = `${S.fileName.replace(/\.tdd$/, '')}_synergyfinder`;
    if (!TAURI) { for (const f of files) download(f.path.replace(/\//g, '_'), f.text, 'text/plain'); toast('In the browser each file downloads separately; the desktop app writes a folder and a .zip'); return null; }
    return invoke('save_package', { suggested: name, files });
  };
  $('synPkg').onclick = async () => {
    try { const r = await pkg(); if (r) { $('synMsg').innerHTML = `<div class="callout">Saved <code>${esc(r.dir)}</code>${r.zip ? ' and a .zip next to it' : ''}. Run <code>conda run -n synergyfinder Rscript analysis.R</code> in it, or use Save + render.</div><button class="small" id="synReveal">Show in Finder</button>`; $('synReveal').onclick = () => invoke('reveal_path', { path: r.dir }); } }
    catch (e) { toast(`Package failed: ${e?.message ?? e}`, 9000); }
  };
  $('synRender').onclick = async () => {
    if (!TAURI) return toast('Rendering with R needs the desktop app');
    let r; try { r = await pkg(); } catch (e) { return toast(`Package failed: ${e?.message ?? e}`, 9000); }
    if (!r) return;
    const formats = Object.entries(S.synFormats).filter(([, v]) => v).map(([k]) => k);
    $('synMsg').innerHTML = `<div class="callout">Rendering figures with R (${formats.join(', ')})… this takes a few minutes for a full screen.</div>`;
    try {
      const out = await invoke('render_package', { dir: r.dir, formats });
      $('synMsg').innerHTML = `<div class="callout ${out.ok ? '' : 'warn'}">${out.ok ? '✓ Done' : '⚠ R reported a problem'}: ${out.figures_ok} files written${out.figures_skipped ? `, ${out.figures_skipped} skipped` : ''}${out.figures_failed ? `, ${out.figures_failed} failed` : ''}. Figures are in <code>figures/</code>, tables in <code>results/</code>.</div>
        ${out.ok ? '' : `<pre style="white-space:pre-wrap;font-size:11px">${esc(out.log_tail)}</pre>`}<button class="small" id="synReveal">Show in Finder</button>`;
      $('synReveal').onclick = () => invoke('reveal_path', { path: r.dir });
    } catch (e) { $('synMsg').innerHTML = `<div class="callout warn">${esc(String(e))}</div>`; }
  };
}

function saveBlob(name, data, type) {
  if (TAURI && typeof data === 'string') return invoke('save_text', { suggested: name, text: data, extension: name.split('.').pop() }).then((p) => p && toast(`Saved ${p}`));
  if (TAURI) return data.arrayBuffer().then((b) => invoke('save_bytes', { suggested: name, bytes: Array.from(new Uint8Array(b)), extension: name.split('.').pop() })).then((p) => p && toast(`Saved ${p}`));
  const a = document.createElement('a'); a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function exportExcel() {
  let A; try { A = await import('../src/analysis.js'); } catch (e) { return toast('The analysis module is not available in this build'); }
  try {
    const result = A.analyze({ protocol: S.protocol, computed: S.computed, meta: S.meta });
    const wb = A.toWorkbook(result, S.protocol, S.meta, { appVersion: `${APP_NAME} ${APP_VERSION}`, generatedAt: new Date().toISOString() });
    const name = S.fileName.replace(/\.tdd$/, '') + '_results.xlsx';
    if (TAURI) { const p = await invoke('save_xlsx', { suggested: name, workbook: wb }); if (p) toast(`Saved ${p}`); }
    else { for (const sh of wb.sheets) saveCsv(`${name.replace(/\.xlsx$/, '')}_${sh.name.replace(/\W+/g, '_')}.csv`, [sh.columns.map((c) => c.header), ...sh.rows]); toast('In the browser the sheets are saved as CSV files'); }
    if (result.warnings?.length) toast(result.warnings.slice(0, 3).join(' · '), 9000);
  } catch (e) { toast(`Export failed: ${e.message}`, 9000); console.error(e); }
}

// ---------------- copy / paste ----------------
function copySel() {
  if (!S.sel.size) return toast('Select wells to copy');
  const cells = selectedCells();
  const drugs = copyWells(plate(), cells);
  const groups = copyNormalization(S.protocol, S.plateIdx, cells);
  const meta = metaCopyWells(S.meta, S.plateIdx, cells);
  S.clip = drugs.map((d, i) => ({ ...d, groups: groups[i], role: meta[i].role, cellLine: meta[i].cellLine }));
  S.clip.fromPlate = S.plateIdx;
  $('btnPaste').disabled = false;
  toast(`Copied ${S.clip.length} wells (drugs, normalization, cell lines, roles). Select the top-left target well and paste.`);
}
function pasteSel() {
  if (!S.clip) return toast('Nothing copied');
  if (!S.sel.size) return toast('Select the top-left target well');
  const [r0, c0] = selectedCells()[0];
  const p = plate();
  let truncated = 0;
  mutate('paste wells', () => {
    ({ truncated } = pasteWells(p, S.clip, r0, c0));
    pasteNormalization(S.protocol, S.plateIdx, S.clip, r0, c0, p.rows, p.cols);
    metaPasteWells(S.meta, S.plateIdx, S.clip, r0, c0, p.rows, p.cols);
    S.sel = new Set(S.clip.map(({ dr, dc }) => [r0 + dr, c0 + dc]).filter(([r, c]) => r < p.rows && c < p.cols).map(([r, c]) => wellKey(r, c)));
  });
  toast(`Pasted ${S.clip.length - truncated} wells${truncated ? `; ${truncated} did not fit and were skipped` : ''}`);
}

// ---------------- start screen ----------------
function showStart() {
  const st = $('start');
  st.innerHTML = `<div class="inner"><h1><span class="logo" style="width:34px;height:34px"></span>${APP_NAME}</h1>
    <p class="lead">Plan a drug-printing experiment for the Tecan D300e: which well gets which dose, what to pipette into the dispenser, and where the cells go. After the read-out, turn the plate-reader numbers into viability and synergy tables. Protocols are saved as .tdd files that D300e Control opens directly.</p>
    <div class="cards">
      <button class="card" id="stWizard">${icon('wizard', 28)}<b>New experiment</b><span>Five guided steps with pictures: plates, drugs, doses, cell lines, and what you will need at the bench.</span></button>
      <button class="card" id="stOpen">${icon('open', 28)}<b>Open protocol</b><span>A .tdd file from D300e Control or from this app. Its experiment file (cell lines, results) opens with it.</span></button>
      <button class="card" id="stBlank">${icon('plate', 28)}<b>Blank protocol</b><span>One empty 384-well plate. Fill wells by hand, as in D300e Control.</span></button>
    </div>
    <ol class="flow" aria-label="How an experiment goes">
      <li><b>Design</b><span>doses, plates, cell lines</span></li>
      <li><b>Prepare</b><span>seed cells, PBS border, drug tubes</span></li>
      <li><b>Print</b><span>fill the heads as drawn, run the D300e</span></li>
      <li><b>Read</b><span>e.g. CellTiter-Glo after incubation</span></li>
      <li><b>Results</b><span>paste values: viability, synergy, Excel</span></li>
    </ol>
    <p class="foot">Tip: hover any button for help. ${keys('⌘Z')} undoes anything.</p></div>`;
  st.hidden = false;
  $('stWizard').onclick = () => { if (!S.protocol) blankDoc(); hideStart(); startWizard(); };
  $('stOpen').onclick = () => { if (!S.protocol) blankDoc(); openFile(); };
  $('stBlank').onclick = () => { blankDoc(); hideStart(); };
}
function hideStart() { $('start').hidden = true; }

function blankDoc() {
  const p = newProtocol(); p.plates.push(newPlate());
  S.protocol = p; S.meta = newMeta(p); S.fileName = 'untitled.tdd'; S.fileHandle = null; S.diskPath = null; S.dirty = false; S.undo = []; S.redo = [];
  S.plateIdx = 0; S.sel.clear(); S.fluidId = null; S.cellLineId = null; S.layer = 'drugs';
  recompute(); render();
}
async function newDoc() { if (!(await confirmDiscard())) return; blankDoc(); hideStart(); }

function startWizard() {
  openWizard({
    S, mutate, toast, esc, fmt, ask, render, fluidColor,
    apply: (fn, label) => mutate(label, fn),
    replaceDoc: () => { const p = newProtocol(); S.protocol = p; S.meta = newMeta(p); S.fileName = 'untitled.tdd'; S.diskPath = null; S.fileHandle = null; S.plateIdx = 0; S.sel.clear(); },
  });
}

// ---------------- wiring ----------------
function bind() {
  $('btnHome').onclick = showStart;
  $('btnNew').onclick = newDoc; $('btnOpen').onclick = openFile; $('btnSave').onclick = () => save(false); $('btnSaveAs').onclick = () => save(true);
  $('btnUndo').onclick = undo; $('btnRedo').onclick = redo;
  $('btnWizard').onclick = startWizard;
  $('btnRunPlan').onclick = () => { S.tab = 'run'; renderOpPanel(); };
  $('btnResults').onclick = () => { S.tab = 'results'; S.layer = 'results'; render(); };
  $('fileInput').onchange = async (e) => { const f = e.target.files[0]; if (f) loadText(await f.text(), f.name); e.target.value = ''; };
  $('btnAddFluid').onclick = () => editFluid(null);
  $('btnAddCellLine').onclick = addCellLineUi;
  $('btnAddPlate').onclick = addPlateDialog;
  $('btnReplicatePlate').onclick = () => mutate('duplicate plate', () => { const src = S.plateIdx; S.plateIdx = replicatePlate(S.protocol, src); metaReplicatePlate(S.meta, src); });
  $('btnRemovePlate').onclick = async () => { if (await ask(`Remove plate ${S.plateIdx + 1} with its normalization, cell lines and data?`, 'Remove', { danger: true })) mutate('remove plate', () => { removePlate(S.protocol, S.plateIdx); metaRemovePlate(S.meta, S.plateIdx); S.plateIdx = Math.max(0, S.plateIdx - 1); S.sel.clear(); }); };
  $('showFluid').onchange = (e) => { S.showFluid = e.target.value; renderGrid(); };
  $('showNorm').onchange = renderGrid;
  $('layerSeg').onclick = (e) => { const b = e.target.closest('[data-layer]'); if (b) { S.layer = b.dataset.layer; renderShowSelect(); renderGrid(); renderStatus(); } };
  $('btnSelectAll').onclick = () => plate() && selectRect(0, 0, plate().rows - 1, plate().cols - 1);
  $('btnSelectInner').onclick = selectInner;
  $('btnSelectNone').onclick = () => { S.sel.clear(); selectionChanged(); };
  $('btnCopy').onclick = copySel; $('btnPaste').onclick = pasteSel;
  $('btnClearSel').onclick = () => S.sel.size ? mutate('clear wells', () => clearWells(plate(), selectedCells())) : toast('Select wells first');
  if (!IS_MAC) for (const el of document.querySelectorAll('[title]')) el.title = keys(el.title);
  $('opTabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { S.tab = b.dataset.tab; if (S.tab === 'results') S.layer = 'results'; if (S.tab === 'annotate' && S.layer === 'drugs') S.layer = 'cells'; render(); } };
  rememberForm($('opPanel'));
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey; const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
    if ($('dlg').open || $('wiz').open) return;
    if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(e.shiftKey); }
    else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openFile(); }
    else if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newDoc(); }
    else if (mod && e.key.toLowerCase() === 'c' && !typing && S.sel.size) { e.preventDefault(); copySel(); }
    else if (mod && e.key.toLowerCase() === 'v' && !typing) { e.preventDefault(); pasteSel(); }
    else if (mod && e.key.toLowerCase() === 'a' && !typing) { e.preventDefault(); $('btnSelectAll').click(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && S.sel.size) { e.preventDefault(); mutate('clear wells', () => clearWells(plate(), selectedCells())); }
    else if (e.key === 'Escape' && !typing) { S.sel.clear(); selectionChanged(); }
  });
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
  bindGrid();
  // icons on buttons that declare data-icon
  for (const b of document.querySelectorAll('[data-icon]')) b.insertAdjacentHTML('afterbegin', icon(b.dataset.icon, b.classList.contains('tb') ? 20 : 15));
  for (const b of $('opTabs').querySelectorAll('button')) b.title ||= b.textContent.trim();
}

// ---------------- themes ----------------
const THEMES = { light: ['Light', '#f6f7f9', '#2f6fde'], dark: ['Dark', '#15181e', '#6a9cf5'], lab: ['Lab teal', '#eef5f4', '#0f8b7f'],
  midnight: ['Midnight', '#0e1424', '#f2a65a'], solar: ['Solarized', '#fdf6e3', '#268bd2'], contrast: ['High contrast', '#ffffff', '#000000'] };
function applyTheme(t) {
  if (t in THEMES) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('d300.theme', t || ''); } catch { /* storage unavailable: theme just isn't remembered */ }
  for (const b of $('themePick').children) b.classList.toggle('on', b.dataset.t === t);
  if (S.protocol) renderGrid();
}
function initThemes() {
  $('themePick').innerHTML = Object.entries(THEMES).map(([k, [label, bg, acc]]) =>
    `<button data-t="${k}" title="${label}" style="background:linear-gradient(135deg, ${bg} 50%, ${acc} 50%)"></button>`).join('');
  $('themePick').onclick = (e) => { if (e.target.dataset.t) applyTheme(e.target.dataset.t); };
  let saved = ''; try { saved = localStorage.getItem('d300.theme') || ''; } catch { /* ignore */ }
  applyTheme(saved);
}

bind();
initThemes();
blankDoc();
// Optional: ?open=<url> loads a protocol (used for testing with fixtures); otherwise show the start screen.
const q = new URLSearchParams(location.search).get('open');
if (q) {
  fetch(q, { cache: 'reload' }).then((r) => { if (!r.ok) throw new Error(r.statusText); return r.text(); })
    .then(async (t) => { const side = await fetch(q.replace(/\.tdd$/, '.craft.json'), { cache: 'reload' }).then((r) => (r.ok ? r.text() : null)).catch(() => null); loadText(t, decodeURIComponent(q.split('/').pop()), null, side); })
    .catch((e) => toast(`Could not load ${q}: ${e.message}`));
} else showStart();
// Test hook (used by browser tests; harmless in normal use).
window.__d300 = { S, serialize, render, mutate };
