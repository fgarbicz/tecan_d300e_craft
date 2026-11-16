#!/usr/bin/env bash
# Regenerate the synthetic SynergyFinder example(s) and run analysis.R in the conda env "synergyfinder".
#   tools/synergyfinder/run_example.sh [replicated|single|mixed|all]     (default: replicated)
# Exits non-zero when the R script fails, or when a figure listed in results/figure_manifest.csv is not
# "ok", or when an expected figure file is missing or empty.
# Env: CONDA (conda/mamba executable, default: conda on PATH, else ~/miniforge3/bin/conda),
#      SF_ENV (environment name, default synergyfinder).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
CONDA="${CONDA:-$(command -v conda || echo "$HOME/miniforge3/bin/conda")}"
SF_ENV="${SF_ENV:-synergyfinder}"
variants=("${1:-replicated}")
[ "${variants[0]}" = all ] && variants=(replicated single mixed)

status=0
for v in "${variants[@]}"; do
  out="$here/example/$v"
  (cd "$repo" && node tools/synergyfinder/make_example.mjs --variant "$v" --out "$out")
  # run from another working directory: the script must find its data relative to itself
  (cd / && "$CONDA" run -n "$SF_ENV" Rscript "$out/analysis.R") > "$out/run.log" 2>&1 || { echo "$v: Rscript FAILED (see $out/run.log)"; tail -20 "$out/run.log"; status=1; continue; }
  # every manifest row ok, every file present and non-empty
  bad=$(awk -F, 'NR>1 && $5 != "\"ok\"" {print}' "$out/results/figure_manifest.csv")
  [ -n "$bad" ] && { echo "$v: figures not ok:"; echo "$bad"; status=1; }
  n=0; missing=0
  while IFS= read -r f; do
    n=$((n+1)); [ -s "$out/$f" ] || { echo "$v: missing or empty: $f"; missing=1; }
  done < <(awk -F, 'NR>1 {gsub(/"/,"",$4); print $4}' "$out/results/figure_manifest.csv")
  [ "$missing" = 0 ] || status=1
  echo "$v: $n figure files checked"
  sed -n '/^Synergy scores/,/^Figures:/p' "$out/run.log"
done
exit $status
