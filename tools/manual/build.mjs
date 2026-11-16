// Builds docs/manual/demo.html (interactive tour), docs/manual/manual.html and
// docs/manual/tecan-d300-craft-manual.pdf from docs/manual/steps.json + shots (made by `node record.mjs shots`).
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = process.env.MANUAL_OUT || join(ROOT, 'docs', 'manual');
const { view, steps } = JSON.parse(readFileSync(join(OUT, 'steps.json'), 'utf8'));
const version = JSON.parse(readFileSync(join(ROOT, 'crates', 'd300-app', 'tauri.conf.json'), 'utf8')).version;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---- demo ----
const demo = readFileSync(join(HERE, 'demo.template.html'), 'utf8')
  .replace('/*STEPS*/null', JSON.stringify({ view, steps }).replace(/</g, '\\u003c'))
  .replace('__N__', String(steps.length));
writeFileSync(join(OUT, 'demo.html'), demo);

// ---- manual ----
const pct = (b) => ({ l: (b.x / view.width) * 100, t: (b.y / view.height) * 100, w: (b.width / view.width) * 100, h: (b.height / view.height) * 100 });
let html = '<h2 class="chapter">4. Guided tour: one experiment, start to finish</h2>\n'
  + '<p>Bortezomib × Venetoclax on two myeloma cell lines (MM.1S, KMS-11), 384-well plates, 50 µL per well, 2 replicate plates, randomized within each cell line. Each orange frame marks what the step is about. The plate-reader values in the Results part are simulated.</p>\n';
let chapter = null, n = 0;
for (const s of steps) {
  if (s.chapter !== chapter) { chapter = s.chapter; html += `<h3>${esc(chapter)}</h3>\n`; }
  n++;
  const fig = s.title === 'Next' || !s.box ? '' : (() => {
    const p = pct(s.box);
    return `<div class="shot"><img src="shots/${s.id}.webp" alt="${esc(s.title)}"><div class="ring" style="left:calc(${p.l}% - 3px);top:calc(${p.t}% - 3px);width:calc(${p.w}% + 6px);height:calc(${p.h}% + 6px)"></div><span class="tag" style="left:${Math.max(1.5, p.l)}%;top:${Math.max(2.5, p.t)}%">${n}</span></div>`;
  })();
  html += `<div class="step"><h4><span class="n">${n}</span>${esc(s.title)}</h4><p>${esc(s.text)}</p>${fig}</div>\n`;
}
const date = new Date().toISOString().slice(0, 10);
const manual = readFileSync(join(HERE, 'manual.template.html'), 'utf8')
  .replace('{{WALKTHROUGH}}', html).replaceAll('{{VERSION}}', version).replaceAll('{{DATE}}', date);
writeFileSync(join(OUT, 'manual.html'), manual);

// ---- PDF (Chrome's print engine) ----
// Chrome re-encodes WebP for print (a 39 MB PDF) but embeds JPEG as it is: print from a copy that uses JPEGs.
const WORK = process.env.MANUAL_WORK || join(ROOT, 'target', 'manual-work');
const jdir = join(WORK, 'pdf', 'shots'); mkdirSync(jdir, { recursive: true });
for (const f of readdirSync(join(OUT, 'shots')).filter((x) => x.endsWith('.webp')))
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(OUT, 'shots', f), '-vf', 'scale=1800:-1:flags=lanczos', '-q:v', '3', join(jdir, f.replace('.webp', '.jpg'))]);
writeFileSync(join(WORK, 'pdf', 'manual.html'), manual.replace(/shots\/(\w+)\.webp/g, 'shots/$1.jpg'));
const browser = await chromium.launch({ channel: process.env.CHROME_PATH ? undefined : 'chrome', executablePath: process.env.CHROME_PATH, headless: true });
const page = await browser.newPage();
await page.emulateMedia({ media: 'print', colorScheme: 'light' });
await page.goto(pathToFileURL(join(WORK, 'pdf', 'manual.html')).href, { waitUntil: 'networkidle' });
await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
await page.pdf({
  path: join(OUT, 'tecan-d300-craft-manual.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true,
  displayHeaderFooter: true, headerTemplate: '<span></span>',
  footerTemplate: `<div style="font:8px Helvetica,Arial,sans-serif;color:#777;width:100%;padding:0 15mm;display:flex;justify-content:space-between"><span>Tecan D300 Craft ${version} — user manual</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
});
await browser.close();
console.log(`demo.html, manual.html, tecan-d300-craft-manual.pdf (${version}) → ${OUT}`);
