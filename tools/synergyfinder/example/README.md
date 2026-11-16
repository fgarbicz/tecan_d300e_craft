# SynergyFinder example (synthetic)

Generated packages land here and are gitignored; only this README is committed. Regenerate and run:

```sh
tools/synergyfinder/run_example.sh all        # or: replicated | single | mixed
```

`make_example.mjs` builds the synthetic screen of `tests/helpers/synthetic_synergy.js`: Bortezomib × MEN is
synergistic by construction (combination viability × (1 − 0.4)) and Bortezomib × IDOTDO is Bliss-independent,
each in two cell lines (4 blocks, 6 × 6 doses). `synergyPackage()` writes it out and `analysis.R` runs in the
conda env `synergyfinder` (../environment.yml), started from `/` to check the script finds its data on its own.
`run_example.sh` fails when Rscript fails or when any figure in `results/figure_manifest.csv` is not "ok",
missing or empty.

Variants: `replicated` (8 wells per dose pair), `single` (1 well per dose pair), `mixed` (Line A replicated,
Line B single).

Result of 2026-11-15 (synergyfinder 3.18.0, R 4.5.3, osx-arm64), mean score over the dose matrix:

| Block | ZIP | HSA | Bliss | Loewe |
|---|---|---|---|---|
| Line A: Bortezomib × MEN (synergistic) | 9.30 | 17.40 | 9.30 | 13.06 |
| Line A: Bortezomib × IDOTDO (independent) | −0.04 | 8.07 | −0.03 | 3.77 |
| Line B: Bortezomib × MEN (synergistic) | 15.54 | 22.86 | 15.57 | 18.69 |
| Line B: Bortezomib × IDOTDO (independent) | −0.04 | 7.41 | −0.04 | 2.95 |

(replicated variant; the app's own Bliss excess, mean over the 25 combinations × 100: 9.33, 0.00, 15.61, 0.00.)
HSA and Loewe are positive for an independent pair by construction of those models.
