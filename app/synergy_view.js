// In-app synergy figures: for every cell line × drug pair, the mean % viability matrix and the Bliss excess
// map (from analyze().synergy + conditions). Plain SVG, so they can be saved as SVG or PNG; the full set of
// SynergyFinder figures (ZIP/HSA/Bliss/Loewe maps, surfaces, dose-response fits; png/pdf/svg/rds) comes from
// the R package (src/synergy_export.js).

import { isobolePoints, doseForEffect } from '../src/chou.js';

const RDBU = ['#2166ac', '#4393c3', '#92c5de', '#d1e5f0', '#f7f7f7', '#fddbc7', '#f4a582', '#d6604d', '#b2182b'];
// viability: dark (dead) → light (alive); perceptual, colour-blind safe (viridis "mako"-like stops)
const MAKO = ['#0b0405', '#382a54', '#395d9c', '#3497a9', '#60ceac', '#def5e5'];

function lerpColor(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const a = parseInt(stops[i].slice(1), 16), b = parseInt(stops[i + 1].slice(1), 16);
  const ch = (s) => Math.round(((a >> s) & 255) * (1 - f) + ((b >> s) & 255) * f);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
const luminance = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const short = (v) => (v === 0 ? '0' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? +v.toPrecision(3) + '' : +v.toPrecision(2) + '');
const escX = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Group analyze().synergy into matrices: [{ cellLine, drugA, drugB, unitA, unitB, a:[concs], b:[concs], via, bliss }] */
export function synergyMatrices(result) {
  const groups = new Map();
  for (const s of result.synergy || []) {
    const k = `${s.cellLine}|${s.drugA}|${s.drugB}`;
    if (!groups.has(k)) groups.set(k, { cellLine: s.cellLine, drugA: s.drugA, drugB: s.drugB, unitA: s.unitA, unitB: s.unitB, rows: [] });
    groups.get(k).rows.push(s);
  }
  return [...groups.values()].map((g) => {
    const a = [0, ...new Set(g.rows.map((r) => r.concA))].sort((x, y) => x - y);
    const b = [0, ...new Set(g.rows.map((r) => r.concB))].sort((x, y) => x - y);
    const via = new Map(), bliss = new Map();
    via.set('0|0', 100);
    for (const r of g.rows) {
      via.set(`${r.concA}|${r.concB}`, r.viabilityAB); bliss.set(`${r.concA}|${r.concB}`, r.blissExcess * 100);
      via.set(`${r.concA}|0`, r.viabilityA); via.set(`0|${r.concB}`, r.viabilityB);
    }
    return { ...g, a, b, via, bliss };
  });
}

/** One heatmap as an SVG string. kind: 'viability' | 'bliss'. */
export function heatmapSvg(m, kind, { limit = null } = {}) {
  const cell = 34, left = 78, top = 46, right = 92, bottom = 58;
  const W = left + cell * m.a.length + right, H = top + cell * m.b.length + bottom;
  const lim = kind === 'bliss' ? limit || Math.max(10, ...[...m.bliss.values()].map((v) => Math.abs(v))) : null;
  const color = (v) => (kind === 'viability' ? lerpColor(MAKO, v / 110) : lerpColor(RDBU, (v + lim) / (2 * lim)));
  const title = kind === 'viability' ? 'Mean viability (% of vehicle)' : 'Bliss excess (%-points; red = synergy)';
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, Helvetica, Arial, sans-serif">`;
  s += `<rect width="${W}" height="${H}" fill="#ffffff"/>`;
  s += `<text x="${left}" y="18" font-size="13" font-weight="600" fill="#1d2433">${escX(m.cellLine)} · ${escX(m.drugA)} × ${escX(m.drugB)}</text>`;
  s += `<text x="${left}" y="34" font-size="11" fill="#5b6475">${title}</text>`;
  // rows: drugB high at the top
  const bs = [...m.b].reverse();
  bs.forEach((cb, i) => {
    s += `<text x="${left - 6}" y="${top + i * cell + cell / 2 + 4}" font-size="10" text-anchor="end" fill="#333">${short(cb)}</text>`;
    m.a.forEach((ca, j) => {
      const v = kind === 'viability' ? m.via.get(`${ca}|${cb}`) : m.bliss.get(`${ca}|${cb}`);
      const x = left + j * cell, y = top + i * cell;
      if (v == null || !Number.isFinite(v)) { s += `<rect x="${x}" y="${y}" width="${cell - 1}" height="${cell - 1}" fill="#eef0f3"/>`; return; }
      const c = color(v);
      s += `<rect x="${x}" y="${y}" width="${cell - 1}" height="${cell - 1}" rx="3" fill="${c}"/>`;
      s += `<text x="${x + cell / 2 - 0.5}" y="${y + cell / 2 + 3.5}" font-size="9.5" text-anchor="middle" fill="${luminance(c) < 140 ? '#ffffff' : '#111111'}">${v.toFixed(kind === 'viability' ? 0 : 1)}</text>`;
    });
  });
  m.a.forEach((ca, j) => { s += `<text transform="translate(${left + j * cell + cell / 2},${top + bs.length * cell + 10}) rotate(45)" font-size="10" fill="#333">${short(ca)}</text>`; });
  s += `<text x="${left + (m.a.length * cell) / 2}" y="${H - 6}" font-size="11" text-anchor="middle" fill="#1d2433">${escX(m.drugA)} (${escX(m.unitA || 'µM')})</text>`;
  s += `<text transform="translate(14,${top + (bs.length * cell) / 2}) rotate(-90)" font-size="11" text-anchor="middle" fill="#1d2433">${escX(m.drugB)} (${escX(m.unitB || 'µM')})</text>`;
  // colour bar
  const bx = left + m.a.length * cell + 18, bh = bs.length * cell;
  const [lo, hi] = kind === 'viability' ? [0, 110] : [-lim, lim];
  for (let i = 0; i < 40; i++) { const t = 1 - i / 39; s += `<rect x="${bx}" y="${top + (i * bh) / 40}" width="12" height="${bh / 40 + 0.6}" fill="${color(lo + t * (hi - lo))}"/>`; }
  s += `<text x="${bx + 16}" y="${top + 8}" font-size="10" fill="#333">${short(hi)}</text><text x="${bx + 16}" y="${top + bh}" font-size="10" fill="#333">${short(lo)}</text>`;
  if (kind === 'bliss') s += `<text x="${bx + 16}" y="${top + bh / 2 + 3}" font-size="10" fill="#333">0</text>`;
  return s + '</svg>';
}

/** Save an SVG string as .svg or rasterized .png (3×). save(name, blobOrText, mime) is supplied by the app. */
export async function exportFigure(svg, name, format, save) {
  if (format === 'svg') return save(`${name}.svg`, svg, 'image/svg+xml');
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const c = document.createElement('canvas'); c.width = img.width * 3; c.height = img.height * 3;
  const g = c.getContext('2d'); g.scale(3, 3); g.drawImage(img, 0, 0);
  URL.revokeObjectURL(url);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return save(`${name}.png`, blob, 'image/png');
}

// ---------- Chou–Talalay: CI matrix, isobolograms, Fa–CI plot ----------
// Okabe–Ito colours (colour-blind safe) for the 50 / 75 / 90 % effect levels; CI classes red / grey / blue.
const LEVELS = [{ fa: 0.5, color: '#0072B2' }, { fa: 0.75, color: '#E69F00' }, { fa: 0.9, color: '#D55E00' }];
const CI_COL = (ci) => (ci < 0.9 ? '#b2182b' : ci > 1.1 ? '#2166ac' : '#7a7a7a');
const fmtN = (v) => (v == null || !Number.isFinite(v) ? '–' : Math.abs(v) >= 1000 || Math.abs(v) < 0.01 ? v.toExponential(2) : +v.toPrecision(3) + '');

/** The Chou–Talalay entry of analyze().chou for a synergyMatrices() matrix (same cell line and drug pair). */
export function chouFor(result, m) {
  return (result.chou || []).find((p) => p.cellLine === m.cellLine && p.drugA === m.drugA && p.drugB === m.drugB) || null;
}

/** CI matrix as a heatmap; colour on log2(CI), red = synergy (CI < 1), clipped at 1/limit … limit. */
export function ciHeatmapSvg(m, ch, { limit = 4 } = {}) {
  const ci = new Map(ch.points.map((x) => [`${x.concA}|${x.concB}`, x]));
  const cell = 34, left = 78, top = 46, right = 92, bottom = 58;
  const as = m.a.filter((x) => x > 0), bs = [...m.b.filter((x) => x > 0)].reverse();
  const W = left + cell * as.length + right, H = top + cell * bs.length + bottom, L = Math.log2(limit);
  const color = (v) => lerpColor(RDBU, (-Math.log2(v) + L) / (2 * L));
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, Helvetica, Arial, sans-serif">`;
  s += `<rect width="${W}" height="${H}" fill="#ffffff"/>`;
  s += `<text x="${left}" y="18" font-size="13" font-weight="600" fill="#1d2433">${escX(m.cellLine)} · ${escX(m.drugA)} × ${escX(m.drugB)}</text>`;
  s += `<text x="${left}" y="34" font-size="11" fill="#5b6475">Combination index, Chou–Talalay (red = synergy, CI &lt; 1; faded = extrapolated)</text>`;
  bs.forEach((cb, i) => {
    s += `<text x="${left - 6}" y="${top + i * cell + cell / 2 + 4}" font-size="10" text-anchor="end" fill="#333">${short(cb)}</text>`;
    as.forEach((ca, j) => {
      const x = left + j * cell, y = top + i * cell, p = ci.get(`${ca}|${cb}`);
      if (!p || p.ci == null) { s += `<rect x="${x}" y="${y}" width="${cell - 1}" height="${cell - 1}" fill="#eef0f3"><title>${escX(p?.note || 'not measured')}</title></rect>`; return; }
      const c = color(p.ci);
      s += `<rect x="${x}" y="${y}" width="${cell - 1}" height="${cell - 1}" rx="3" fill="${c}"${p.extrapolated ? ' fill-opacity="0.35" stroke="#5b6475" stroke-dasharray="2 2"' : ''}><title>${escX(`${m.drugA} ${short(ca)} + ${m.drugB} ${short(cb)}: Fa ${p.fa.toFixed(3)}, CI ${p.ci.toFixed(3)} — ${p.interpretation}${p.extrapolated ? ' (extrapolated)' : ''}`)}</title></rect>`;
      s += `<text x="${x + cell / 2 - 0.5}" y="${y + cell / 2 + 3.5}" font-size="9.5" text-anchor="middle" fill="${luminance(c) < 140 && !p.extrapolated ? '#ffffff' : '#111111'}" pointer-events="none">${p.ci < 10 ? p.ci.toFixed(2) : p.ci.toPrecision(2)}</text>`;
    });
  });
  as.forEach((ca, j) => { s += `<text transform="translate(${left + j * cell + cell / 2},${top + bs.length * cell + 10}) rotate(45)" font-size="10" fill="#333">${short(ca)}</text>`; });
  s += `<text x="${left + (as.length * cell) / 2}" y="${H - 6}" font-size="11" text-anchor="middle" fill="#1d2433">${escX(m.drugA)} (${escX(m.unitA || 'µM')})</text>`;
  s += `<text transform="translate(14,${top + (bs.length * cell) / 2}) rotate(-90)" font-size="11" text-anchor="middle" fill="#1d2433">${escX(m.drugB)} (${escX(m.unitB || 'µM')})</text>`;
  const bx = left + as.length * cell + 18, bh = bs.length * cell;
  for (let i = 0; i < 40; i++) { const t = i / 39; s += `<rect x="${bx}" y="${top + (i * bh) / 40}" width="12" height="${bh / 40 + 0.6}" fill="${color(2 ** (L * (2 * t - 1)))}"/>`; }
  s += `<text x="${bx + 16}" y="${top + 8}" font-size="10" fill="#333">≤ ${+(1 / limit).toFixed(2)}</text><text x="${bx + 16}" y="${top + bh / 2 + 3}" font-size="10" fill="#333">1</text><text x="${bx + 16}" y="${top + bh}" font-size="10" fill="#333">≥ ${limit}</text>`;
  return s + '</svg>';
}

// shared frame for the x–y plots: returns { s, X, Y, close }
function plotFrame({ W = 360, H = 330, title, subtitle, xlab, ylab, xmax, ymax, xticks, yticks, xfmt = short, yfmt = short }) {
  const l = 58, r = 16, t = 46, b = 46, pw = W - l - r, ph = H - t - b;
  const X = (v) => l + (v / xmax) * pw, Y = (v) => t + ph - (v / ymax) * ph;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, Helvetica, Arial, sans-serif">`;
  s += `<rect width="${W}" height="${H}" fill="#ffffff"/><defs><clipPath id="pc${W}${H}${Math.round(xmax * 1e6)}"><rect x="${l}" y="${t}" width="${pw}" height="${ph}"/></clipPath></defs>`;
  s += `<text x="${l}" y="18" font-size="13" font-weight="600" fill="#1d2433">${escX(title)}</text><text x="${l}" y="34" font-size="11" fill="#5b6475">${subtitle}</text>`;
  for (const v of xticks) s += `<line x1="${X(v)}" x2="${X(v)}" y1="${t}" y2="${t + ph}" stroke="#eceef2"/><text x="${X(v)}" y="${t + ph + 14}" font-size="10" text-anchor="middle" fill="#333">${xfmt(v)}</text>`;
  for (const v of yticks) s += `<line x1="${l}" x2="${l + pw}" y1="${Y(v)}" y2="${Y(v)}" stroke="#eceef2"/><text x="${l - 6}" y="${Y(v) + 3.5}" font-size="10" text-anchor="end" fill="#333">${yfmt(v)}</text>`;
  s += `<rect x="${l}" y="${t}" width="${pw}" height="${ph}" fill="none" stroke="#9aa3b2"/>`;
  s += `<text x="${l + pw / 2}" y="${H - 8}" font-size="11" text-anchor="middle" fill="#1d2433">${xlab}</text>`;
  s += `<text transform="translate(14,${t + ph / 2}) rotate(-90)" font-size="11" text-anchor="middle" fill="#1d2433">${ylab}</text>`;
  return { s, X, Y, clip: `url(#pc${W}${H}${Math.round(xmax * 1e6)})`, l, t, pw, ph };
}
const niceTicks = (max, n = 5) => {
  const step0 = max / n, p = 10 ** Math.floor(Math.log10(step0)), step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((k) => k >= step0);
  const out = []; for (let v = 0; v <= max * 1.0001; v += step) out.push(+v.toPrecision(10)); return out;
};

/**
 * Classic isobologram (linear doses): for 50 / 75 / 90 % effect, the additive line from (Dx)A on the A axis
 * to (Dx)B on the B axis (dashed), and the observed iso-effect points from the dose matrix (solid). Observed
 * points below / left of their dashed line = synergy at that effect level.
 */
export function isobologramSvg(m, ch) {
  const faAt = (a, b) => { const v = m.via.get(`${a}|${b}`); return v == null || !Number.isFinite(v) ? null : 1 - v / 100; };
  const maxA = Math.max(...m.a), maxB = Math.max(...m.b);
  const lv = LEVELS.map((L) => ({ ...L,
    dxA: ch.fitA.ok ? doseForEffect(ch.fitA, L.fa) : null, dxB: ch.fitB.ok ? doseForEffect(ch.fitB, L.fa) : null,
    pts: isobolePoints(m.a, m.b, faAt, L.fa) }));
  // axes (linear, as a classic isobologram): around the ED50–ED90 region, not the whole tested range — a dose
  // series over several decades would otherwise squeeze every isobole against the axes. Range: 1.3× the largest
  // additive intercept, or, without a fit, the largest observed iso-effect dose; never beyond the doses tested.
  const span = (dx, k) => { const v = lv.map((L) => L[dx]).filter((x) => x > 0); return v.length ? Math.max(...v) : Math.max(0, ...lv.flatMap((L) => L.pts.map((p) => p[k]))); };
  const xmax = (Math.min(maxA, 1.3 * span('dxA', 0)) || maxA) * 1.05, ymax = (Math.min(maxB, 1.3 * span('dxB', 1)) || maxB) * 1.05;
  const off = lv.reduce((n, L) => n + L.pts.filter((p) => p[0] > xmax || p[1] > ymax).length, 0);
  const F = plotFrame({ title: `${m.cellLine} · ${m.drugA} × ${m.drugB}`, subtitle: 'Isobologram at 50 / 75 / 90 % effect (dashed = additive)',
    xlab: `${escX(m.drugA)} (${escX(m.unitA || 'µM')})`, ylab: `${escX(m.drugB)} (${escX(m.unitB || 'µM')})`, xmax, ymax, xticks: niceTicks(xmax, 4), yticks: niceTicks(ymax, 5) });
  let s = F.s + `<g clip-path="${F.clip}">`;
  for (const L of lv) {
    if (L.dxA != null && L.dxB != null) s += `<line x1="${F.X(L.dxA)}" y1="${F.Y(0)}" x2="${F.X(0)}" y2="${F.Y(L.dxB)}" stroke="${L.color}" stroke-width="1.6" stroke-dasharray="5 4"><title>Additive at ${L.fa * 100} % effect: ${escX(m.drugA)} alone ${fmtN(L.dxA)} ${escX(m.unitA)}, ${escX(m.drugB)} alone ${fmtN(L.dxB)} ${escX(m.unitB)}</title></line>`;
    const pts = [...L.pts].sort((p, q) => Math.atan2(q[1] / ymax, q[0] / xmax) - Math.atan2(p[1] / ymax, p[0] / xmax));
    if (pts.length > 1) s += `<polyline fill="none" stroke="${L.color}" stroke-width="1.8" points="${pts.map((p) => `${F.X(p[0]).toFixed(1)},${F.Y(p[1]).toFixed(1)}`).join(' ')}"/>`;
    for (const p of pts) s += `<circle cx="${F.X(p[0])}" cy="${F.Y(p[1])}" r="3.2" fill="${L.color}" stroke="#fff" stroke-width="0.8"><title>${L.fa * 100} % effect observed at ${escX(m.drugA)} ${fmtN(p[0])} + ${escX(m.drugB)} ${fmtN(p[1])}</title></circle>`;
  }
  s += '</g>';
  if (off) s += `<text x="${F.l + F.pw}" y="${F.t + F.ph + 30}" font-size="9.5" text-anchor="end" fill="#5b6475">${off} point${off > 1 ? 's' : ''} beyond the axes</text>`;
  LEVELS.forEach((L, i) => { const x = F.l + F.pw - 70, y = F.t + 12 + i * 15; s += `<line x1="${x}" x2="${x + 18}" y1="${y}" y2="${y}" stroke="${L.color}" stroke-width="2"/><text x="${x + 22}" y="${y + 3.5}" font-size="10" fill="#333">ED${L.fa * 100}</text>`; });
  return s + '</svg>';
}

/** Normalized isobologram (Chou): each combination at (dA/(Dx)A, dB/(Dx)B); below the diagonal = synergy. */
export function normalizedIsobologramSvg(m, ch) {
  const pts = ch.points.filter((p) => p.ci != null);
  const lim = Math.max(1.2, Math.min(3, Math.max(0, ...pts.map((p) => Math.max(p.xA, p.xB))) * 1.08));
  const ticks = niceTicks(lim, 4);
  const F = plotFrame({ title: `${m.cellLine} · ${m.drugA} × ${m.drugB}`, subtitle: 'Normalized isobologram (below the line = synergy)',
    xlab: `${escX(m.drugA)}: d / Dx`, ylab: `${escX(m.drugB)}: d / Dx`, xmax: lim, ymax: lim, xticks: ticks, yticks: ticks, W: 330 });
  let s = F.s + `<line x1="${F.X(1)}" y1="${F.Y(0)}" x2="${F.X(0)}" y2="${F.Y(1)}" stroke="#1d2433" stroke-width="1.3" stroke-dasharray="5 4"/>`;
  for (const p of pts) {
    const out = p.xA > lim || p.xB > lim, x = F.X(Math.min(p.xA, lim)), y = F.Y(Math.min(p.xB, lim)), open = out || p.extrapolated;
    s += `<circle cx="${x}" cy="${y}" r="3.6" fill="${open ? '#fff' : CI_COL(p.ci)}" stroke="${CI_COL(p.ci)}" stroke-width="${open ? 1.3 : 0.8}" fill-opacity="0.85"${p.extrapolated ? ' stroke-opacity="0.6"' : ''}><title>${escX(`${m.drugA} ${short(p.concA)} + ${m.drugB} ${short(p.concB)}: Fa ${p.fa.toFixed(3)}, CI ${p.ci.toFixed(3)} — ${p.interpretation}${p.extrapolated ? ' (extrapolated)' : ''}${out ? ' (off scale)' : ''}`)}</title></circle>`;
  }
  return s + legendCI(F) + '</svg>';
}

/** Fa–CI plot (Chou–Talalay plot): CI of every combination against the effect it produced. */
export function faCiSvg(m, ch) {
  const pts = ch.points.filter((p) => p.ci != null);
  const ymax = Math.max(1.5, Math.min(5, Math.max(0, ...pts.map((p) => p.ci)) * 1.1));
  const F = plotFrame({ title: `${m.cellLine} · ${m.drugA} × ${m.drugB}`, subtitle: 'Fa–CI plot (CI &lt; 1 synergy, &gt; 1 antagonism)',
    xlab: 'Fa (fraction affected)', ylab: 'Combination index', xmax: 1, ymax, xticks: [0, 0.2, 0.4, 0.6, 0.8, 1], yticks: niceTicks(ymax, 5), W: 330 });
  let s = F.s + `<rect x="${F.X(0)}" y="${F.Y(1.1)}" width="${F.X(1) - F.X(0)}" height="${F.Y(0.9) - F.Y(1.1)}" fill="#f1f2f4"/>`;
  s += `<line x1="${F.X(0)}" x2="${F.X(1)}" y1="${F.Y(1)}" y2="${F.Y(1)}" stroke="#1d2433" stroke-width="1.2" stroke-dasharray="5 4"/>`;
  for (const p of pts) {
    const out = p.ci > ymax, open = out || p.extrapolated;
    s += `<circle cx="${F.X(p.fa)}" cy="${F.Y(Math.min(p.ci, ymax))}" r="3.6" fill="${open ? '#fff' : CI_COL(p.ci)}" stroke="${CI_COL(p.ci)}" stroke-width="${open ? 1.3 : 0.8}" fill-opacity="0.85"${p.extrapolated ? ' stroke-opacity="0.6"' : ''}><title>${escX(`${m.drugA} ${short(p.concA)} + ${m.drugB} ${short(p.concB)}: Fa ${p.fa.toFixed(3)}, CI ${p.ci.toFixed(3)} — ${p.interpretation}${p.extrapolated ? ' (extrapolated)' : ''}`)}</title></circle>`;
  }
  return s + legendCI(F) + '</svg>';
}
function legendCI(F) {
  return [['synergy', '#b2182b'], ['additive', '#7a7a7a'], ['antagonism', '#2166ac'], ['extrapolated', null]].map(([t, c], i) => {
    const x = F.l + F.pw - 84, y = F.t + 12 + i * 14;
    return `<circle cx="${x}" cy="${y}" r="3.6" fill="${c || '#fff'}" stroke="${c || '#7a7a7a'}" stroke-width="${c ? 0 : 1.3}"/><text x="${x + 8}" y="${y + 3.5}" font-size="10" fill="#333">${t}</text>`;
  }).join('');
}

/** One-line summary of a pair's median-effect fits and CI counts, as HTML. */
export function chouSummaryHtml(ch, esc = escX) {
  const warn = (t) => ` <b class="warnTxt">${t}</b>`;
  const fit = (name, unit, f) => (f.ok
    ? `${esc(name)} alone: m ${f.m.toFixed(2)}, Dm ${fmtN(f.Dm)} ${esc(unit)}, r ${f.r.toFixed(3)} · ${f.n} point${f.n > 1 ? 's' : ''} between 10 and 90 % effect${f.excluded ? ` (${f.excluded} outside left out)` : ''}`
      + (f.r < 0.9 ? warn('r &lt; 0.90: poor fit') : '') + (f.fallback ? warn('fewer than 2 doses between 10 and 90 %: fitted on all points') : '')
    : `${esc(name)} alone:` + warn(`no median-effect fit (${esc(f.reason)})`))
    + (f.plateau != null ? ';' + warn(`the highest doses level off at ${(f.plateau * 100).toFixed(1)} % effect — a reader floor? Mark blank wells so that background is subtracted.`) : '');
  const S = ch.summary;
  return `<div class="hint">${fit(ch.drugA, ch.unitA, ch.fitA)}<br>${fit(ch.drugB, ch.unitB, ch.fitB)}<br>`
    + (S.n ? `CI within the single-agent data: ${S.synergistic} synergistic (&lt; 0.9), ${S.additive} nearly additive, ${S.antagonistic} antagonistic (&gt; 1.1); geometric mean ${S.geoMeanCI.toFixed(2)}.` : 'No combination has a CI within the single-agent data.')
    + (S.extrapolated ? ` ${S.extrapolated} more need doses beyond those tested alone (faded / open): not counted.` : '')
    + '</div>';
}
