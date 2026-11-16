// Drives the browser version of the app through STEPS (steps.mjs).
//   node record.mjs shots  → docs/manual/shots/*.png + docs/manual/steps.json (HTML demo and PDF manual)
//   node record.mjs video  → docs/manual/tecan-d300-craft-tour.mp4 (cursor, highlight and captions burnt in)
// Needs the dev server (bin/serve.sh, http://127.0.0.1:8931/app/) and Google Chrome (CHROME_PATH to override).
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { STEPS } from './steps.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = process.env.MANUAL_OUT || join(ROOT, 'docs', 'manual');
const BASE = process.env.D300_URL || 'http://127.0.0.1:8931/app/';
const MODE = process.argv[2] || 'shots';
const VIEW = { width: 1440, height: 900 };
const WORK = process.env.MANUAL_WORK || join(ROOT, 'target', 'manual-work'); // frames, downloads (not in git)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readMs = (text) => Math.min(9000, Math.max(3200, text.split(/\s+/).length * 230)); // ~4 words/s, video only

// overlay for the video: a cursor that follows the real mouse, a highlight ring and a caption card.
// It is a manual popover so it sits in the top layer, above the wizard's modal dialog.
function installOverlay() {
  if (document.getElementById('tourOv')) return;
  const ov = document.createElement('div'); ov.id = 'tourOv'; ov.setAttribute('popover', 'manual');
  ov.innerHTML = `<style>
    #tourOv{position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;pointer-events:none;overflow:visible}
    #tourOv .ring{position:fixed;border:3px solid #ff7a1a;border-radius:9px;box-shadow:0 0 0 4000px rgba(10,20,40,.18),0 0 18px rgba(255,122,26,.7);transition:all .45s ease;opacity:0}
    #tourOv .cap{position:fixed;max-width:440px;background:#132036;color:#fff;font:15px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;padding:12px 16px 13px;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.35);transition:opacity .3s,left .45s,top .45s;opacity:0}
    #tourOv .cap b{display:block;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#ffb37a;margin-bottom:4px}
    #tourOv .cap .t{display:block;font-weight:600;font-size:17px;margin-bottom:4px}
    #tourOv .cur{position:fixed;width:22px;height:22px;margin:-3px 0 0 -3px;transition:none}
    #tourOv .cur svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}
    #tourOv .rip{position:fixed;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;border:3px solid #ff7a1a;animation:rip .6s ease-out forwards}
    @keyframes rip{from{transform:scale(.2);opacity:1}to{transform:scale(1.4);opacity:0}}
  </style><div class="ring"></div><div class="cap"></div>
  <div class="cur"><svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.3 L10 13 L16 13 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg></div>`;
  document.body.appendChild(ov); ov.showPopover();
  const cur = ov.querySelector('.cur');
  window.addEventListener('mousemove', (e) => { cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px'; }, true);
  window.__tour = {
    front() { ov.hidePopover(); ov.showPopover(); },
    show(box, chapter, title, text) {
      this.front();
      const ring = ov.querySelector('.ring'), cap = ov.querySelector('.cap');
      if (box) Object.assign(ring.style, { left: box.x - 6 + 'px', top: box.y - 6 + 'px', width: box.width + 12 + 'px', height: box.height + 12 + 'px', opacity: 1 });
      else ring.style.opacity = 0;
      cap.innerHTML = `<b>${chapter}</b><span class="t">${title}</span>${text}`;
      cap.style.opacity = 1;
      const W = innerWidth, H = innerHeight, cw = Math.min(440, cap.offsetWidth || 440), ch = cap.offsetHeight || 120;
      let x = 24, y = H - ch - 24;
      if (box) {
        const below = box.y + box.height + 18, above = box.y - ch - 18;
        y = below + ch < H - 8 ? below : above > 8 ? above : Math.min(H - ch - 16, Math.max(16, box.y));
        x = Math.min(W - cw - 16, Math.max(16, box.x + box.width / 2 - cw / 2));
        if (y === Math.min(H - ch - 16, Math.max(16, box.y))) x = box.x + box.width + 20 + cw < W ? box.x + box.width + 20 : Math.max(16, box.x - cw - 20); // beside a tall target
      }
      cap.style.left = x + 'px'; cap.style.top = y + 'px';
    },
    hide() { ov.querySelector('.ring').style.opacity = 0; ov.querySelector('.cap').style.opacity = 0; },
    ripple(x, y) { const r = document.createElement('div'); r.className = 'rip'; r.style.left = x + 'px'; r.style.top = y + 'px'; ov.appendChild(r); setTimeout(() => r.remove(), 700); },
  };
}

async function settle(page) { await page.waitForLoadState('networkidle').catch(() => {}); await sleep(450); }

async function boxOf(page, sel) {
  const el = await page.$(sel); if (!el) throw new Error(`target not found: ${sel}`);
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(150);
  const b = await el.boundingBox(); if (!b) throw new Error(`target not visible: ${sel}`);
  // clip to the viewport so a tall panel still gets a sensible ring
  const x = Math.max(0, b.x), y = Math.max(0, b.y);
  return { x, y, width: Math.min(VIEW.width, b.x + b.width) - x, height: Math.min(VIEW.height, b.y + b.height) - y };
}

async function main() {
  const browser = await chromium.launch({ channel: process.env.CHROME_PATH ? undefined : 'chrome', executablePath: process.env.CHROME_PATH, headless: true });
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: MODE === 'shots' ? 2 : 1, acceptDownloads: true, colorScheme: 'light', locale: 'en-US' });
  // no native save picker in headless Chrome: the app falls back to downloads
  await ctx.addInitScript(() => { try { delete window.showSaveFilePicker; window.showSaveFilePicker = undefined; } catch { /* */ } localStorage.clear(); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  page.on('dialog', (d) => d.dismiss());
  const dl = join(WORK, 'downloads'); rmSync(dl, { recursive: true, force: true }); mkdirSync(dl, { recursive: true });
  page.on('download', (d) => d.saveAs(join(dl, d.suggestedFilename())));
  await page.goto(BASE); await page.waitForSelector('#stWizard'); await settle(page);

  const shotsDir = join(WORK, 'shots'), webpDir = join(OUT, 'shots'); // PNG at 2× → WebP (2160 px wide) for the manual
  let frames = [], cdp = null, t0 = 0;
  if (MODE === 'shots') { for (const d of [shotsDir, webpDir]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); } }
  else {
    const fd = join(WORK, 'frames'); rmSync(fd, { recursive: true, force: true }); mkdirSync(fd, { recursive: true });
    cdp = await ctx.newCDPSession(page);
    cdp.on('Page.screencastFrame', async (f) => {
      const n = frames.length, file = join(fd, `f${String(n).padStart(5, '0')}.jpg`);
      writeFileSync(file, Buffer.from(f.data, 'base64')); frames.push({ file, t: f.metadata.timestamp });
      await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await page.evaluate(installOverlay);
    await page.mouse.move(VIEW.width / 2, VIEW.height / 2);
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 1 });
    t0 = Date.now(); await sleep(800);
  }

  const out = [];
  for (const [i, s] of STEPS.entries()) {
    const id = `${String(i + 1).padStart(2, '0')}`;
    const box = s.target ? await boxOf(page, s.target) : null;
    if (MODE === 'shots') {
      await page.mouse.move(2, VIEW.height - 2); await sleep(200); // no hover state in the stills
      await page.screenshot({ path: join(shotsDir, `${id}.png`) });
      out.push({ id, chapter: s.chapter, title: s.title, text: s.text, box, click: !!s.do });
    } else {
      await page.evaluate(installOverlay);
      const cx = box ? box.x + Math.min(box.width / 2, 60) : VIEW.width / 2, cy = box ? box.y + Math.min(box.height / 2, 18) : VIEW.height / 2;
      await page.mouse.move(cx, cy, { steps: 28 });
      await page.evaluate(([b, c, t, x]) => window.__tour.show(b, c, t, x), [box, s.chapter, s.title, s.text]);
      await sleep(readMs(s.text));
      if (s.do) await page.evaluate(([x, y]) => window.__tour.ripple(x, y), [cx, cy]);
      await sleep(250);
      await page.evaluate(() => window.__tour.hide());
    }
    if (s.do) await s.do(page);
    await settle(page);
    if (MODE === 'video') await page.evaluate(() => window.__tour?.front());
  }
  if (MODE === 'shots') {
    await page.mouse.move(2, VIEW.height - 2);
    await page.screenshot({ path: join(shotsDir, 'final.png') });
    for (const f of [...out.map((s) => s.id), 'final']) execFileSync('cwebp', ['-quiet', '-q', '85', '-m', '6', '-sharp_yuv', '-resize', '2160', '0', join(shotsDir, `${f}.png`), '-o', join(webpDir, `${f}.webp`)]);
    writeFileSync(join(OUT, 'steps.json'), JSON.stringify({ view: VIEW, steps: out }, null, 1));
    console.log(`${out.length} steps → ${webpDir}`);
  } else {
    await sleep(2500);
    await cdp.send('Page.stopScreencast');
    await sleep(300);
    // frames arrive only when the screen changes: give each frame the time until the next one
    const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, ((frames[i + 1]?.t ?? f.t + 2) - f.t)).toFixed(4)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
    const lf = join(WORK, 'frames.txt'); writeFileSync(lf, list);
    const mp4 = join(OUT, 'tecan-d300-craft-tour.mp4');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lf, '-vf', 'fps=30,scale=1440:900:flags=lanczos,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-tune', 'stillimage', '-movflags', '+faststart', mp4]);
    console.log(`${frames.length} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s → ${mp4}`);
  }
  if (errors.length) { console.error('page errors:\n' + errors.join('\n')); process.exitCode = 1; }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
