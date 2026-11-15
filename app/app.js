// D300 Designer UI. All protocol logic lives in ../src (tested with node --test);
// this file is only state, rendering and event handling.

import { parseTdd, writeTdd, newProtocol, wellKey, splitKey, wellName, formatNumber } from '../src/tdd.js';
import { computeProtocol, computeWell, validRange, fluidTotals, primingIssues, scrapWellValues, PRIMING_VOLUME, FLUID_CLASSES, MOLARITY_UNITS, MASS_UNITS, unitKind, unitLabel, toDisplay, fromDisplay } from '../src/dispense.js';
import { PLATE_TYPES, newPlate, addFluid, removeFluid, setWell, setValue, conflicts, clearWells, titrationLevels, applyTitration, suggestShift, dilutedFluid,
  buildSynergy, NORMALIZE_TYPES, NORMALIZE_PARAM, addNormalization, removeNormalization, removePlate, replicatePlate, clearPlate, copyWells, pasteWells } from '../src/ops.js';

// ---------------- state ----------------
const S = {
  protocol: null, fileName: 'untitled.tdd', fileHandle: null, dirty: false,
  plateIdx: 0, fluidId: null, sel: new Set(), anchor: null, showFluid: 'all',
  undo: [], redo: [], computed: null, clip: null, tab: 'set',
};
const $ = (id) => document.getElementById(id);
const PALETTE = ['#2f6fde', '#d9480f', '#2b8a3e', '#ae3ec9', '#e8590c', '#1098ad', '#c2255c', '#5c940d', '#f08c00', '#3b5bdb', '#862e9c', '#0b7285'];
const fluidColor = (f) => PALETTE[f.id % PALETTE.length];
const plate = () => S.protocol.plates[S.plateIdx];
const fluidById = (id) => S.protocol.fluids.find((f) => f.id === id);

function snapshot() { return structuredClone(S.protocol); }
function mutate(label, fn) {
  const before = snapshot();
  try { fn(); } catch (e) { S.protocol = before; toast(e.message); render(); return false; }
  S.undo.push({ label, state: before }); if (S.undo.length > 200) S.undo.shift();
  S.redo = []; S.dirty = true; recompute(); render();
  return true;
}
function undo() { const u = S.undo.pop(); if (!u) return; S.redo.push({ label: u.label, state: snapshot() }); S.protocol = u.state; afterHistory(`Undid ${u.label}`); }
function redo() { const r = S.redo.pop(); if (!r) return; S.undo.push({ label: r.label, state: snapshot() }); S.protocol = r.state; afterHistory(`Redid ${r.label}`); }
function afterHistory(msg) { S.plateIdx = Math.min(S.plateIdx, Math.max(0, S.protocol.plates.length - 1)); S.dirty = true; recompute(); render(); toast(msg); }

function recompute() {
  try { S.computed = computeProtocol(S.protocol); } catch (e) { S.computed = null; console.error(e); toast(`Volume calculation failed: ${e.message}`); }
}

function toast(msg, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------------- units ----------------
// Well values are stored in the protocol units (µM / ng/mL / nL). Stock <Concentration> is
// assumed to be in the same base unit (UNVERIFIED; see docs/format_notes.md).
const fluidKind = (f) => (f.byVol ? 'volume' : unitKind(f.concentrationUnit));
const wellUnit = (f) => (f.byVol ? S.protocol.settings.VolumeUnit || 'nL' : fluidKind(f) === 'mass' ? S.protocol.settings.MassConcentrationUnit || 'ng_mL' : S.protocol.settings.MolarityConcentrationUnit || 'µM');
const fmt = (x, d = 4) => (x == null || Number.isNaN(x) ? '–' : Math.abs(x) >= 1e4 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(d - 1) : Number(x.toPrecision(d)).toString());
const stockDisplay = (f) => (f.byVol ? '' : `${fmt(toDisplay(f.concentration, f.concentrationUnit), 5)} ${unitLabel(f.concentrationUnit)}`);

// ---------------- file I/O ----------------
async function openFile() {
  if (S.dirty && !confirm('Discard unsaved changes?')) return;
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description: 'D300e protocol', accept: { 'application/xml': ['.tdd'] } }] });
      loadText(await (await h.getFile()).text(), h.name, h);
    } catch (e) { if (e.name !== 'AbortError') toast(e.message); }
  } else $('fileInput').click();
}
function loadText(text, name, handle = null) {
  try {
    const p = parseTdd(text);
    S.protocol = p; S.fileName = name; S.fileHandle = handle; S.dirty = false; S.undo = []; S.redo = [];
    S.plateIdx = 0; S.sel.clear(); S.fluidId = p.fluids[0]?.id ?? null;
    recompute(); render(); toast(`Opened ${name}: ${p.fluids.length} fluids, ${p.plates.length} plates`);
  } catch (e) { toast(`Could not open ${name}: ${e.message}`, 8000); }
}

function localIsoWithOffset(d = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

function serialize() {
  const p = structuredClone(S.protocol);
  p.revisions = [...(p.revisions || []), { time: localIsoWithOffset(), userId: 'Mac\\D300 Designer' }];
  p.thumbnail = renderThumbnail(p) ?? p.thumbnail;
  return writeTdd(p);
}
async function save(as = false) {
  const text = serialize();
  let name = S.fileName.endsWith('.tdd') ? S.fileName : `${S.fileName}.tdd`;
  try {
    if (window.showSaveFilePicker) {
      let h = as ? null : S.fileHandle;
      if (!h) h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'D300e protocol', accept: { 'application/xml': ['.tdd'] } }] });
      const w = await h.createWritable(); await w.write(new Blob([text], { type: 'application/xml' })); await w.close();
      S.fileHandle = h; name = h.name;
    } else {
      if (as) { const n = prompt('File name', name); if (!n) return; name = n.endsWith('.tdd') ? n : `${n}.tdd`; }
      download(name, text, 'application/xml');
    }
    // keep the revision we just wrote
    S.protocol = parseTdd(text); S.fileName = name; S.dirty = false; recompute(); render(); toast(`Saved ${name}`);
  } catch (e) { if (e.name !== 'AbortError') toast(`Save failed: ${e.message}`, 8000); }
}
function download(name, text, type) {
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

function exportCsv() {
  if (!S.computed) return;
  const rows = [['Plate', 'Well', 'Row', 'Col', 'Fluid', 'Requested', 'Unit', 'Dispensed volume (nL)', 'Dispensed concentration', 'Normalization (nL)', 'Total well volume (nL)', 'DMSO %', 'Warnings']];
  S.computed.forEach(({ plate: pl, wells }, pi) => {
    const keys = [...wells.keys()].map(splitKey).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [r, c] of keys) {
      const w = wells.get(wellKey(r, c));
      const warn = w.warnings.map((x) => x.code).join(' ');
      if (!w.fluids.length && w.normalization) rows.push([pi + 1, wellName(r, c), r + 1, c + 1, '(normalization only)', '', '', '', '', w.normalization, w.totalVolume, (w.dmsoFraction * 100).toFixed(4), warn]);
      for (const x of w.fluids) {
        const f = fluidById(x.fluidId);
        rows.push([pi + 1, wellName(r, c), r + 1, c + 1, f?.name ?? x.fluidId, x.requested, unitLabel(wellUnit(f)), x.volume, x.dispensed ?? '', w.normalization || '', w.totalVolume, (w.dmsoFraction * 100).toFixed(4), warn]);
      }
    }
  });
  const csv = rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n');
  download(S.fileName.replace(/\.tdd$/, '') + '_volumes.csv', csv, 'text/csv');
}

// ---------------- rendering ----------------
function render() {
  $('fileName').textContent = S.fileName;
  $('dirty').hidden = !S.dirty;
  $('btnUndo').disabled = !S.undo.length; $('btnRedo').disabled = !S.redo.length;
  $('btnUndo').title = S.undo.length ? `Undo ${S.undo.at(-1).label} (⌘Z)` : 'Undo';
  renderFluids(); renderPlates(); renderPlateParams(); renderSettings(); renderShowSelect(); renderGrid(); renderInspector(); renderOpPanel();
}

function renderFluids() {
  const t = $('fluidTable');
  t.innerHTML = S.protocol.fluids.length ? '' : '<tr><td class="muted">No fluids yet</td></tr>';
  for (const f of S.protocol.fluids) {
    const tr = document.createElement('tr'); if (f.id === S.fluidId) tr.className = 'active';
    const cls = FLUID_CLASSES[f.classId]?.label ?? `class ${f.classId}`;
    tr.innerHTML = `<td><span class="swatch" style="background:${fluidColor(f)}"></span></td><td>${esc(f.name)}</td><td class="muted">${f.byVol ? 'by volume' : esc(stockDisplay(f))}</td><td class="muted">${esc(cls)}</td><td><button class="small" data-edit="${f.id}">Edit</button></td>`;
    tr.onclick = (e) => { if (e.target.dataset.edit) return editFluid(fluidById(+e.target.dataset.edit)); S.fluidId = f.id; render(); };
    t.appendChild(tr);
  }
}

function renderPlates() {
  const ol = $('plateList'); ol.innerHTML = '';
  S.protocol.plates.forEach((p, i) => {
    const li = document.createElement('li'); if (i === S.plateIdx) li.className = 'active';
    const nW = [...p.wells.values()].filter((m) => m.size).length;
    li.innerHTML = `<span>${i + 1}. ${esc(p.name || PLATE_TYPES[p.plateType]?.label || p.plateType)}</span><span class="muted">${nW} wells</span>`;
    li.onclick = () => { S.plateIdx = i; S.sel.clear(); render(); };
    ol.appendChild(li);
  });
  const none = !S.protocol.plates.length;
  for (const id of ['btnReplicatePlate', 'btnClearPlate', 'btnRemovePlate']) $(id).disabled = none;
}

function renderPlateParams() {
  const el = $('plateParams'); const p = plate();
  if (!p) { el.innerHTML = '<h2>Plate</h2><p class="muted">Add a plate to start.</p>'; return; }
  el.innerHTML = `<h2>Plate ${S.plateIdx + 1}</h2><div class="form">
    <label>Type</label><span>${esc(PLATE_TYPES[p.plateType]?.label || p.plateType)} (${p.rows}×${p.cols})</span>
    <label>Name</label><input id="ppName" value="${esc(p.name || '')}">
    <label>Additional vol.</label><span><input id="ppAssay" type="number" step="any" value="${p.assayVolume / 1000}"> µL</span>
    <label>DMSO limit</label><span><input id="ppDmso" type="number" step="any" value="${+(p.dmsoLimit * 100).toPrecision(10)}"> %</span>
    <label class="full chk"><input type="checkbox" id="ppDontShake" ${p.dontShake ? 'checked' : ''}> Don't shake</label>
    <label class="full chk"><input type="checkbox" id="ppDeion" ${p.deionize ? 'checked' : ''}> Deionize</label>
    <label class="full chk"><input type="checkbox" id="ppPrompt" ${p.promptPlateLoad ? 'checked' : ''}> Prompt plate load</label></div>`;
  const bind = (id, fn) => { $(id).onchange = (e) => mutate('plate settings', () => fn(e.target)); };
  bind('ppName', (t) => { p.name = t.value; });
  bind('ppAssay', (t) => { const v = +t.value; if (!(v >= 0)) throw new Error('Additional volume must be ≥ 0'); p.assayVolume = v * 1000; });
  bind('ppDmso', (t) => { const v = +t.value; if (!(v > 0 && v <= 100)) throw new Error('DMSO limit must be between 0 and 100 %'); p.dmsoLimit = v / 100; });
  bind('ppDontShake', (t) => { p.dontShake = t.checked; });
  bind('ppDeion', (t) => { p.deionize = t.checked; });
  bind('ppPrompt', (t) => { p.promptPlateLoad = t.checked; });
}

function renderSettings() {
  const s = S.protocol.settings;
  const b = (k, label) => `<label class="full chk"><input type="checkbox" data-set="${k}" ${s[k] === 'True' ? 'checked' : ''}> ${label}</label>`;
  $('protocolSettings').innerHTML = `<h2>Protocol</h2><div class="form">
    ${b('ShakePerWell', 'Shake during dispense')}
    <label>Threshold</label><span><input data-num="ShakeThresholdVolume" type="number" value="${esc(s.ShakeThresholdVolume ?? '')}"> nL</span>
    ${b('ShakePerFluid', 'Shake after each dispense head')}
    <label>Duration</label><span><input data-num="ShakePlateDuration" type="number" value="${esc(s.ShakePlateDuration ?? '')}"> s</span>
    <label>Normalize order</label><select data-sel="BackfillOrder">${['Before', 'Mixed', 'After'].map((o) => `<option ${s.BackfillOrder === o ? 'selected' : ''} value="${o}">${o === 'Mixed' ? 'With the fluids' : o + ' fluids'}</option>`).join('')}</select>
    ${b('BackfillNoDispense', "Don't dispense normalization")}
    ${b('PrioritizeSurfactantFreeCassettes', 'Prioritize surfactant-free cassettes')}
    ${b('FluidOrderRun', 'Run in fluid order')}
    ${b('BlockFluidOnCellFail', 'Block fluid on cell fail')}
    </div><p class="hint muted">Settings without a guide description are passed through as saved.</p>`;
  for (const i of $('protocolSettings').querySelectorAll('[data-set]')) i.onchange = () => mutate('protocol settings', () => { s[i.dataset.set] = i.checked ? 'True' : 'False'; });
  for (const i of $('protocolSettings').querySelectorAll('[data-num]')) i.onchange = () => mutate('protocol settings', () => { if (!(+i.value >= 0)) throw new Error('Must be ≥ 0'); s[i.dataset.num] = String(+i.value); });
  for (const i of $('protocolSettings').querySelectorAll('[data-sel]')) i.onchange = () => mutate('protocol settings', () => { s[i.dataset.sel] = i.value; });
}

function renderShowSelect() {
  const sel = $('showFluid');
  sel.innerHTML = `<option value="all">All fluids</option>` + S.protocol.fluids.map((f) => `<option value="${f.id}" ${String(f.id) === String(S.showFluid) ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  if (S.showFluid !== 'all' && !fluidById(+S.showFluid)) S.showFluid = 'all';
  sel.value = String(S.showFluid);
}

function wellResult(r, c) { return S.computed?.[S.plateIdx]?.wells.get(wellKey(r, c)); }

function renderGrid() {
  const g = $('plateGrid'); const p = plate();
  if (!p) { g.innerHTML = ''; $('legend').innerHTML = ''; return; }
  const size = p.cols > 24 ? 11 : p.cols > 12 ? 22 : 34;
  g.style.gridTemplateColumns = `18px repeat(${p.cols}, ${size}px)`;
  g.style.gridAutoRows = `${size}px`;
  const frag = document.createDocumentFragment();
  const hdr = (txt, fn) => { const d = document.createElement('div'); d.className = 'hdr'; d.textContent = txt; d.onclick = fn; frag.appendChild(d); };
  hdr('⌗', () => selectRect(0, 0, p.rows - 1, p.cols - 1));
  for (let c = 0; c < p.cols; c++) hdr(p.cols > 24 && c % 2 ? '' : c + 1, (e) => selectLine('col', c, e));
  const showId = S.showFluid === 'all' ? null : +S.showFluid;
  const range = showId != null ? fluidRange(p, showId) : null;
  const normSet = new Set(S.protocol.backfills.flatMap((b) => b.wells.filter((w) => w.p === S.plateIdx).map((w) => wellKey(w.r, w.c))));
  for (let r = 0; r < p.rows; r++) {
    hdr(rowLabel(r), (e) => selectLine('row', r, e));
    for (let c = 0; c < p.cols; c++) {
      const k = wellKey(r, c), m = p.wells.get(k), d = document.createElement('div');
      d.className = 'well'; d.dataset.r = r; d.dataset.c = c;
      if (S.sel.has(k)) d.classList.add('sel');
      const res = wellResult(r, c);
      if (res && res.warnings.length) d.classList.add('warn');
      if (m && m.size) {
        if (showId != null) {
          const v = m.get(showId);
          if (v) d.style.background = heat(fluidById(showId), v, range);
        } else {
          const ids = [...m.keys()];
          // one colour per fluid present; multi-fluid wells are split into equal slices
          const cols = ids.map((id) => tint(fluidColor(fluidById(id) || { id }), 0.8));
          d.style.background = cols.length === 1 ? cols[0]
            : `conic-gradient(${cols.map((c, i) => `${c} ${(i * 360) / cols.length}deg ${((i + 1) * 360) / cols.length}deg`).join(', ')})`;
        }
      }
      if ($('showNorm').checked && normSet.has(k)) { const n = document.createElement('span'); n.className = 'norm'; d.appendChild(n); }
      d.title = wellTitle(r, c);
      frag.appendChild(d);
    }
  }
  g.replaceChildren(frag);
  $('selInfo').textContent = `${S.sel.size} well${S.sel.size === 1 ? '' : 's'} selected`;
  const L = $('legend');
  if (showId != null && range) {
    const f = fluidById(showId);
    L.innerHTML = `<span>${esc(f.name)}</span><span>${fmt(range.min)}</span><span class="bar" style="background:linear-gradient(90deg, ${tint(fluidColor(f), 0.12)}, ${fluidColor(f)})"></span><span>${fmt(range.max)} ${esc(unitLabel(wellUnit(f)))} (log scale)</span>`;
  } else L.innerHTML = S.protocol.fluids.map((f) => `<span><span class="swatch" style="background:${fluidColor(f)}"></span> ${esc(f.name)}</span>`).join('') + ($('showNorm').checked ? '<span>▪ lower-left = normalized</span>' : '') + '<span style="color:var(--danger)">● upper-right = warning</span>';
}
const rowLabel = (r) => wellName(r, 0).replace(/\d+$/, '');
function fluidRange(p, id) {
  let min = Infinity, max = -Infinity;
  for (const m of p.wells.values()) { const v = m.get(id); if (v) { min = Math.min(min, v); max = Math.max(max, v); } }
  return min <= max ? { min, max } : null;
}
function heat(f, v, rg) {
  const t = rg.max > rg.min ? (Math.log(v) - Math.log(rg.min)) / (Math.log(rg.max) - Math.log(rg.min)) : 1;
  return tint(fluidColor(f), 0.12 + 0.88 * t);
}
function tint(hex, a) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}
function wellTitle(r, c) {
  const m = plate().wells.get(wellKey(r, c)); const res = wellResult(r, c);
  const lines = [wellName(r, c)];
  if (m) for (const [id, v] of m) { const f = fluidById(id); lines.push(`${f?.name ?? id}: ${fmt(v, 5)} ${unitLabel(wellUnit(f || { byVol: false, concentrationUnit: 'µM' }))}`); }
  if (res && Number.isFinite(res.totalVolume)) lines.push(`Total ${fmt(res.totalVolume / 1000, 6)} µL, DMSO ${(res.dmsoFraction * 100).toFixed(3)} %`);
  if (res?.warnings.length) lines.push('⚠ ' + res.warnings.map(warnText).join('; '));
  return lines.join('\n');
}

function renderInspector() {
  const el = $('inspector'); const p = plate();
  if (!p || S.sel.size !== 1) { el.innerHTML = `<span class="muted">${p ? 'Select a single well to see its volumes. Hover any well for a summary.' : ''}</span>`; return; }
  const [r, c] = splitKey([...S.sel][0]); const res = wellResult(r, c);
  if (!res) { el.innerHTML = `<strong>${wellName(r, c)}</strong> <span class="muted">empty</span>`; return; }
  const rows = res.fluids.map((x) => { const f = fluidById(x.fluidId); const u = unitLabel(wellUnit(f));
    return `<tr><td><span class="swatch" style="background:${fluidColor(f)}"></span> ${esc(f.name)}</td><td>${fmt(x.requested, 6)} ${u}</td><td>${x.volume} nL</td><td>${x.dispensed != null ? fmt(x.dispensed, 8) + ' ' + u : '–'}</td></tr>`; }).join('');
  el.innerHTML = `<strong>${wellName(r, c)}</strong>
    <table><tr><th>Fluid</th><th>Requested</th><th>Dispense</th><th>Actual conc.</th></tr>${rows}
    ${res.normalization ? `<tr><td>Normalization</td><td></td><td>${res.normalization} nL</td><td></td></tr>` : ''}</table>
    <p>Total well volume <b>${fmt(res.totalVolume / 1000, 7)} µL</b> · DMSO <b>${(res.dmsoFraction * 100).toFixed(4)} %</b> (limit ${+(p.dmsoLimit * 100).toPrecision(6)} %)</p>
    ${res.warnings.length ? `<ul class="warnlist">${res.warnings.map((w) => `<li class="w">⚠ ${esc(warnText(w))}</li>`).join('')}</ul>` : ''}`;
}

function warnText(w) {
  const f = w.fluidId != null ? fluidById(w.fluidId)?.name : '';
  switch (w.code) {
    case 'below_min_volume': return `${f}: below minimum dispense volume (${fmt(w.requestedVolume * 1000, 3)} pL requested)`;
    case 'above_max_volume': return `${f}: above 10 µL per fluid per well`;
    case 'dmso_limit': return `DMSO ${(w.dmsoFraction * 100).toFixed(3)} % exceeds limit ${+(w.limit * 100).toPrecision(6)} %`;
    case 'no_solution': return 'Concentrations cannot be reached (fluid volumes would exceed the well)';
    case 'above_stock': return `${f}: requested concentration ≥ stock`;
    case 'no_stock': return `${f}: stock concentration missing`;
    case 'normalization_below_min': return `Normalization ${fmt(w.requested, 3)} nL is below 1 nL and is skipped`;
    default: return w.code;
  }
}

// ---------------- selection ----------------
let drag = null;
function cellFromEvent(e) { const t = e.target.closest('.well'); return t ? [+t.dataset.r, +t.dataset.c] : null; }
function selectRect(r0, c0, r1, c1, add = false) {
  if (!add) S.sel.clear();
  for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) S.sel.add(wellKey(r, c));
  renderGrid(); renderInspector(); renderOpPanel();
}
function selectLine(kind, i, e) {
  const p = plate(); const add = e.metaKey || e.ctrlKey || e.shiftKey;
  if (kind === 'row') selectRect(i, 0, i, p.cols - 1, add); else selectRect(0, i, p.rows - 1, i, add);
}
function selectedCells() { return [...S.sel].map(splitKey).sort((a, b) => a[0] - b[0] || a[1] - b[1]); }

function bindGrid() {
  const g = $('plateGrid');
  g.addEventListener('mousedown', (e) => {
    const cell = cellFromEvent(e); if (!cell) return;
    e.preventDefault(); g.focus();
    const add = e.metaKey || e.ctrlKey;
    if (e.shiftKey && S.anchor) { selectRect(S.anchor[0], S.anchor[1], cell[0], cell[1], add); return; }
    if (add) { const k = wellKey(...cell); S.sel.has(k) ? S.sel.delete(k) : S.sel.add(k); S.anchor = cell; renderGrid(); renderInspector(); renderOpPanel(); return; }
    S.anchor = cell; drag = { start: cell, base: new Set() }; selectRect(cell[0], cell[1], cell[0], cell[1]);
  });
  g.addEventListener('mouseover', (e) => {
    if (!drag || !(e.buttons & 1)) return; const cell = cellFromEvent(e); if (!cell) return;
    selectRect(drag.start[0], drag.start[1], cell[0], cell[1]);
  });
  window.addEventListener('mouseup', () => { drag = null; });
}

// ---------------- dialogs ----------------
function dialog(html, onOk, okLabel = 'OK') {
  const d = $('dlg'), f = $('dlgForm');
  f.innerHTML = `${html}<div class="actions" style="margin-top:12px;display:flex;gap:6px;justify-content:flex-end"><button value="cancel" formnovalidate>Cancel</button><button value="ok" class="primary">${okLabel}</button></div>`;
  d.returnValue = ''; d.showModal();
  return new Promise((resolve) => {
    d.onclose = () => { if (d.returnValue === 'ok') { const ok = onOk ? onOk(f) : true; resolve(ok); } else resolve(false); };
  });
}

function editFluid(f) {
  const isNew = !f;
  f = f || { name: '', byVol: false, concentration: 10000, concentrationUnit: 'mM', classId: 0, maxVolume: 1000, maxVolumeUnit: 'nL' };
  const units = [...Object.keys(MOLARITY_UNITS), ...Object.keys(MASS_UNITS)];
  const usedInWells = !isNew && S.protocol.plates.some((p) => [...p.wells.values()].some((m) => m.has(f.id)));
  dialog(`<h3>${isNew ? 'Add fluid' : 'Edit fluid'}</h3><div class="form">
    <label>Name</label><input name="name" required value="${esc(f.name)}">
    <label>Dispense by</label><select name="byVol" ${usedInWells ? 'disabled' : ''}><option value="0" ${!f.byVol ? 'selected' : ''}>Concentration</option><option value="1" ${f.byVol ? 'selected' : ''}>Volume</option></select>
    <label>Stock conc.</label><span><input name="conc" type="number" step="any" min="0" value="${f.byVol ? '' : +toDisplay(f.concentration, f.concentrationUnit).toPrecision(12)}">
      <select name="unit">${units.map((u) => `<option ${u === f.concentrationUnit ? 'selected' : ''} value="${u}">${unitLabel(u)}</option>`).join('')}</select></span>
    <label>Fluid class</label><select name="cls">${Object.entries(FLUID_CLASSES).map(([id, c]) => `<option value="${id}" ${+id === f.classId ? 'selected' : ''}>${c.label}${c.unverifiedId ? ' (ID unverified)' : ''}</option>`).join('')}</select>
    </div>${usedInWells ? '<p class="hint">Dispense mode cannot change while the fluid is used in wells.</p>' : ''}
    ${isNew ? '' : '<p><button value="delete" class="danger" formnovalidate>Delete fluid</button></p>'}`, (form) => {
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
  $('dlgForm').querySelector('[value=delete]')?.addEventListener('click', (e) => {
    e.preventDefault(); $('dlg').close('cancel');
    if (confirm(`Delete ${f.name} and remove it from all wells?`)) mutate('delete fluid', () => removeFluid(S.protocol, f.id));
  });
}

function addPlateDialog() {
  const cur = plate();
  dialog(`<h3>Add plate</h3><div class="form">
    <label>Type</label><select name="type">${Object.entries(PLATE_TYPES).map(([k, v]) => `<option value="${k}" ${k === (cur?.plateType || 'Default384') ? 'selected' : ''}>${v.label}${k === 'Default384' ? '' : ' (type ID unverified)'}</option>`).join('')}</select>
    <label>Additional vol.</label><span><input name="assay" type="number" step="any" value="${(cur?.assayVolume ?? 50000) / 1000}"> µL</span>
    <label>DMSO limit</label><span><input name="dmso" type="number" step="any" value="${+((cur?.dmsoLimit ?? 0.01) * 100).toPrecision(8)}"> %</span></div>`, (form) => {
    const fd = new FormData(form);
    return mutate('add plate', () => {
      const p = newPlate({ plateType: fd.get('type'), assayVolume: +fd.get('assay') * 1000, dmsoLimit: +fd.get('dmso') / 100 });
      if (!(p.assayVolume >= 0) || !(p.dmsoLimit > 0)) throw new Error('Check the volume and DMSO limit');
      S.protocol.plates.push(p); S.plateIdx = S.protocol.plates.length - 1; S.sel.clear();
    });
  }, 'Add');
}

// ---------------- operation panels ----------------
function fluidOptions(sel, filter = () => true) {
  return S.protocol.fluids.filter(filter).map((f) => `<option value="${f.id}" ${f.id === sel ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
}
function rangeHint(fid) {
  const f = fluidById(fid), p = plate(); if (!f || !p) return '';
  if (f.byVol) return 'Volume in nL';
  const { min, max } = validRange(f, p); const u = unitLabel(wellUnit(f));
  return `Valid range is ${fmt(min, 3)} to ${fmt(max, 3)} ${u}`;
}

function renderOpPanel() {
  for (const b of $('opTabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === S.tab);
  const el = $('opPanel');
  const need = (msg) => { el.innerHTML = `<p class="hint">${msg}</p>`; };
  if (S.tab === 'check') return renderCheck(el);
  if (S.tab === 'synergy') return renderSynergy(el);
  if (!S.protocol.fluids.length && S.tab !== 'normalize') return need('Add a fluid first.');
  if (!plate()) return need('Add a plate first.');
  if (S.tab === 'normalize') return renderNormalize(el);
  const n = S.sel.size;
  if (S.tab === 'set') {
    el.innerHTML = `<div class="form"><label>Fluid</label><select id="opFluid">${fluidOptions(S.fluidId)}</select>
      <label>Value</label><span><input id="opVal" type="number" step="any" min="0"> <span id="opUnit"></span></span></div>
      <p class="hint" id="opRange"></p><p class="hint">${n} well${n === 1 ? '' : 's'} selected</p>
      <div class="actions"><button id="opApply" class="primary" ${n ? '' : 'disabled'}>Apply</button><button id="opRemove" ${n ? '' : 'disabled'}>Remove fluid from selection</button></div>`;
    const upd = () => { const f = fluidById(+$('opFluid').value); S.fluidId = f.id; $('opUnit').textContent = unitLabel(wellUnit(f)); $('opRange').textContent = rangeHint(f.id); };
    $('opFluid').onchange = upd; upd();
    $('opApply').onclick = async () => {
      const fid = +$('opFluid').value, v = +$('opVal').value; if (!(v > 0)) return toast('Enter a value above 0');
      const cells = selectedCells();
      if (conflicts(plate(), cells, fid).length && !confirm(`${fluidById(fid).name} is already in some selected wells. Replace those values?`)) return;
      await maybeShift(fid, v, v, (useFid) => setValue(plate(), cells, useFid, v), 'set value');
    };
    $('opRemove').onclick = () => mutate('remove fluid from wells', () => clearWells(plate(), selectedCells(), +$('opFluid').value));
    return;
  }
  if (S.tab === 'titration') {
    el.innerHTML = `<div class="form"><label>Fluid</label><select id="tFluid">${fluidOptions(S.fluidId, (f) => !f.byVol)}</select>
      <label>Specify by</label><select id="tMode"><option value="highLow">Highest & lowest</option><option value="high">Highest</option><option value="low">Lowest</option></select>
      <label>Highest</label><input id="tHigh" type="number" step="any" min="0">
      <label>Lowest</label><input id="tLow" type="number" step="any" min="0">
      <label>Distribution</label><select id="tDist"></select>
      <label id="tFacL">Factor (1:N)</label><input id="tFac" type="number" step="any" min="1" value="2">
      <label>Replicates</label><input id="tRep" type="number" min="1" value="1">
      <label>Direction</label><select id="tDir"><option value="rows">Along rows</option><option value="cols">Down columns</option></select>
      <label>Order</label><select id="tOrder"><option value="high">Highest first</option><option value="low">Lowest first</option></select>
      <label>Replicates</label><select id="tRepLayout"><option value="adjacent">Adjacent (L1 L1 L2 L2…)</option><option value="series">Repeat series (L1 L2… L1 L2…)</option></select>
      </div><p class="hint" id="tRange"></p><p class="hint" id="tInfo"></p><p class="hint" id="tPreview"></p>
      <div class="actions"><button id="tApply" class="primary">Apply</button></div>`;
    const dists = { highLow: [['log', 'Logarithmic'], ['linear', 'Linear']], high: [['halfLog', '1/2 Log'], ['thirdLog', '1/3 Log'], ['quarterLog', '1/4 Log'], ['dilution', '1:N'], ['linear', 'Linear (increment)']] };
    dists.low = dists.high;
    const read = () => {
      const mode = $('tMode').value, dist = $('tDist').value;
      const rep = Math.max(1, Math.floor(+$('tRep').value || 1));
      return { fid: +$('tFluid').value, mode, distribution: dist, high: +$('tHigh').value, low: +$('tLow').value, factor: +$('tFac').value, increment: +$('tFac').value, replicates: rep, levels: S.sel.size / rep };
    };
    const upd = () => {
      const mode = $('tMode').value; const cur = $('tDist').value;
      $('tDist').innerHTML = dists[mode].map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');
      const o = read();
      $('tHigh').disabled = mode === 'low'; $('tLow').disabled = mode === 'high';
      const facUse = mode !== 'highLow' && (o.distribution === 'dilution' || o.distribution === 'linear');
      $('tFac').disabled = !facUse; $('tFacL').textContent = o.distribution === 'linear' ? 'Increment' : 'Factor (1:N)';
      S.fluidId = o.fid; $('tRange').textContent = rangeHint(o.fid);
      $('tInfo').textContent = `${S.sel.size} wells selected → ${Number.isInteger(o.levels) ? o.levels + ' levels' : 'not a multiple of replicates'}`;
      try { const lv = titrationLevels(o); $('tPreview').textContent = 'Levels: ' + lv.map((x) => fmt(x, 4)).join(', '); } catch (e) { $('tPreview').textContent = S.sel.size ? e.message : ''; }
    };
    for (const id of ['tFluid', 'tMode', 'tHigh', 'tLow', 'tDist', 'tFac', 'tRep']) $(id).oninput = upd;
    upd();
    $('tApply').onclick = async () => {
      const o = read(); if (!S.sel.size) return toast('Select wells first');
      let levels; try { levels = titrationLevels(o); } catch (e) { return toast(e.message); }
      const cells = selectedCells();
      if (conflicts(plate(), cells, o.fid).length && !confirm('This fluid is already in some selected wells. Replace those values?')) return;
      const opts = { replicates: o.replicates, direction: $('tDir').value, highFirst: $('tOrder').value === 'high', replicateLayout: $('tRepLayout').value };
      await maybeShift(o.fid, Math.max(...levels), Math.min(...levels), (useFid, extendFid, stockMin) => {
        if (extendFid == null) return applyTitration(plate(), cells, useFid, levels, opts);
        // Extension (INFERRED, §3.6): levels the stock can reach use the stock, lower levels the diluted fluid.
        applyTitration(plate(), cells, useFid, levels.map((l) => (l >= stockMin ? l : 0)), opts);
        applyTitration(plate(), cells, extendFid, levels.map((l) => (l < stockMin ? l : 0)), opts);
      }, 'titration');
    };
  }
}

/** Offer a fluid shift/extension when values fall below the one-drop minimum (§3.6). */
async function maybeShift(fid, high, low, apply, label) {
  const f = fluidById(fid), p = plate();
  const s = f.byVol ? null : suggestShift(f, p, high, low);
  if (!s) return mutate(label, () => apply(fid));
  if (s.kind === 'impossible') { if (confirm('Some values are below the minimum dispense volume even with a 1:9000 dilution. Continue anyway (they will be flagged)?')) mutate(label, () => apply(fid)); return; }
  const verb = s.kind === 'shift' ? 'Shift' : 'Extend';
  const choice = await new Promise((resolve) => {
    dialog(`<h3>Fluid ${s.kind}</h3><p>${esc(f.name)}: the lowest value needs less than one drop from the stock.</p>
      <p>Suggested dilution factor <b>1:${s.factor}</b> → new fluid <b>${esc(f.name)} - 1:${s.factor}</b>.</p>
      <p class="hint">${s.kind === 'shift' ? 'The whole series will use the diluted fluid.' : 'Higher levels use the stock and lower levels the diluted fluid.'}</p>
      <label class="chk"><input type="radio" name="c" value="use" checked> Use ${s.kind === 'shift' ? 'shifted' : 'extended'} fluid</label><br>
      <label class="chk"><input type="radio" name="c" value="no"> Do not ${s.kind} (wells below minimum are flagged)</label>`, (form) => resolve(new FormData(form).get('c')), verb);
    $('dlg').addEventListener('close', () => { if ($('dlg').returnValue !== 'ok') resolve(null); }, { once: true });
  });
  if (!choice) return;
  if (choice === 'no') return mutate(label, () => apply(fid));
  mutate(`${label} (${s.kind} 1:${s.factor})`, () => {
    let d = S.protocol.fluids.find((x) => x.name === `${f.name} - 1:${s.factor}`);
    if (!d) d = dilutedFluid(S.protocol, f, s.factor);
    if (s.kind === 'shift') apply(d.id);
    else apply(fid, d.id, validRange(f, p).min);
  });
}

function renderNormalize(el) {
  const n = S.sel.size;
  el.innerHTML = `<div class="form"><label>Fluid class</label><select id="nCls">${Object.entries(FLUID_CLASSES).map(([id, c]) => `<option value="${id}">${c.label}</option>`).join('')}</select>
    <label>Method</label><select id="nType">${Object.entries(NORMALIZE_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
    <label id="nParamL">Value</label><span><input id="nPct" type="number" step="any" min="0" value="${+(plate().dmsoLimit * 100).toPrecision(6)}"> <span id="nUnit"></span></span></div>
    <p class="hint">${n} well${n === 1 ? '' : 's'} selected on this plate. A well can be in one normalization group per fluid class; applying replaces its previous group for that class.</p>
    <div class="actions"><button id="nApply" class="primary" ${n ? '' : 'disabled'}>Normalize selection</button><button id="nRemove" ${n ? '' : 'disabled'}>Remove from selection</button></div>
    <h2 style="margin-top:14px">Groups</h2><ul class="warnlist">${S.protocol.backfills.map((b, i) => `<li>${i + 1}. ${esc(NORMALIZE_TYPES[b.type] || b.type)}${b.param != null ? ` (${NORMALIZE_PARAM[b.type] === '%' ? +(b.param * 100).toPrecision(6) + ' %' : b.param + ' nL'})` : ''} · ${FLUID_CLASSES[b.classId]?.label ?? b.classId} · ${b.wells.length} wells on plate(s) ${[...new Set(b.wells.map((w) => w.p + 1))].join(', ')} <button class="small" data-g="${i}">Select</button></li>`).join('') || '<li class="muted">None</li>'}</ul>`;
  const upd = () => { const u = NORMALIZE_PARAM[$('nType').value]; $('nPct').disabled = !u; $('nUnit').textContent = u ? (u === '%' ? '% of total' : 'nL') : ''; }; $('nType').onchange = upd; upd();
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

function renderSynergy(el) {
  const fl = S.protocol.fluids.filter((f) => !f.byVol);
  if (fl.length < 2) { el.innerHTML = '<p class="hint">Synergy needs at least two fluids dispensed by concentration.</p>'; return; }
  const st = renderSynergy.state || (renderSynergy.state = { type: 'ABC', n: 2, layout: 'multiple', gridOrder: 'rows', normalize: true });
  const cur = plate();
  const fluidBlock = (i) => `<div class="syn-fluid"><div class="form">
      <label>${st.type === 'AxEach' ? (i === 0 ? 'Primary (rows)' : `Secondary ${i}`) : ['A (rows)', 'B (columns)', 'C', 'D', 'E'][i] || `Fluid ${i + 1}`}</label><select data-k="fid" data-i="${i}">${fluidOptions(fl[i % fl.length].id, (f) => !f.byVol)}</select>
      <label>Highest</label><input data-k="high" data-i="${i}" type="number" step="any">
      <label>Lowest</label><input data-k="low" data-i="${i}" type="number" step="any">
      <label>Levels</label><input data-k="levels" data-i="${i}" type="number" min="1" value="${i < 2 ? 6 : 3}">
      <label>Distribution</label><select data-k="dist" data-i="${i}"><option value="log">Logarithmic</option><option value="linear">Linear</option></select>
      <label class="full chk"><input type="checkbox" data-k="zero" data-i="${i}" checked> Include 0</label>
      <label>Order</label><select data-k="order" data-i="${i}"><option value="highFirst">High → low</option><option value="lowFirst">Low → high</option></select>
      </div><p class="hint" data-range="${i}"></p></div>`;
  el.innerHTML = `<div class="form">
    <label>Type</label><select id="sType"><option value="ABC" ${st.type === 'ABC' ? 'selected' : ''}>A×B×C (all crossed)</option><option value="AxEach" ${st.type === 'AxEach' ? 'selected' : ''}>A×B, A×C … (primary × each)</option></select>
    <label>Fluids</label><input id="sN" type="number" min="2" max="${Math.min(6, fl.length)}" value="${st.n}">
    <label>Plate type</label><select id="sPlate">${Object.entries(PLATE_TYPES).map(([k, v]) => `<option value="${k}" ${k === (cur?.plateType || 'Default384') ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
    <label>Additional vol.</label><span><input id="sAssay" type="number" step="any" value="${(cur?.assayVolume ?? 50000) / 1000}"> µL</span>
    <label>DMSO limit</label><span><input id="sDmso" type="number" step="any" value="${+((cur?.dmsoLimit ?? 0.01) * 100).toPrecision(8)}"> %</span>
    <label>Exclude rows</label><input id="sExR" placeholder="e.g. A, P">
    <label>Exclude cols</label><input id="sExC" placeholder="e.g. 1, 24">
    <label>Layout</label><select id="sLayout">
      <option value="single">One grid per plate</option><option value="multiple" selected>Multiple grids per plate</option>
      <option value="multipleBreaks">Multiple grids, with plate breaks</option><option value="noEmpty">Leave no empty wells</option></select>
    <label>Grids by</label><select id="sOrder"><option value="rows">Rows</option><option value="cols">Columns</option></select>
    <label class="full chk"><input type="checkbox" id="sNorm" ${st.normalize ? 'checked' : ''}> Normalize DMSO to highest class volume</label>
    </div>${Array.from({ length: st.n }, (_, i) => fluidBlock(i)).join('')}
    <p class="hint" id="sInfo"></p><div class="actions"><button id="sGo" class="primary">Create plates</button></div>`;
  const upRange = () => { for (const p of el.querySelectorAll('[data-range]')) { const i = p.dataset.range; const fid = +el.querySelector(`[data-k=fid][data-i="${i}"]`).value; const f = fluidById(fid); const { min, max } = validRange(f, { assayVolume: +$('sAssay').value * 1000, dmsoLimit: +$('sDmso').value / 100 }); p.textContent = `Valid range ${fmt(min, 3)} to ${fmt(max, 3)} ${unitLabel(wellUnit(f))}`; } };
  el.oninput = upRange; upRange();
  $('sType').onchange = () => { st.type = $('sType').value; renderSynergy(el); };
  $('sN').onchange = () => { st.n = Math.max(2, Math.min(+$('sN').value || 2, fl.length)); renderSynergy(el); };
  $('sGo').onclick = () => {
    const get = (k, i) => el.querySelector(`[data-k=${k}][data-i="${i}"]`);
    const ex = (txt, isRow) => new Set(String(txt).split(/[\s,;]+/).filter(Boolean).map((t) => isRow ? rowIndex(t) : +t - 1));
    let spec;
    try {
      const fluids = Array.from({ length: st.n }, (_, i) => {
        const o = { mode: 'highLow', high: +get('high', i).value, low: +get('low', i).value, levels: Math.floor(+get('levels', i).value), distribution: get('dist', i).value };
        return { fluidId: +get('fid', i).value, levels: titrationLevels(o), includeZero: get('zero', i).checked, order: get('order', i).value };
      });
      if (new Set(fluids.map((f) => f.fluidId)).size !== fluids.length) throw new Error('Each synergy fluid must be different');
      spec = { type: st.type, fluids, plate: { plateType: $('sPlate').value, assayVolume: +$('sAssay').value * 1000, dmsoLimit: +$('sDmso').value / 100 },
        excludedRows: ex($('sExR').value, true), excludedCols: ex($('sExC').value, false), layout: $('sLayout').value, gridOrder: $('sOrder').value };
      for (const s of [...spec.excludedRows, ...spec.excludedCols]) if (!(s >= 0)) throw new Error('Could not read the excluded rows/columns');
    } catch (e) { return toast(e.message); }
    st.normalize = $('sNorm').checked;
    mutate('synergy', () => {
      const plates = buildSynergy(spec);
      const first = S.protocol.plates.length;
      S.protocol.plates.push(...plates);
      if (st.normalize) {
        const wells = plates.flatMap((p, i) => [...p.wells.keys()].map(splitKey).map(([r, c]) => ({ p: first + i, r, c })));
        addNormalization(S.protocol, 0, 'ToMaxVolume', undefined, wells);
      }
      S.plateIdx = first; S.sel.clear();
      toast(`Created ${plates.length} plate${plates.length === 1 ? '' : 's'}, ${plates.reduce((s, p) => s + p.wells.size, 0)} wells`);
    });
  };
}
const rowIndex = (t) => { t = t.toUpperCase(); if (!/^[A-Z]{1,2}$/.test(t)) return NaN; return t.length === 1 ? t.charCodeAt(0) - 65 : (t.charCodeAt(0) - 64) * 26 + t.charCodeAt(1) - 65; };

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
  el.innerHTML = `<h2>Fluid totals</h2><table class="fluids">${S.protocol.fluids.map((f) => { const t = totals.get(f.id); return `<tr><td><span class="swatch" style="background:${fluidColor(f)}"></span> ${esc(f.name)}</td><td>${t ? fmt(t.volume / 1000, 5) + ' µL' : '–'}</td><td class="muted">${t ? t.wells + ' wells' : ''}</td></tr>`; }).join('')}</table>
    <p class="hint">Dispensed volume only; cassette dead volume is not included (load-volume rule not yet confirmed).</p>
    <p>Highest DMSO in any well: <b>${(maxDmso * 100).toFixed(4)} %</b></p>
    <h2>Priming (≥ ${PRIMING_VOLUME} nL per fluid per plate)</h2>
    <p class="hint">Guide Appendix F: each plate should have one well with ≥ ${PRIMING_VOLUME} nL of every fluid it uses, so the dispense head is ready before small volumes. One "scrap" well can hold all fluids.</p>
    <ul class="warnlist">${priming.filter((x) => x.lacking.length).map((x) => `<li class="w">Plate ${x.plate + 1}: ${x.lacking.map((l) => `${esc(fluidById(l.fluidId)?.name)} (max ${fmt(l.maxVolume, 3)} nL)`).join(', ')} <button class="small" data-scrap="${x.plate}">Add scrap well</button></li>`).join('') || '<li style="color:var(--ok)">Every plate primes every fluid</li>'}</ul>
    <h2>Warnings (${issues.length})</h2><ul class="warnlist">${Object.entries(byCode).map(([code, list]) => `<li class="w">⚠ ${list.length} × ${esc(warnText(list[0].x))}${list.length > 1 ? ' …' : ''}<br><span class="muted">${list.slice(0, 12).map((i) => `P${i.pi + 1} ${wellName(...splitKey(i.k))}`).join(', ')}${list.length > 12 ? ' …' : ''}</span> <button class="small" data-code="${code}">Select</button></li>`).join('') || '<li style="color:var(--ok)">No warnings</li>'}</ul>`;
  for (const b of el.querySelectorAll('[data-scrap]')) b.onclick = () => addScrapWell(+b.dataset.scrap, priming[+b.dataset.scrap].lacking.map((l) => fluidById(l.fluidId)));
  for (const b of el.querySelectorAll('[data-code]')) b.onclick = () => {
    const list = byCode[b.dataset.code]; const p0 = list[0].pi; S.plateIdx = p0; S.sel = new Set(list.filter((i) => i.pi === p0).map((i) => i.k)); render();
  };
}

/** Put all under-primed fluids into one empty well, preferring the plate border from the last column (A24, P24, …). */
function addScrapWell(pi, fluids) {
  const p = S.protocol.plates[pi];
  const border = [];
  for (let r = 0; r < p.rows; r++) border.push([r, p.cols - 1]);
  for (let r = 0; r < p.rows; r++) border.push([r, 0]);
  for (let c = p.cols - 2; c > 0; c--) { border.push([0, c]); border.push([p.rows - 1, c]); }
  const cell = border.find(([r, c]) => !p.wells.get(wellKey(r, c))?.size);
  if (!cell) return toast('No empty border well on this plate; set a scrap well by hand');
  mutate('add scrap well', () => {
    for (const [id, v] of scrapWellValues(fluids, p)) setWell(p, cell[0], cell[1], id, v);
    S.plateIdx = pi; S.sel = new Set([wellKey(...cell)]);
  });
  toast(`Scrap well ${wellName(...cell)} on plate ${pi + 1}: ${fluids.map((f) => f.name).join(', ')} at ≥ ${PRIMING_VOLUME} nL`);
}

// ---------------- misc ----------------
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function newDoc() {
  if (S.dirty && !confirm('Discard unsaved changes?')) return;
  const p = newProtocol(); p.plates.push(newPlate());
  S.protocol = p; S.fileName = 'untitled.tdd'; S.fileHandle = null; S.dirty = false; S.undo = []; S.redo = []; S.plateIdx = 0; S.sel.clear(); S.fluidId = null;
  recompute(); render();
}

function bind() {
  $('btnNew').onclick = newDoc; $('btnOpen').onclick = openFile; $('btnSave').onclick = () => save(false); $('btnSaveAs').onclick = () => save(true);
  $('btnUndo').onclick = undo; $('btnRedo').onclick = redo; $('btnReport').onclick = exportCsv;
  $('fileInput').onchange = async (e) => { const f = e.target.files[0]; if (f) loadText(await f.text(), f.name); e.target.value = ''; };
  $('btnAddFluid').onclick = () => editFluid(null);
  $('btnAddPlate').onclick = addPlateDialog;
  $('btnReplicatePlate').onclick = () => mutate('replicate plate', () => { S.plateIdx = replicatePlate(S.protocol, S.plateIdx); });
  $('btnClearPlate').onclick = () => confirm('Clear all wells and normalization on this plate?') && mutate('clear plate', () => clearPlate(S.protocol, S.plateIdx));
  $('btnRemovePlate').onclick = () => confirm(`Remove plate ${S.plateIdx + 1}?`) && mutate('remove plate', () => { removePlate(S.protocol, S.plateIdx); S.plateIdx = Math.max(0, S.plateIdx - 1); S.sel.clear(); });
  $('showFluid').onchange = (e) => { S.showFluid = e.target.value; renderGrid(); };
  $('showNorm').onchange = renderGrid;
  $('btnSelectAll').onclick = () => plate() && selectRect(0, 0, plate().rows - 1, plate().cols - 1);
  $('btnSelectNone').onclick = () => { S.sel.clear(); renderGrid(); renderInspector(); renderOpPanel(); };
  $('btnCopy').onclick = copySel; $('btnPaste').onclick = pasteSel;
  $('btnClearSel').onclick = () => S.sel.size && mutate('clear wells', () => clearWells(plate(), selectedCells()));
  $('opTabs').onclick = (e) => { const t = e.target.dataset.tab; if (t) { S.tab = t; renderOpPanel(); } };
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey; const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
    if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(e.shiftKey); }
    else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openFile(); }
    else if (mod && e.key.toLowerCase() === 'c' && !typing && S.sel.size) { e.preventDefault(); copySel(); }
    else if (mod && e.key.toLowerCase() === 'v' && !typing) { e.preventDefault(); pasteSel(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && S.sel.size) { e.preventDefault(); mutate('clear wells', () => clearWells(plate(), selectedCells())); }
  });
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
  bindGrid();
}
function copySel() { if (!S.sel.size) return; S.clip = copyWells(plate(), selectedCells()); toast(`Copied ${S.clip.length} wells`); }
function pasteSel() {
  if (!S.clip) return toast('Nothing copied'); if (!S.sel.size) return toast('Select the top-left target well');
  const [r0, c0] = selectedCells()[0];
  mutate('paste wells', () => { const { truncated } = pasteWells(plate(), S.clip, r0, c0); if (truncated) toast(`${truncated} wells did not fit and were skipped`); });
}

bind();
newDoc();
// Optional: ?open=<url> loads a protocol (used for testing with fixtures).
const q = new URLSearchParams(location.search).get('open');
if (q) fetch(q).then((r) => { if (!r.ok) throw new Error(r.statusText); return r.text(); }).then((t) => loadText(t, decodeURIComponent(q.split('/').pop()))).catch((e) => toast(`Could not load ${q}: ${e.message}`));
// Test hook (used by browser tests; harmless in normal use).
window.__d300 = { S, serialize, render };
