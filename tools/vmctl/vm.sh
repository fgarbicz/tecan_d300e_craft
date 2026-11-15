#!/usr/bin/env bash
# Drive the Windows VM window in VMware Fusion from the Mac (screenshots of that window only).
#   vm.sh shot [out.png]      capture only the VM window (scaled to 1100 px wide)
#   vm.sh click X Y [double]  click at image coordinates of the last 1100-px shot
#   vm.sh key "text"          type text into the VM
#   vm.sh keycode N [mods]    press a key code (e.g. 36 = Return), mods like "command down"
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${VMCTL_DIR:-${TMPDIR:-/tmp}/vmctl}"; mkdir -p "$OUT_DIR"
WIN_TITLE="${VM_WINDOW:-Windows 11 64-bit Arm}"
front() { osascript -e "tell application \"System Events\" to tell process \"VMware Fusion\" to set frontmost to true" -e "tell application \"System Events\" to tell process \"VMware Fusion\" to perform action \"AXRaise\" of window \"$WIN_TITLE\"" >/dev/null; sleep 0.3; }
geom() { osascript -e "tell application \"System Events\" to tell process \"VMware Fusion\" to get {position, size} of window \"$WIN_TITLE\"" | tr -d ' '; }
winid() { swift "$DIR/winid.swift" "$WIN_TITLE"; }
case "$1" in
  shot) out="${2:-$OUT_DIR/vm.png}"; screencapture -x -o -l "$(winid)" "$OUT_DIR/raw.png"; sips -Z 1100 "$OUT_DIR/raw.png" --out "$out" >/dev/null; echo "$out";;
  click) IFS=, read -r x y w h <<<"$(geom)"; f=$(python3 -c "print($w/1100)");
         X=$(python3 -c "print($x + $2*$f)"); Y=$(python3 -c "print($y + $3*$f)"); front; swift "$DIR/click.swift" "$X" "$Y" "${4:-}";;
  key) front; osascript -e "tell application \"System Events\" to keystroke \"$2\"";;
  keycode) front; if [ -n "${3:-}" ]; then osascript -e "tell application \"System Events\" to key code $2 using {$3}"; else osascript -e "tell application \"System Events\" to key code $2"; fi;;
  *) echo "unknown command"; exit 2;;
esac
