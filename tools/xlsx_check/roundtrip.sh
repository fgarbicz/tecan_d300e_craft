#!/bin/bash
# Excel export round-trip: JS toWorkbook() JSON → Rust writer (crates/d300-app/src/xlsx.rs) → .xlsx →
# openpyxl read-back, compared cell by cell. Includes a positive control (a tampered expectation must fail).
# Needs node, cargo and python3 with openpyxl; skips loudly (exit 3) when openpyxl is missing.
set -euo pipefail
ROOT="${PROJECT_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
OUT="${1:-$(mktemp -d "${TMPDIR:-/tmp}/d300-xlsx.XXXXXX")}"
mkdir -p "$OUT"
if ! python3 -c "import openpyxl" 2>/dev/null; then echo "SKIPPED: python3 openpyxl not available"; exit 3; fi
cd "$ROOT"
node tools/xlsx_check/dump_workbook.mjs "$OUT/workbook.json"
D300_XLSX_JSON="$OUT/workbook.json" D300_XLSX_OUT="$OUT/workbook.xlsx" \
  cargo test -q -p d300-designer xlsx_from_json_env -- --exact tests::xlsx_from_json_env >/dev/null
[ -s "$OUT/workbook.xlsx" ] || { echo "FAIL: the Rust writer produced no file"; exit 1; }
python3 tools/xlsx_check/compare.py "$OUT/workbook.json" "$OUT/workbook.xlsx"
if python3 tools/xlsx_check/compare.py "$OUT/workbook.json" "$OUT/workbook.xlsx" --tamper >/dev/null; then
  echo "FAIL: positive control — the comparison did not notice a changed value"; exit 1
fi
echo "positive control OK (tampered value detected); files in $OUT"
