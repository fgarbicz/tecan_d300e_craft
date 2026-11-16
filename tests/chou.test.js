// Chou–Talalay: known-answer tests. The median-effect fit must recover m and Dm from exact data, and a
// combination built to be Loewe-additive (the definition of CI = 1) must give CI = 1; one built for a target
// CI must give that CI. Then the full analysis on the synthetic experiment, where the analytic CI is known.
import test from 'node:test';
import assert from 'node:assert/strict';
import { medianEffectFit, doseForEffect, effectAtDose, combinationIndex, ciClass, isobolePoints } from '../src/chou.js';
import { analyze, toWorkbook } from '../src/analysis.js';
import { buildSynthetic, fA, fB, IC_A, IC_B, S } from './helpers/synthetic_readout.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg ?? ''} ${a} vs ${b}`);
const A = { m: 1.3, Dm: 0.5 }, B = { m: 0.8, Dm: 20 };
const faOf = (p, d) => 1 / (1 + (p.Dm / d) ** p.m);
const dosesA = [0.05, 0.15, 0.5, 1.5, 5], dosesB = [1, 4, 16, 64, 256];

test('median-effect fit recovers m, Dm and r = 1 from exact data', () => {
  const f = medianEffectFit(dosesA.map((d) => ({ dose: d, fa: faOf(A, d) })));
  assert.ok(f.ok); close(f.m, 1.3, 1e-12); close(f.Dm, 0.5, 1e-12); close(f.r, 1, 1e-12);
  const inWin = dosesA.filter((d) => faOf(A, d) >= 0.1 && faOf(A, d) <= 0.9).length;
  assert.equal(inWin, 3); assert.equal(f.n, inWin); assert.equal(f.excluded, 5 - inWin);
  close(doseForEffect(f, 0.5), 0.5, 1e-12); close(effectAtDose(f, 0.5), 0.5, 1e-12);
  close(effectAtDose(f, doseForEffect(f, 0.83)), 0.83, 1e-12);
});

test('median-effect fit: unusable points are excluded and degenerate data refused', () => {
  const f = medianEffectFit([{ dose: 0, fa: 0 }, { dose: 1, fa: 0 }, { dose: 2, fa: 1 }, ...dosesA.map((d) => ({ dose: d, fa: faOf(A, d) }))]);
  assert.ok(f.ok); close(f.m, 1.3, 1e-12); assert.equal(f.fallback, false);
  assert.equal(f.excluded, 2 + dosesA.filter((d) => faOf(A, d) < 0.1 || faOf(A, d) > 0.9).length);
  // fewer than 2 doses inside 5–95 %: falls back to every 0 < fa < 1 point and says so
  const fb = medianEffectFit([{ dose: 1, fa: 0.02 }, { dose: 10, fa: 0.5 }, { dose: 100, fa: 0.98 }]);
  assert.ok(fb.ok); assert.equal(fb.fallback, true); assert.equal(fb.n, 3);
  assert.equal(medianEffectFit([{ dose: 1, fa: 0.3 }]).ok, false);
  assert.equal(medianEffectFit([{ dose: 1, fa: 0.3 }, { dose: 1, fa: 0.4 }]).ok, false); // one dose only
  const flat = medianEffectFit([{ dose: 1, fa: 0.5 }, { dose: 10, fa: 0.4 }]);
  assert.equal(flat.ok, false); assert.match(flat.reason, /slope/);
});

// effect of (dA, dB) when CI = target exactly: solve dA/DxA(f) + dB/DxB(f) = target for f (monotone in f)
function faForCI(fitA, fitB, dA, dB, target) {
  let lo = 1e-12, hi = 1 - 1e-12;
  for (let i = 0; i < 200; i++) {
    const f = (lo + hi) / 2, ci = dA / doseForEffect(fitA, f) + dB / doseForEffect(fitB, f);
    if (ci > target) lo = f; else hi = f; // CI falls as f rises
  }
  return (lo + hi) / 2;
}

test('positive controls: Loewe-additive combinations give CI = 1, synergistic ones the CI they were built with', () => {
  const fitA = medianEffectFit(dosesA.map((d) => ({ dose: d, fa: faOf(A, d) })));
  const fitB = medianEffectFit(dosesB.map((d) => ({ dose: d, fa: faOf(B, d) })));
  for (const target of [1, 0.3, 0.5, 2.5]) for (const dA of [0.05, 0.5, 2]) for (const dB of [1, 16, 100]) {
    const fa = faForCI(fitA, fitB, dA, dB, target);
    const r = combinationIndex(fitA, fitB, dA, dB, fa);
    close(r.ci, target, 1e-9, `CI ${dA} ${dB}`);
    close(r.xA + r.xB, r.ci, 1e-12);
    close(r.driA, r.dxA / dA, 1e-12);
  }
  assert.equal(combinationIndex(fitA, fitB, 1, 1, 0), null);
  assert.equal(combinationIndex(fitA, fitB, 1, 1, 1), null);
  assert.equal(combinationIndex({ ok: false }, fitB, 1, 1, 0.5), null);
  // extrapolation flag: Dx far outside the measured single-agent range
  assert.equal(combinationIndex(fitA, fitB, 0.5, 16, 0.5).extrapolated, false);
  assert.equal(combinationIndex(fitA, fitB, 0.5, 16, 0.999).extrapolated, true);
});

// Reader floor + noise, as on a plate without blank wells (the tour's simulated readout): Hill 1.4, IC50 4 nM,
// signal = v·(0.95 … 1.05) + 0.009, normalized to the vehicle (also + 0.009). The tour's 10 doses (nM), 50 noise seeds.
test('median-effect fit on Hill data with noise and a reader floor recovers m and Dm; the plateau is reported', () => {
  const doses = [0.1, 0.36, 1.29, 4.64, 16.7, 59.9, 215, 774, 2783, 10000];
  const v = (d) => 1 / (1 + (d / 4) ** 1.4);
  for (let s0 = 1; s0 <= 50; s0++) {
    let seed = s0 * 7919; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pts = doses.map((d) => ({ dose: d, fa: 1 - (v(d) * (0.95 + 0.1 * rnd()) + 0.009) / 1.009 }));
    const all = medianEffectFit(pts, { range: [Number.MIN_VALUE, 1 - Number.EPSILON / 2] });
    assert.ok(all.m < 1.1, `seed ${s0}, all points: m ${all.m}`); // positive control: the floor really flattens a CompuSyn-style fit
    const f = medianEffectFit(pts);
    assert.ok(Math.abs(f.m - 1.4) < 0.2, `seed ${s0}: m ${f.m}`);
    assert.ok(Math.abs(f.Dm / 4 - 1) < 0.15, `seed ${s0}: Dm ${f.Dm}`);
    assert.equal(f.fallback, false);
    assert.ok(f.plateau > 0.98, `seed ${s0}: plateau ${f.plateau}`);
  }
  assert.equal(medianEffectFit(dosesA.map((d) => ({ dose: d, fa: faOf(A, d) }))).plateau, null);
});

test('CI categories follow Chou 2006, Table 2', () => {
  const cases = [[0.05, 'very strong synergism'], [0.2, 'strong synergism'], [0.5, 'synergism'], [0.8, 'moderate synergism'], [0.88, 'slight synergism'],
    [1, 'nearly additive'], [1.15, 'slight antagonism'], [1.3, 'moderate antagonism'], [2, 'antagonism'], [5, 'strong antagonism'], [20, 'very strong antagonism']];
  for (const [ci, label] of cases) assert.equal(ciClass(ci).label, label, String(ci));
  assert.equal(ciClass(0.9).label, 'nearly additive'); assert.equal(ciClass(NaN), null);
});

test('isobole points: every crossing of the effect level, interpolated in log dose', () => {
  // additive surface of two identical drugs (m = 1, Dm = 1): fa = (a + b) / (1 + a + b); the 50 % isobole is a + b = 1
  const fa = (a, b) => (a + b) / (1 + a + b);
  const grid = [0, 0.25, 0.5, 1, 2];
  const pts = isobolePoints(grid, grid, fa, 0.5);
  assert.ok(pts.length >= 4);
  for (const [a, b] of pts) assert.ok(Math.abs(a + b - 1) < 0.2, `${a}+${b}`); // log interpolation of a smooth surface: close, not exact
  assert.ok(pts.some(([a, b]) => b === 0 && Math.abs(a - 1) < 1e-12)); // exactly on a grid dose
});

test('analysis: Chou–Talalay on the synthetic experiment matches the analytic CI', () => {
  const { protocol, meta } = buildSynthetic();
  const res = analyze({ protocol, meta });
  assert.equal(res.chou.length, 2); // 2 cell lines × 1 drug pair
  for (const p of res.chou) {
    // single agents follow the median-effect equation exactly: m = 1, Dm = IC50
    assert.ok(p.fitA.ok && p.fitB.ok);
    close(p.fitA.m, 1, 1e-9); close(p.fitA.Dm, IC_A, 1e-9); close(p.fitB.m, 1, 1e-9); close(p.fitB.Dm, IC_B, 1e-9);
    assert.equal(p.points.length, 9);
    for (const x of p.points) {
      // with m = 1, Dx = IC·fa/fu, so CI = (a' + b') / (fa/fu), a' = a/IC_A, b' = b/IC_B, fu = viability
      const fu = fA(x.concA) * fB(x.concB) * (p.cellLine === 'Line B' ? 1 - S : 1);
      const expected = (x.concA / IC_A + x.concB / IC_B) / (1 / fu - 1);
      close(x.ci, expected, 1e-9, `${p.cellLine} ${x.concA} ${x.concB}`);
      close(x.fa, 1 - fu, 1e-9);
    }
    assert.equal(p.summary.n + p.summary.extrapolated, 9);
  }
  // Bliss-independent drugs with m = 1 are synergistic by Loewe/CI (CI < 1), and the extra kill of line B lowers CI further
  const [la, lb] = ['Line A', 'Line B'].map((n) => res.chou.find((p) => p.cellLine === n));
  assert.ok(la.points.every((x) => x.ci < 1));
  assert.ok(lb.points.every((x, i) => x.ci < la.points[i].ci));
  assert.ok(lb.summary.geoMeanCI < la.summary.geoMeanCI);

  const wb = toWorkbook(res, protocol, meta, { appVersion: 'test', generatedAt: '2026-01-01T00:00:00Z' });
  const ci = wb.sheets.find((s) => s.name === 'Chou-Talalay CI'), fits = wb.sheets.find((s) => s.name === 'Median-effect fits');
  assert.equal(ci.rows.length, 18); assert.equal(fits.rows.length, 4);
  for (const r of ci.rows) assert.equal(r.length, ci.columns.length);
  assert.ok(ci.rows.every((r) => typeof r[8] === 'number' && r[9]));
  JSON.parse(JSON.stringify(wb));
});
