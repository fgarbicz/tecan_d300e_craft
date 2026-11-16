// In-app synergy figures: for every cell line × drug pair, the mean % viability matrix and the Bliss excess
// map (from analyze().synergy + conditions). Plain SVG, so they can be saved as SVG or PNG; the full set of
// SynergyFinder figures (ZIP/HSA/Bliss/Loewe maps, surfaces, dose-response fits; png/pdf/svg/rds) comes from
// the R package (src/synergy_export.js).

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
