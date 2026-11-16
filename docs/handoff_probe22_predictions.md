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
