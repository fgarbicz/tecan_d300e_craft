"""Read an .xlsx written by the Rust writer back with openpyxl and compare every cell with the
workbook JSON it was written from. Exit 0 when identical, 1 on any difference.

Usage: python3 compare.py workbook.json workbook.xlsx [--tamper]
--tamper changes one expected value first; the comparison must then FAIL (positive control).
"""
import json
import sys

import openpyxl


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    tamper = "--tamper" in sys.argv
    with open(args[0], encoding="utf-8") as fh:
        wb = json.load(fh)
    if tamper:
        # a number when the workbook has one (last-digit change), else the first Info value
        nums = [(r, i) for s in wb["sheets"] for r in s["rows"] for i, x in enumerate(r) if isinstance(x, float)]
        if nums:
            r, i = nums[len(nums) // 2]
            r[i] += 1e-6
        else:
            wb["sheets"][0]["rows"][0][1] += "x"
    book = openpyxl.load_workbook(args[1], read_only=False, data_only=True)
    problems = []
    if book.sheetnames != [s["name"] for s in wb["sheets"]]:
        problems.append(f"sheet names {book.sheetnames}")
    cells = 0
    for s in wb["sheets"]:
        ws = book[s["name"]]
        header = s.get("header", True) and bool(s["columns"])
        expected = ([[c["header"] for c in s["columns"]]] if header else []) + s["rows"]
        for r, row in enumerate(expected, start=1):
            for c, want in enumerate(row, start=1):
                got = ws.cell(row=r, column=c).value
                if want == "":
                    want = None  # an empty string header/cell reads back as empty
                cells += 1
                same = got == want if not isinstance(want, float) else isinstance(got, (int, float)) and got == want
                if isinstance(want, (int, float)) and not isinstance(want, bool):
                    same = isinstance(got, (int, float)) and float(got) == float(want)
                if not same:
                    problems.append(f"{s['name']}!{openpyxl.utils.get_column_letter(c)}{r}: expected {want!r}, got {got!r}")
        # nothing written beyond the expected block
        if ws.max_row > max(len(expected), 1):
            problems.append(f"{s['name']}: {ws.max_row} rows, expected {len(expected)}")
        fr, fc = s.get("freeze") or [0, 0]
        want_pane = None if (fr, fc) == (0, 0) else f"{openpyxl.utils.get_column_letter(fc + 1)}{fr + 1}"
        if ws.freeze_panes != want_pane:
            problems.append(f"{s['name']}: freeze panes {ws.freeze_panes}, expected {want_pane}")
        if s.get("autofilter") and not ws.auto_filter.ref:
            problems.append(f"{s['name']}: no autofilter")
        if header and not ws.cell(row=1, column=1).font.b:
            problems.append(f"{s['name']}: header not bold")
    for p in problems[:20]:
        print("DIFF", p)
    print(f"compared {cells} cells in {len(wb['sheets'])} sheets: {'OK' if not problems else f'{len(problems)} differences'}")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
