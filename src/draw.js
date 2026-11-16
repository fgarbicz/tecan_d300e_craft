// Drawings of what a run needs, as SVG strings (no DOM): cassettes with their dispense heads, a dose series as a
// row of wells, a plate with its regions, a stack of plates. Used by the wizard, the Run tab and the CLI
// (<name>_loading.svg). Every drawing has a viewBox and no fixed size, so it scales with its container.
//
// Colours that depend on the theme are written as CSS (style="fill:…"), so the app can pass var(--ink) etc.;
// the CLI uses the literal light palette below.
import { fluidColor, rampColor } from './dosemap.js';
import { toDisplay, unitLabel } from './dispense.js';

export const LIGHT = { ink: '#1d2433', muted: '#6b7385', line: '#c9ced8', panel: '#ffffff', body: '#e9edf3', empty: '#f3f5f8', accent: '#2f6fde', warn: '#b7791f', danger: '#c43d3d' };
export const THEME_VARS = { ink: 'var(--ink)', muted: 'var(--muted)', line: 'var(--line)', panel: 'var(--panel)', body: 'var(--plate)', empty: 'var(--well-empty)', accent: 'var(--accent)', warn: 'var(--warn)', danger: 'var(--danger)' };
export const NORMALIZATION_COLOR = '#868e96';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f1 = (x) => +x.toFixed(1);
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, Math.max(1, n - 1)) + '…' : String(s));
/** A name on at most two lines of ~n characters (breaks at spaces; the rest is clipped). */
function twoLines(name, n) {
  const words = String(name).split(/\s+/); let a = '', i = 0;
  while (i < words.length && (a ? a.length + 1 : 0) + words[i].length <= n) { a += (a ? ' ' : '') + words[i]; i++; }
  if (!a) return [clip(name, n)];
  const b = words.slice(i).join(' ');
  return b ? [a, clip(b, n)] : [a];
}
const FONT = '-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif';
let uid = 0;
/** Diagonal hatch over a colour: marks a diluted stock (same drug, second solution). */
function hatch(color) {
  const id = `dh${uid++}`;
  return { id, def: `<pattern id="${id}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="${color}"/><rect width="2" height="5" fill="#ffffff" fill-opacity="0.55"/></pattern>` };
}
/** Concentration of the solution that goes into a head, as text: "10 mM", "0.333 mM"; "" for by-volume fluids. */
export function stockText(f) {
  if (!f || f.byVol || !(f.concentration > 0)) return '';
  return `${+toDisplay(f.concentration, f.concentrationUnit).toPrecision(3)} ${unitLabel(f.concentrationUnit)}`;
}
/**
 * { color, diluted, conc } of a fluid id in a protocol. Diluted stocks take their root drug's colour, hatched;
 * conc is the concentration of the solution to pipette (the same drug can be loaded at two concentrations), and
 * "pure DMSO" / "solvent only" for the normalization top-up (fluidId null; `isDmso` from the head's class).
 */
export function fluidLook(protocol, fluidId, isDmso = true) {
  const blank = { color: NORMALIZATION_COLOR, diluted: false, conc: isDmso ? 'pure DMSO' : 'solvent only' };
  if (fluidId == null) return blank;
  const f = protocol.fluids.find((x) => x.id === fluidId);
  if (!f) return blank;
  return { color: fluidColor(f), diluted: f.rootFluidId != null && f.rootFluidId !== f.id, conc: stockText(f) };
}
/** Short number for a label: 3 significant digits, no exponent between 0.001 and 99999. */
export function shortNum(v) {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(1).replace('e+', 'e');
  return String(+v.toPrecision(3));
}

/**
 * Cassettes and what goes into each dispense head.
 * cassettes: planRun(...).cassettes — [{ type: 'T8+'|'D4+', index, heads: [{ head, name, fluidId, load }] }]
 * look(head) → { color, diluted }.   opts: { theme, title }
 * A T8+ cassette is drawn with its 8 heads, a D4+ with its 4 larger ones; unused heads stay empty.
 */
export function cassetteSvg(cassettes, look, { theme = LIGHT, title = null, compact = false } = {}) {
  // compact (narrow containers, e.g. a side panel): 4 heads per row, so the 8 heads of a T8+ take two rows
  const W = compact ? 300 : 520, padX = compact ? 8 : 14, bodyW = W - 2 * padX, perRow = compact ? 4 : 8, rowH = 117;
  const rowsOf = (c) => (c.type === 'D4+' ? 1 : Math.ceil(8 / perRow));
  let defs = '', s = '', y = title ? 26 : 4;
  if (title) s += `<text x="${padX}" y="17" font-size="13" font-weight="600" style="fill:${theme.ink}">${esc(title)}</text>`;
  if (!cassettes.length) { s += `<text x="${padX}" y="${y + 20}" font-size="12" style="fill:${theme.muted}">Nothing to dispense yet.</text>`; y += 30; }
  for (const c of cassettes) {
    const n = c.type === 'D4+' ? 4 : 8, cols = c.type === 'D4+' ? 4 : perRow, pitch = bodyW / cols, r = c.type === 'D4+' || compact ? 20 : 16, rows = rowsOf(c);
    const big = pitch > 60;
    s += `<text x="${padX}" y="${y + 14}" font-size="12" font-weight="600" style="fill:${theme.ink}">Cassette ${c.index} · ${esc(c.type)}</text>`;
    s += `<text x="${W - padX}" y="${y + 14}" font-size="10.5" text-anchor="end" style="fill:${theme.muted}">${c.type === 'D4+' ? 'high volume, 4 heads' : '8 heads'} · ${c.heads.length} to fill</text>`;
    for (let row = 0; row < rows; row++) {
      const y0 = y + 20 + row * rowH;
      s += `<rect x="${padX}" y="${y0}" width="${bodyW}" height="58" rx="9" style="fill:${theme.body};stroke:${theme.line}"/>`;
      for (let j = 0; j < cols; j++) {
        const i = row * cols + j; if (i >= n) break;
        const cx = padX + pitch * (j + 0.5), cy = y0 + 34, h = c.heads.find((x) => x.head === i + 1);
        s += `<text x="${f1(cx)}" y="${y0 + 12}" font-size="9" text-anchor="middle" style="fill:${theme.muted}">${i + 1}</text>`;
        if (!h) { s += `<circle cx="${f1(cx)}" cy="${cy}" r="${r}" style="fill:${theme.empty};stroke:${theme.line}" stroke-dasharray="3 3"/>`; continue; }
        const lk = look(h); let fill = lk.color;
        if (lk.diluted) { const pt = hatch(lk.color); defs += pt.def; fill = `url(#${pt.id})`; }
        const vol = c.type === 'D4+' ? String(h.load) : h.load.toFixed(1);
        s += `<g><title>Head ${i + 1}: ${esc(h.name)}${lk.conc ? ` (${esc(lk.conc)})` : ''} — pipette ${vol} µL</title><circle cx="${f1(cx)}" cy="${cy}" r="${r}" fill="${fill}" style="stroke:${theme.ink}" stroke-opacity="0.35"/></g>`;
        s += `<text x="${f1(cx)}" y="${y0 + 73}" font-size="${big ? 12.5 : 11}" font-weight="700" text-anchor="middle" style="fill:${theme.ink}">${vol} µL</text>`;
        // the concentration of the solution, right under the volume: the same drug can come at two concentrations
        if (lk.conc) s += `<text x="${f1(cx)}" y="${y0 + 86}" font-size="${big ? 10.5 : 9.4}" font-weight="600" text-anchor="middle" style="fill:${theme.ink}">${esc(lk.conc)}</text>`;
        twoLines(h.name, big ? 15 : 13).forEach((ln, li) => { s += `<text x="${f1(cx)}" y="${y0 + (lk.conc ? 98 : 86) + li * 10}" font-size="${big ? 9.6 : 8.6}" text-anchor="middle" style="fill:${theme.muted}">${esc(ln)}</text>`; });
      }
    }
    y += 20 + rows * rowH + 8;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${y}" font-family="${FONT}" role="img" aria-label="Cassettes and dispense heads">${defs ? `<defs>${defs}</defs>` : ''}${s}</svg>`;
}

/**
 * A dose series as a row of wells, highest on the left.
 * levels: [{ v (display unit), kind: 'stock' | 'diluted' | 'below' | 'above' | 'zero' }]; color: the drug's colour.
 * opts: { unit, replicates, theme, dilutedName, axis: 'columns' | 'rows' }
 *  - filled circle = dispensed from the stock; hatched = from the diluted stock; ring in the warning colour =
 *    cannot be dispensed (below one drop / above the DMSO limit); empty circle = 0 (no drug).
 */
export function levelStripSvg(levels, color, { unit = '', replicates = 1, theme = LIGHT, dilutedName = null } = {}) {
  const n = Math.max(1, levels.length), W = 520, padX = 8, pitch = Math.min(46, (W - 2 * padX) / n), r = Math.min(13, pitch * 0.36);
  const pos = levels.filter((l) => l.v > 0).map((l) => l.v), lo = Math.min(...pos), hi = Math.max(...pos);
  const t = (v) => (hi > lo ? (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) : 1);
  let defs = '', s = '';
  const hp = hatch(color); let usedHatch = false;
  const cy = 18, small = pitch < 34;
  levels.forEach((l, i) => {
    const cx = padX + pitch * (i + 0.5);
    if (l.kind === 'zero') s += `<circle cx="${f1(cx)}" cy="${cy}" r="${f1(r)}" style="fill:${theme.empty};stroke:${theme.line}"/>`;
    else if (l.kind === 'below' || l.kind === 'above') s += `<circle cx="${f1(cx)}" cy="${cy}" r="${f1(r - 1)}" fill="none" style="stroke:${l.kind === 'above' ? theme.danger : theme.warn}" stroke-width="2" stroke-dasharray="3 2"/><text x="${f1(cx)}" y="${cy + 3.5}" font-size="10" font-weight="700" text-anchor="middle" style="fill:${l.kind === 'above' ? theme.danger : theme.warn}">!</text>`;
    else {
      const c = rampColor(color, t(l.v));
      s += `<circle cx="${f1(cx)}" cy="${cy}" r="${f1(r)}" fill="${c}"/>`;
      if (l.kind === 'diluted') { usedHatch = true; s += `<circle cx="${f1(cx)}" cy="${cy}" r="${f1(r)}" fill="url(#${hp.id})" fill-opacity="0.6"/><circle cx="${f1(cx)}" cy="${cy}" r="${f1(r)}" fill="none" style="stroke:${theme.ink}" stroke-opacity="0.5" stroke-dasharray="2 2"/>`; }
    }
    s += `<text x="${f1(cx)}" y="${cy + r + 12}" font-size="${small ? 8 : 9.5}" text-anchor="middle" style="fill:${theme.ink}">${esc(shortNum(l.v))}</text>`;
  });
  if (usedHatch) defs += hp.def;
  // bracket under the levels that come from the diluted stock
  let H = cy + r + 18;
  const dil = levels.map((l, i) => (l.kind === 'diluted' ? i : -1)).filter((i) => i >= 0);
  if (dil.length) {
    const x0 = padX + pitch * dil[0] + 3, x1 = padX + pitch * (dil.at(-1) + 1) - 3, y = H + 2;
    s += `<path d="M${f1(x0)},${y} v4 H${f1(x1)} v-4" fill="none" style="stroke:${theme.accent}"/><text x="${f1(Math.min(W - 6, (x0 + x1) / 2))}" y="${y + 15}" font-size="9.5" text-anchor="${(x0 + x1) / 2 > W - 110 ? 'end' : 'middle'}" style="fill:${theme.accent}">from ${esc(dilutedName || 'the diluted stock')}</text>`;
    H += 22;
  }
  const end = padX + pitch * n + 6;
  if (end < W - 60) s += `<text x="${f1(end)}" y="${cy + 4}" font-size="10.5" style="fill:${theme.muted}">${esc(unit)}${replicates > 1 ? ` · each ×${replicates}` : ''}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="${FONT}" role="img" aria-label="Dose levels">${defs ? `<defs>${defs}</defs>` : ''}${s}</svg>`;
}

/**
 * A plate as a grid of wells.
 * plate: { rows, cols, wells: Map("r,c" → Map(fluidId → value)) }
 * opts: { colorOf(fluidId) → colour, border (depth of the PBS border), scrap: Set("r,c"),
 *         regions: [{ r0, c0, rows, cols, label, color }] (cell lines / grids, outlined and named),
 *         moved: Set("r,c") wells drawn with a small dot (randomized), theme, cell }
 */
export function plateSvg(plate, { colorOf, border = 0, scrap = new Set(), regions = [], theme = LIGHT, label = null, cell = null } = {}) {
  const cs = cell || (plate.cols > 24 ? 7 : plate.cols > 12 ? 13 : 24), r = cs * 0.42, left = 16, top = (label ? 18 : 4) + 12;
  const W = left + plate.cols * cs + 8, H = top + plate.rows * cs + 8 + (regions.some((g) => g.label) ? 14 : 0);
  let s = '';
  if (label) s += `<text x="${left}" y="13" font-size="11" font-weight="600" style="fill:${theme.ink}">${esc(label)}</text>`;
  s += `<rect x="${left - 6}" y="${top - 6}" width="${plate.cols * cs + 12}" height="${plate.rows * cs + 12}" rx="6" style="fill:${theme.body}"/>`;
  const step = plate.cols > 24 ? 4 : plate.cols > 12 ? 2 : 1;
  for (let c = 0; c < plate.cols; c += step) s += `<text x="${f1(left + c * cs + cs / 2)}" y="${top - 8}" font-size="6.5" text-anchor="middle" style="fill:${theme.muted}">${c + 1}</text>`;
  for (let rr = 0; rr < plate.rows; rr += step) s += `<text x="${left - 9}" y="${f1(top + rr * cs + cs / 2 + 2.3)}" font-size="6.5" text-anchor="middle" style="fill:${theme.muted}">${String.fromCharCode(65 + (rr % 26))}</text>`;
  for (let rr = 0; rr < plate.rows; rr++) for (let c = 0; c < plate.cols; c++) {
    const cx = f1(left + c * cs + cs / 2), cy = f1(top + rr * cs + cs / 2), k = `${rr},${c}`;
    const m = plate.wells.get(k), cols = m && m.size ? [...new Set([...m.keys()].map(colorOf))] : [];
    const isBorder = border > 0 && (rr < border || c < border || rr >= plate.rows - border || c >= plate.cols - border);
    if (!cols.length) s += `<circle cx="${cx}" cy="${cy}" r="${f1(r)}" style="fill:${isBorder ? theme.accent : theme.empty}" ${isBorder ? 'fill-opacity="0.18"' : ''}/>`;
    else if (cols.length === 1) s += `<circle cx="${cx}" cy="${cy}" r="${f1(r)}" fill="${cols[0]}"/>`;
    else s += `<path d="M${cx},${f1(cy - r)} A${f1(r)},${f1(r)} 0 0 0 ${cx},${f1(cy + r)} Z" fill="${cols[0]}"/><path d="M${cx},${f1(cy - r)} A${f1(r)},${f1(r)} 0 0 1 ${cx},${f1(cy + r)} Z" fill="${cols[1]}"/>`;
    if (scrap.has(k)) s += `<circle cx="${cx}" cy="${cy}" r="${f1(r)}" fill="none" style="stroke:${theme.ink}" stroke-width="0.9" stroke-dasharray="1.5 1"/>`;
  }
  regions.forEach((g) => {
    const x = left + g.c0 * cs - 1.5, y = top + g.r0 * cs - 1.5, w = g.cols * cs + 3, h = g.rows * cs + 3;
    s += `<rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="${f1(h)}" rx="4" fill="none" stroke="${g.color || '#1d2433'}" stroke-width="1.6"/>`;
    if (g.label) s += `<text x="${f1(x + w + 4)}" y="${f1(y + h / 2 + 3)}" font-size="9" font-weight="600" fill="${g.color || '#1d2433'}">${esc(g.label)}</text>`;
  });
  const extra = regions.some((g) => g.label) ? Math.max(...regions.map((g) => String(g.label || '').length)) * 5.2 + 10 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f1(W + extra)} ${f1(H)}" font-family="${FONT}" role="img" aria-label="Plate layout">${s}</svg>`;
}

/**
 * A row of plate icons, one group per plate set: groups = [{ label, count, color }].
 * Shows at a glance how many plates the design needs and why.
 */
export function plateStackSvg(groups, { theme = LIGHT } = {}) {
  const pw = 34, ph = 23, gap = 6, padX = 8, W = 520;
  let x = padX, y = 6, s = '', rowH = ph + 26;
  for (const g of groups) {
    const w = g.count * (pw + gap) + 10;
    if (x + w > W - padX && x > padX) { x = padX; y += rowH; }
    for (let i = 0; i < g.count; i++) {
      const px = x + i * (pw + gap);
      s += `<rect x="${px}" y="${y}" width="${pw}" height="${ph}" rx="4" style="fill:${theme.body};stroke:${theme.line}"/>`;
      for (let a = 0; a < 3; a++) for (let b = 0; b < 5; b++) s += `<circle cx="${px + 5 + b * 6}" cy="${y + 5.5 + a * 6}" r="2" fill="${g.color || '#868e96'}" fill-opacity="${g.split && a === 2 ? 0.45 : 0.85}"/>`;
      s += `<text x="${px + pw / 2}" y="${y + ph + 10}" font-size="8.5" text-anchor="middle" style="fill:${theme.muted}">${g.first + i}</text>`;
    }
    s += `<text x="${x}" y="${y + ph + 21}" font-size="9.5" style="fill:${theme.ink}">${esc(clip(g.label, Math.max(8, Math.floor((groups.length === 1 ? W - x - padX : w) / 5))))}</text>`;
    x += w + 8;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${y + rowH + 2}" font-family="${FONT}" role="img" aria-label="Plates needed">${s}</svg>`;
}

/** Standalone file version of a drawing: fixed pixel width and a background (for the CLI / exports). */
export function standalone(svg, { width = 720, background = '#ffffff' } = {}) {
  const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const w = m ? +m[1] : 520, h = m ? +m[2] : 200;
  return svg.replace('<svg ', `<svg width="${width}" height="${Math.round((width * h) / w)}" `).replace(/(<svg[^>]*>)/, `$1<rect width="${w}" height="${h}" fill="${background}"/>`);
}
