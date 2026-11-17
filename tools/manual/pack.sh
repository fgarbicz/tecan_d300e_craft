#!/usr/bin/env bash
# Builds the offline manual pack for a release: tecan-d300-craft-manual-pack.zip in target/manual-pack/
# (PDF, video, interactive tour with its screenshots, README.txt). Run after `node build.mjs`.
set -euo pipefail
cd "$(dirname "$0")/../.."
VERSION=$(python3 -I -c 'import json;print(json.load(open("crates/d300-app/tauri.conf.json"))["version"])')
OUT=target/manual-pack; D=$OUT/tecan-d300-craft-manual
rm -rf "$OUT"; mkdir -p "$D/shots"
cp docs/manual/tecan-d300-craft-manual.pdf docs/manual/tecan-d300-craft-tour.mp4 "$D/"
cp docs/manual/demo.html "$D/interactive-tour.html"
cp docs/manual/shots/*.webp "$D/shots/"
cat > "$D/README.txt" <<TXT
Tecan D300 Craft $VERSION - manual pack

  interactive-tour.html        guided tour of one experiment, start to finish. Double-click to open it
                               in any browser. Arrow keys / space step through it; the play button runs it.
  tecan-d300-craft-tour.mp4    the same tour as a captioned video (about 4 minutes)
  tecan-d300-craft-manual.pdf  the user manual: installing, the wizard, editing, the run plan (incl. reusing a
                               partly used cassette), results incl. Chou–Talalay, what has been checked against
                               D300e Control, troubleshooting

Keep the "shots" folder next to interactive-tour.html: the tour's pictures are in it.
Always open a protocol in D300e Control and check it before dispensing.
TXT
(cd "$OUT" && zip -qr -X tecan-d300-craft-manual-pack.zip tecan-d300-craft-manual)
echo "$OUT/tecan-d300-craft-manual-pack.zip"
