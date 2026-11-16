// Chou–Talalay median-effect analysis and combination index (CI).
//   Chou TC, Talalay P. Adv Enzyme Regul 1984;22:27–55.  Chou TC. Pharmacol Rev 2006;58:621–681.
//
// Median-effect equation, per drug:  fa / fu = (D / Dm)^m   (fa = fraction affected, fu = 1 − fa)
//   linearized: log(fa/fu) = m·log D − m·log Dm  → least-squares fit gives m (shape), Dm (IC50-like
//   median-effect dose) and r (linear correlation; Chou asks for r ≥ 0.90 for cell-based data).
// Dose of one drug alone that gives effect fa:  Dx = Dm · (fa / (1 − fa))^(1/m)
// Combination index of a combination (d1, d2) that gives effect fa (mutually exclusive, classic form,
// used by CompuSyn for both constant- and non-constant-ratio combinations):
//   CI = d1/(Dx)1 + d2/(Dx)2      CI < 1 synergism, = 1 additive, > 1 antagonism
// Dose-reduction index: DRI = (Dx) / d  — how many-fold the dose of each drug can be reduced in the
// combination for the same effect.
// Normalized isobologram: the point (d1/(Dx)1, d2/(Dx)2); the additive line joins (1,0) and (0,1).

const log10 = Math.log10;

// Effects used for the fit (CompuSyn uses every 0 < fa < 1). Outside 10–90 % the median-effect line is dominated
// by measurement limits: near 0 by noise (with 5 % well-to-well noise an inactive dose reads as fa ≈ 0.05, and
// log(fa/fu) of 0.005 vs 0.05 differ by a decade), near 1 by the reader floor / unsubtracted background, which caps
// fa and flattens the slope. Hill 1.4, IC50 4 nM, the tour's 10 doses, 5 % noise and a 0.9 % floor, 50 seeds
// (tests/chou.test.js): all points m 0.70–1.08; window 5–95 % m 0.93–1.50; window 10–90 % m 1.26–1.50, Dm 3.7–4.5 nM.
export const FIT_FA_RANGE = [0.1, 0.9]; // was [0.05, 0.95]: one noisy inactive dose inside it flattened m to 0.93

/**
 * Fit the median-effect equation to single-drug points.
 * @param {{dose:number, fa:number}[]} points  dose > 0. Points with fa in FIT_FA_RANGE (10–90 %) are used; when fewer than
 *   2 doses fall in it, all points with 0 < fa < 1 are used instead (fallback: true; the fit is then less reliable).
 * @returns {{ok:true, m, Dm, r, n, excluded, fallback, plateau, doseMin, doseMax, faMin, faMax} | {ok:false, reason, n, excluded}}
 *   excluded: points left out (outside the window, or fa ≤ 0 / ≥ 1). plateau: the effect the highest doses share
 *   when they no longer rise (≥ 2 doses within 0.02 at fa ≥ 0.9) — usually a floor: mark blank wells.
 */
export function medianEffectFit(points, { range = FIT_FA_RANGE } = {}) {
  const all = points.filter((p) => Number.isFinite(p.dose) && p.dose > 0 && Number.isFinite(p.fa));
  const inOpen = all.filter((p) => p.fa > 0 && p.fa < 1);
  const inWin = all.filter((p) => p.fa >= range[0] && p.fa <= range[1]);
  const fallback = new Set(inWin.map((p) => p.dose)).size < 2;
  const use = fallback ? inOpen : inWin;
  const excluded = all.length - use.length;
  const byDose = [...all].sort((a, b) => b.dose - a.dose);
  let plateau = null;
  if (byDose.length >= 2 && byDose[0].fa >= 0.9 && Math.abs(byDose[0].fa - byDose[1].fa) <= 0.02) plateau = (byDose[0].fa + byDose[1].fa) / 2;
  if (new Set(use.map((p) => p.dose)).size < 2) return { ok: false, reason: 'fewer than 2 doses with 0 < effect < 1', n: use.length, excluded, plateau };
  const x = use.map((p) => log10(p.dose)), y = use.map((p) => log10(p.fa / (1 - p.fa)));
  const n = use.length, mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  const m = sxy / sxx, b = my - m * mx;
  const r = syy > 0 ? sxy / Math.sqrt(sxx * syy) : 1;
  if (!(m > 0)) return { ok: false, reason: 'no dose–response (median-effect slope m ≤ 0)', n, excluded, plateau, m, r };
  return {
    ok: true, m, Dm: 10 ** (-b / m), r, n, excluded, fallback, plateau,
    doseMin: Math.min(...use.map((p) => p.dose)), doseMax: Math.max(...use.map((p) => p.dose)),
    faMin: Math.min(...use.map((p) => p.fa)), faMax: Math.max(...use.map((p) => p.fa)),
  };
}

/** Dose of the drug alone that gives effect fa (0 < fa < 1). */
export const doseForEffect = (fit, fa) => fit.Dm * (fa / (1 - fa)) ** (1 / fit.m);

/** Effect of the drug alone at dose d. */
export const effectAtDose = (fit, d) => (d > 0 ? 1 / (1 + (fit.Dm / d) ** fit.m) : 0);

/**
 * CI of the combination (dA, dB) that produced effect fa. null when fa is not in (0, 1) or a fit failed.
 * extrapolated: (Dx) of a drug lies outside the dose range its own fit was measured over.
 */
export function combinationIndex(fitA, fitB, dA, dB, fa) {
  if (!fitA?.ok || !fitB?.ok || !(fa > 0 && fa < 1)) return null;
  const dxA = doseForEffect(fitA, fa), dxB = doseForEffect(fitB, fa);
  const xA = dA / dxA, xB = dB / dxB;
  const out = (fit, dx) => dx < fit.doseMin / 1.0001 || dx > fit.doseMax * 1.0001;
  return {
    ci: xA + xB, xA, xB, dxA, dxB,
    driA: dA > 0 ? dxA / dA : null, driB: dB > 0 ? dxB / dB : null,
    extrapolated: out(fitA, dxA) || out(fitB, dxB),
  };
}

// Chou 2006, Table 2: symbols and descriptions of synergism / antagonism by CI range.
export const CI_CLASSES = [
  { max: 0.1, symbol: '+++++', label: 'very strong synergism' },
  { max: 0.3, symbol: '++++', label: 'strong synergism' },
  { max: 0.7, symbol: '+++', label: 'synergism' },
  { max: 0.85, symbol: '++', label: 'moderate synergism' },
  { max: 0.9, symbol: '+', label: 'slight synergism' },
  { max: 1.1, symbol: '±', label: 'nearly additive' },
  { max: 1.2, symbol: '−', label: 'slight antagonism' },
  { max: 1.45, symbol: '−−', label: 'moderate antagonism' },
  { max: 3.3, symbol: '−−−', label: 'antagonism' },
  { max: 10, symbol: '−−−−', label: 'strong antagonism' },
  { max: Infinity, symbol: '−−−−−', label: 'very strong antagonism' },
];
export function ciClass(ci) {
  if (!Number.isFinite(ci)) return null;
  return CI_CLASSES.find((c) => ci < c.max) || CI_CLASSES[CI_CLASSES.length - 1];
}

/**
 * Points of the observed iso-effect curve (isobole) at effect `level`, from a dose matrix:
 * along every row and column the effect is interpolated between neighbouring doses (log dose between
 * two non-zero doses, linear from dose 0), and every crossing of `level` gives a point (dA, dB).
 * @param a ascending doses of A (with 0), b ascending doses of B (with 0), faAt(da, db) → fa or null.
 */
export function isobolePoints(a, b, faAt, level) {
  const pts = [];
  const cross = (d0, d1, f0, f1) => {
    if (f0 == null || f1 == null || f0 === f1 || (f0 - level) * (f1 - level) > 0 || f0 === level && f1 === level) return null;
    const t = (level - f0) / (f1 - f0);
    if (t < 0 || t > 1) return null;
    return d0 > 0 ? 10 ** (log10(d0) + t * (log10(d1) - log10(d0))) : d0 + t * (d1 - d0);
  };
  for (const db of b) for (let i = 0; i + 1 < a.length; i++) {
    const d = cross(a[i], a[i + 1], faAt(a[i], db), faAt(a[i + 1], db));
    if (d != null) pts.push([d, db]);
  }
  for (const da of a) for (let j = 0; j + 1 < b.length; j++) {
    const d = cross(b[j], b[j + 1], faAt(da, b[j]), faAt(da, b[j + 1]));
    if (d != null) pts.push([da, d]);
  }
  // one point per location; order along the curve (from the A axis to the B axis)
  const seen = new Set(), out = [];
  for (const p of pts) { const k = p.map((v) => v.toPrecision(8)).join(','); if (!seen.has(k)) { seen.add(k); out.push(p); } }
  return out;
}
