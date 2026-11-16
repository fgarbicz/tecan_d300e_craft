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
