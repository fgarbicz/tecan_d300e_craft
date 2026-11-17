# probe-33: partly used T8+ cassette — predictions (written before the runs) and results (2026-11-17)

Question: can the fluid list make D300e leave heads 1–3 of a partly used T8+ cassette free? Generator: tools/cassette/make_probe33.mjs.

```
probe-33a-control.tdd T8+#1: h1=f1(4.9) h2=f2(4.9) h3=f3(4.9)
probe-33b-emptyfluids.tdd T8+#1: h1=f1(4.9) h2=f2(4.9) h3=f3(4.9)
probe-33c-dummy3.tdd T8+#1: h1=d1(2) h2=d2(2) h3=d3(2) h4=f1(4.9) h5=f2(4.9) h6=f3(4.9)
probe-33d-dummy3-7drugs.tdd T8+#1: h1=d1(2) h2=d2(2) h3=d3(2) h4=f1(4.9) h5=f2(4.9) h6=f3(4.9) h7=f4(4.9) h8=f5(4.9) | T8+#2: h1=f6(4.9) h2=f7(4.9)
```

Also to look for in the D300e UI: any setting or prompt for used / unavailable heads (Settings › Run, the Run dialog, cassette load and fill screens), and the fluid list's No Dispense column.

## probe-33e (written before its run): a two-head fluid pushed across the cassette end by skips
Run with: FILLED head 1, SKIP heads 2 and 3, then fill the rest. Unskipped plan (Craft): f1–f5 on heads 1–5,
g1 (36 µL) on heads 6–7 at 18 µL each (load 21.0). After the skips, cassette 1 has f1 h1, f2–f5 h4–7, one head left.
- H1 shift (also what re-planning g1's remaining 18 µL gives): g1 on cassette 1 head 8 (18 µL, 21.0) + cassette 2 head 1 (18 µL, 21.0).
- H2 move whole: cassette 1 head 8 left empty, g1 on cassette 2 heads 1–2 (18 + 18).
- H3 fill to the cap: g1 cassette 1 head 8 at 20 µL, cassette 2 head 1 at 16 µL.
Also tests that a skip can come after a filled head (not only "first N").

## Results (D300e Control 4.0.1, simulated, PC-workstation)
- No used-head setting anywhere (Settings, Run dropdown, cassette load screen). The fill screen has a per-head
  **SKIP** button, which answers the question; the dummy-fluid trick is unnecessary.
- 33a and 33d pre-run summaries matched the unskipped predictions above (3 heads / 10 heads, 2 cassettes; dummies 2.0 µL).
  33d's unskipped cassette 1 (d1–d3 heads 1–3, f1–f5 heads 4–8) was seen on the fill screen before skipping.
- 33a run with heads 1–3 skipped: f1–f3 on heads 4–6 (report).
- 33d run with heads 1–3 skipped: d1–d3, f1, f2 on cassette 1 heads 4–8; f3–f7 on cassette 2 heads 1–5 (report).
- 33e run with head 1 filled, heads 2–3 skipped: f1 h1, f2–f5 h4–7, g1 cassette 1 h8 + cassette 2 h1, 18 µL each,
  load 21.0 → **H1 (shift)**; H2 and H3 refuted.
- 33b and 33c were not run (files removed); "fluids with no wells take no head" rests on Craft's model only.
