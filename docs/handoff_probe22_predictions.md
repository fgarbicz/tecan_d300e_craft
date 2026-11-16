# probe-22 predictions (written 2026-11-15 before the runs)

Rule from the guide (p.109/112): a fluid with any well < 1 nL uses standard cassettes at 10 µL per head.
Open: how such a fluid is split when it needs > 2 heads, and when a D4+ takes part.

| Probe | H-seq (fill T8+ heads to 10 µL in well order, per plate, ≤ 8 heads, rest D4+) | H-equal (k = ⌈d/10⌉ equal T8+ heads) |
|---|---|---|
| 22a 35 µL, 1 plate | T8+ 10, 10, 10, 5 | T8+ 4 × 8.75 |
| 22b 100 µL, 1 plate | T8+ 8 × 10 + D4+ 20 | T8+ 10 × 10 (2 cassettes) |
| 22c 2 × 40 µL | T8+ 10,10,10,10 \| 10,10,10,10 | T8+ 8 × 10 |

## Results so far
- 22a (35 µL): 4 T8+ heads, EQUAL 4 × 8.75 (fill 10.4 µL each), no D4+. → H-equal.
- 22b (100 µL): 10 T8+ heads on 2 cassettes, no D4+.

## Added before running
- 22d: sub-nL u4 100 µL + bulk b1 100 µL (needs a D4+ head). Prediction (free-D4+ hypothesis): b1 on D4+;
  u4 fills 8 T8+ heads to 10 µL (one cassette) and the remaining 20 µL goes to a free D4+ head — instead of
  a second T8+ cassette. Alternative: u4 10 T8+ heads, b1 1 D4+.
- 22e: sub-nL u5 130 µL alone. Prediction: 13 T8+ heads (2 cassettes), no D4+.
- 22c (2 × 40 µL): 8 T8+ heads (1 cassette).
- 22d (u4 100 sub-nL + b1 100 bulk): u4 10 T8+ heads (2 cassettes), b1 1 D4+ → free-D4+ hypothesis REJECTED.
- 22e (130 µL): 13 T8+ heads (2 cassettes), no D4+.

## Added: what made z1 use a D4+?
- 22f: 2 plates × 65 µL sub-nL, no normalization. If a D4+ appears → multi-plate cassette-overflow rule.
- 22g: 130 µL sub-nL on one plate + 150 normalization wells (1000 nL, needs D4+). If a D4+ takes u7's
  overflow → normalization/class sharing.
- 22f (2 plates × 65, sub-nL well only on plate 1): 11 T8+ heads = plate 1 at 10 µL (7) + plate 2 at 20 µL (4)
  → the 10/20 µL mode is decided PER PLATE. Also: plate 2 needed 4 heads (> 2) but no D4+ was used.
- 22g (130 sub-nL + normalization on one plate): 13 T8+ + 1 D4+ (normalization only).

## Added
- 22h: 2 plates × 65, sub-nL on BOTH plates, + normalization (z1-like, but 4 µL wells). 22i: same, no norm.
- 22h (2 × 65 sub-nL both plates + norm): 13 T8+ heads (= ⌈130/10⌉, equal split across the plate boundary;
  per-plate packing would need 7 + 7) + D4+ for normalization.
- 22i not run (22h already shows normalization does not change u8's heads).

## Added
- 22j: sub-nL 140 µL on one plate (would need 14 T8+ heads like z1). Prediction: D4+ appears.
- 22j (140 µL sub-nL, one plate): 14 T8+ heads (2 cassettes), no D4+ → no head-count ceiling.

## Added
- 22l: probe-21 without normalization (z1 sweep on 2 plates). 22m: probe-21 plate 1 only, no normalization.
- 22l (probe-21 sweep, no norm): cassette 1 = plate 1 heads 10,10,10,10,10,10,5.45 (new head at plate 2) + head 8
  = first 10 µL of plate 2; cassette 2 = rest of plate 2 (no sub-nL wells left) 3 × 18.3 (20 µL cap, equal).
- 22h full run: cassette 1 = 8 × 10 continuous, head 7 spans plates (boundary at 4.975 µL); cassette 2 = 5 × 10.

## Added (predictions: "new head at a plate boundary only if the head is ≥ half full")
- 22n (plates 66 + 66): cassette 1 head 7 = 6.0 µL (load 7.2), head 8 = plate 2.
- 22o (plates 63 + 63): cassette 1 head 7 = 10 µL spanning plates (all 8 heads load 11.8).

## probe-24 (validation of the cassette rules; prediction from src/cassette.js at commit 2d2d1e8, before the run)
- T8+ cassette 1: d1 9.3, d2 9.3, d3 9.1, d4 22.6, d1 9.3, d2 9.3, d3 9.1, d4 22.6
- T8+ cassette 2: d1 9.3, d2 9.3, d3 9.1, d3 9.1
- D4+ cassette 3: DMSO normalization 234 ×4; D4+ cassette 4: 234 ×2
- pre-run summary: 12 T8+ heads (2 cassettes), 6 D4+ heads (2 cassettes)

### probe-24 result
- Dispense volumes: 3020/3020 rows match the engine (blind check of the top-up model).
- Cassettes: counts and d1/d4 heads as predicted; d2 (7.0, 11.8 | 9.0), d3 (7.5, 7.5 | 10.6, 10.6) and the D4+
  normalization (265, 104, 265, 265 | 254, 254) were NOT predicted. Rules revised from this run (fill plan with
  plate-boundary starts; D4+ planned from the plate its phase starts at; D4+ overflow re-planned) — so probe-24
  now fits by construction, and the revised rules still need a fresh blind run to count as validated.

## probe-25 (blind; prediction from src/cassette.js at commit 0f46f4e, before the run)
```
warn wells 0
e1 12.35 6.18 9.18 min well 0.100
e2 6.87 12.02 3.39 min well 0.060
e3 81.91 81.91 81.81 min well 504.800
DMSO normalization 192.96 193.99 0.00 min well 10.000
T8+ e1:11.8 e1:10.1 e2:8.2 e2:11.8 e2:6.5 e1:10.9
D4+ e3:117 e3:220 DMSO normalization:256 DMSO normalization:257
```

### probe-25 result
- T8+ cassette: all 6 heads exactly as predicted (blind) — the revised T8+ rules hold on unseen data.
- D4+: amounts right but order (e3 220 first) and one load (258 vs 257) differ → whole-plate D4+ packing in run
  order from the phase's start plate; D4+ load from the dispensed volume rounded to 0.1 µL first.
- "% of assay volume" top-up: 20 of 330 wells one step off and over-target wells sized wrong → new lagged model
  (src/dispense.js pctTopUp), 1076/1076 on D3 plate 9 + probe-25; all 1850 probe-25 rows now match.

## probe-26 (blind; prediction at commit a46d2a3, before the run)
```
warn wells 0
g1 52.41 81.18 30.42
g2 58.64 19.28 43.97
g3 17.65 5.79 11.76
DMSO normalization 216.93 0.00 259.47
D4+ g1:220 g2:167 DMSO normalization:214 DMSO normalization:214
D4+ DMSO normalization:214
T8+ g3:11.8 g3:9 g3:11.8 g3:9.1
```

### probe-26 result
- D4+ heads (g1 220, g2 167, normalization 3 × 213) as predicted except the normalization loads (214 predicted).
- T8+ g3 11.8, 11.8, 11.1, 7.0 vs predicted 11.8, 9.0, 11.8, 9.1 → every cassette phase plans its fluids from the
  plate the phase starts at (here plate 3, where the D4+ phase ended).
- Dispenses: 12 fluid rows off → (a) unnormalized wells are sized with the convergence check from the FIRST step
  (k < 0.001 → T = A; also fixes probe-22l E14), (b) fluid volumes round like .NET Math.Round on v/inc in doubles
  with no tie tolerance, and A·(1+p) is computed as A + A·p. All 1920 rows now match; probe-25 and D3 still exact.
- OPEN: D4+ load at exact .5 — probe-25 257.495 → 258, probe-26 213.499 → 213 (tests: todo).

## probe-27a / 27b (blind; prediction at commit 7c1212b + tools/cassette/make_probe27.mjs, before the runs, 2026-11-16)
Validates two rules fitted on one datapoint each: D4+ load at an exact .5 (whole-plate head: d to 0.1 µL first;
equal share: exact), and the "to total" fluid sizing step (|Vⱼ − Vⱼ₋₁| / Nⱼ₋₁ < 0.1 %).
```
== probe-27a-d4ties.tdd warn wells 0
D4+ h1:149.9600→203  h2:119.5800→165  h3:86.7800→124  h4:190.7600→254
D4+ e2:149.9600→202  e2:149.9600→202  e3:158.7960→213  e3:158.7960→213
D4+ e3:158.7960→213  m1:149.9600→203  m2:149.9600→203  DMSO normalization:149.9600→203
   ("exact d everywhere" would give 202, 164, 123, 253 | 202, 202, 213 ×3 | 202, 202, 202;
    "0.1 µL everywhere" 203, 165, 124, 254 | 203, 203, 214 ×3 | 203, 203, 203; m2 per-plate rounding → 202)
== probe-27b-totalstep.tdd warn wells 0
D4+ tt:41.0156→66  DMSO normalization:195.3576→259 ×3
T8+ DMSO normalization:20.0000→23.3
   dispense rows: engine as committed (totalTopUp with the previous-top-up sizing check)
```

### probe-27a / 27b results (2026-11-16)
- 27a: head counts and order as predicted (12 D4+ heads, 3 cassettes). Loads: 202, 164, 123, 253 | 202, 202, 213,
  213 | 213, 202, 202, 202 → the "d to 0.1 µL first" half of the prediction is REFUTED for every head kind (single
  plate, two plates, ToVolume normalization); D4+ loads use the exact head volume. probe-25 head 4 (258 for
  193.996 µL, a "% of assay volume" normalization head) is back to an open single case. 610/610 dispense rows.
- Pre-run summary of 27a shows the per-fluid total to 0.1 µL for fluids (202.4, 164.5, 123.5, 253.4, 404.9, 640.5,
  202.4, 202.4) and to 1 µL for normalization (202); the report's fluid totals are 202, 164, 123, 253, 405, 640.
- 27b: cassettes as predicted (D4+ tt 66, normalization 259 ×3; T8+ 23.3; summary: tt 66.3, normalization 801).
  Top-ups 924/924 (the N₁ → N₂ switch at |V₁ − V₀| / N₁ = 0.1 % holds at all three gaps). Fluids: 29 rows one step
  low → the "previous top-up" sizing check is REFUTED; D300e keeps V₁ in all 924 wells (k ≤ 0.001). New rule: the
  fluids are sized at T₁ unless the well total still changes by ≥ 0.1 % (|T₂ − T₁| / T₂), then T₂ — the same
  convergence check as for a well without normalization. 1848/1848; probe-23 plate 1 stays 664/664.

## probe-28 (Craft-generated: diluted stock "Bortezomib - 1:30" with RootFluidID / DilutionFactor + a <Randomize>
## map that shuffles wells within each cell line; prediction before the run, 2026-11-16)
```
T8+ Bortezomib:1.9454→2.5  MEN:1.3359→2  Bortezomib - 1:30:0.0376→2  DMSO normalization:16.8000→19.6
```
Expected: opens without a message, shows the diluted fluid, wells marked randomized; the report's Dispensed Well for
each Non-random Well equals the file's <Randomize> map (308 wells); every volume as the engine computes it.
