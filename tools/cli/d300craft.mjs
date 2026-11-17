#!/usr/bin/env node
// Tecan D300 Craft command line — the programmable side of the app (used by Claude; see
// .claude/skills/d300-plate-design/SKILL.md).
//
//   d300craft example                         print an example spec (JSON)
//   d300craft design <spec.json> [--out DIR] [--name BASE]
//                                             write BASE.tdd (D300e), BASE.craft.json (experiment file),
//                                             BASE_plan.md and BASE_plan.json; print the plan
//   d300craft plan <file.tdd> [--spec spec.json] [--json]
//                                             plan for an existing protocol (+ its .craft.json if present)
//   d300craft check <file.tdd>                warnings only; exit status 1 if there are any
//   d300craft dosemap <file.tdd> [--out FILE.svg]
//                                             colour map of every drug's concentration gradient (SVG)
//
// Exit status: 0 ok, 1 warnings (check) , 2 bad input.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = (m) => import(join(here, '..', '..', 'src', m));
const { designAndPlan, makePlan, planMarkdown } = await src('design.js');
const { parseTdd } = await src('tdd.js');
const { parseMeta, reconcileMeta, sidecarName, wellRole } = await src('experiment.js');
const { doseMapSvg, doseSummary, scrapTest } = await src('dosemap.js');
const { cassetteSvg, fluidLook, standalone } = await src('draw.js');
const { planRun } = await src('cassette.js');
const { computeProtocol } = await src('dispense.js');
const { unitOfFn } = await src('units.js');

const EXAMPLE = {
  name: 'MM synergy example',
  plate: { type: '384', wellVolumeUL: 50, dmsoLimitPct: 1, border: 1, replicates: 3, scrap: true, shake: false },
  drugs: [
    { name: 'Bortezomib', stock: '1 mM', class: 'DMSO', mw: 384.24 },
    { name: 'MEN', stock: '10 mM', class: 'DMSO' },
  ],
  design: {
    primary: { drug: 'Bortezomib', top: '0.02 µM', dilution: '1:1.4', levels: 10, replicates: 2, zero: true },
    partners: [{ drug: 'MEN', top: '3 µM', dilution: '1:2', levels: 6, replicates: 2, zero: true, normalize: 'block' }],
  },
  cells: { lines: ['MM.1S'], arrangement: 'same', cellsPerWell: 2000, seedingVolumeUL: 50, overagePct: 15 },
  pbsVolumeUL: 50,
};

function args(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); opt[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; } else pos.push(a); }
  return { pos, opt };
}
const die = (msg) => { process.stderr.write(`d300craft: ${msg}\n`); process.exit(2); };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { die(`cannot read ${p}: ${e.message}`); } };

function loadProtocol(file) {
  let protocol;
  try { protocol = parseTdd(readFileSync(file, 'utf8')); } catch (e) { die(`cannot read ${file}: ${e.message}`); }
  const side = join(dirname(file), sidecarName(basename(file)));
  let meta = reconcileMeta(null, protocol), note = '';
  if (existsSync(side)) { try { const r = parseMeta(readFileSync(side, 'utf8'), protocol); meta = r.meta; if (r.stale) note = 'experiment file is older than the protocol (fingerprint differs)'; } catch (e) { note = `experiment file ignored: ${e.message}`; } }
  return { protocol, meta, note };
}

const { pos, opt } = args(process.argv.slice(2));
const cmd = pos[0];
if (!cmd || cmd === 'help' || opt.help) { process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 15).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n'); process.exit(0); }
if (cmd === 'example') { process.stdout.write(JSON.stringify(EXAMPLE, null, 2) + '\n'); process.exit(0); }

if (cmd === 'design') {
  if (!pos[1]) die('design needs a spec file (see: d300craft example)');
  const spec = readJson(pos[1]);
  const base = (opt.name || spec.name || basename(pos[1], '.json')).replace(/[^\w.\-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const out = resolve(opt.out || '.');
  mkdirSync(out, { recursive: true });
  let r; try { r = designAndPlan(spec, base); } catch (e) { die(e.message); }
  const files = [`${base}.tdd`, `${base}.craft.json`, `${base}_plan.md`, `${base}_plan.json`, `${base}_dosemap.svg`, `${base}_loading.svg`].map((f) => join(out, f));
  for (const f of files.slice(0, 2)) if (existsSync(f) && !opt.force) die(`${f} exists (use --force to overwrite)`);
  writeFileSync(files[0], r.tdd);
  writeFileSync(files[1], r.sidecar);
  writeFileSync(files[4], doseMapSvg(r.protocol, { title: `${base} — dose map`, roleOf: (pi, rr, c) => wellRole(r.meta, r.protocol.plates[pi], pi, rr, c), unitOf: unitOfFn(r.meta, r.protocol) }));
  // the loading sheet as a drawing: every cassette with its heads, colour = solution, bold = volume to pipette
  writeFileSync(files[5], standalone(cassetteSvg(planRun(r.protocol, computeProtocol(r.protocol), { usedT8Heads: r.meta.settings.usedT8Heads }).cassettes, (h) => fluidLook(r.protocol, h.fluidId, h.classId === 0), { title: `${base} — what to pipette into each dispense head` })));
  const md = planMarkdown(r.plan, { files: [files[0], files[1], files[4], files[5]] });
  writeFileSync(files[2], md);
  writeFileSync(files[3], JSON.stringify(r.plan, null, 2) + '\n');
  process.stdout.write(opt.json ? JSON.stringify({ files, plan: r.plan }, null, 2) + '\n' : md + '\n');
  process.exit(0);
}

if (cmd === 'plan' || cmd === 'check') {
  if (!pos[1]) die(`${cmd} needs a .tdd file`);
  const { protocol, meta, note } = loadProtocol(pos[1]);
  const spec = opt.spec ? readJson(opt.spec) : {};
  const plan = makePlan(protocol, meta, spec);
  if (note) process.stderr.write(`note: ${note}\n`);
  if (cmd === 'check') {
    const n = plan.warnings.reduce((s, w) => s + w.count, 0) + plan.priming.length;
    process.stdout.write(n ? JSON.stringify({ warnings: plan.warnings, priming: plan.priming }, null, 2) + '\n' : 'ok: no warnings\n');
    process.exit(n ? 1 : 0);
  }
  process.stdout.write(opt.json ? JSON.stringify(plan, null, 2) + '\n' : planMarkdown(plan) + '\n');
  process.exit(0);
}
if (cmd === 'dosemap') {
  if (!pos[1]) die('dosemap needs a .tdd file');
  const { protocol, meta, note } = loadProtocol(pos[1]);
  if (note) process.stderr.write(`note: ${note}\n`);
  const out = resolve(opt.out || pos[1].replace(/\.tdd$/i, '') + '_dosemap.svg');
  const name = basename(pos[1]).replace(/\.tdd$/i, '');
  writeFileSync(out, doseMapSvg(protocol, { title: `${name} — dose map`, roleOf: meta ? (pi, r, c) => wellRole(meta, protocol.plates[pi], pi, r, c) : null }));
  process.stdout.write(doseSummary(protocol, { skip: scrapTest(protocol, meta, wellRole) }).join('\n') + `\nwrote ${out}\n`);
  process.exit(0);
}
die(`unknown command "${cmd}" (design, plan, check, dosemap, example)`);
