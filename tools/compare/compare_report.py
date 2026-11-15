"""Compare the JS dispense engine with a D300e Control run report (SpreadsheetML 'Tabular Detail').
Usage: python3 -I tools/compare/compare_report.py <protocol.tdd> <report.xml>"""
import json, re, subprocess, sys, xml.etree.ElementTree as ET
from collections import Counter
NS = '{urn:schemas-microsoft-com:office:spreadsheet}'
def sheet(root, name):
    for ws in root.iter(NS + 'Worksheet'):
        if ws.get(NS + 'Name') == name:
            rows = []
            for r in ws.iter(NS + 'Row'):
                cells = []
                for c in r.findall(NS + 'Cell'):
                    if c.get(NS + 'Index'):
                        cells += [''] * (int(c.get(NS + 'Index')) - 1 - len(cells))
                    d = c.find(NS + 'Data'); cells.append(d.text if d is not None else '')
                rows.append(cells)
            return rows
tdd, rep = sys.argv[1], sys.argv[2]
mine = json.loads(subprocess.run(['node', 'tools/compare/engine_dump.mjs', tdd], capture_output=True, text=True, check=True).stdout)
fluid_names = {}
root = ET.parse(rep).getroot()
for r in sheet(root, 'Fluids')[1:]:
    if not r or not r[0] or not r[0].isdigit(): break
    fluid_names[r[1]] = int(r[0])
norm_ids = {v for k, v in fluid_names.items() if k.endswith('normalization')}
def norm_well(w):  # A1 / A01 -> A1
    m = re.match(r'([A-Z]+)0*(\d+)$', w); return m.group(1) + m.group(2)
td = sheet(root, 'Tabular Detail'); head = td[0]
idx = {}
for m in mine:
    key = (m['plate'], m['well'], 'norm' if m['fluid'] == 'norm' else m['fluid'])
    idx[key] = m
stats = Counter(); bad = []; per = {}
# plates whose report has no normalization rows although the protocol normalizes them (run aborted)
report_norm_plates = {int(r[1]) for r in td[1:] if len(r) > 9 and r[1] and r[9].endswith('normalization')}
UNDISPENSED_NORM_PLATES = {m['plate'] for m in mine if m['fluid'] == 'norm'} - report_norm_plates
seen = set()
for r in td[1:]:
    if len(r) < 18 or not r[1]: continue
    plate, well, fluid = int(r[1]), norm_well(r[2]), int(r[8])
    vol, conc, total = float(r[15]), (float(r[13]) if r[13] else None), float(r[17])
    key = (plate, well, 'norm' if fluid in norm_ids else fluid)
    seen.add(key)
    m = idx.get(key)
    if m is None: stats['missing_in_engine'] += 1; bad.append(('missing', key, vol)); continue
    ok_v = abs(m['volume'] - vol) < 1e-6
    ok_t = abs(m['total'] - total) < 1e-6
    ok_c = conc is None or (m['conc'] is not None and abs(m['conc'] - conc) <= 1e-9 * max(1, abs(conc)) + 5e-12)
    if plate in UNDISPENSED_NORM_PLATES and not ok_t:
        # normalization planned but not dispensed (aborted run): report total excludes it
        t2 = m['total'] - m['norm']; ok_t = abs(t2 - total) < 1e-6
        if m['conc'] is not None and conc is not None:
            ok_c = abs(m['conc'] * m['total'] / t2 - conc) <= 1e-9 * max(1, abs(conc)) + 5e-12
    stats['rows'] += 1; stats['vol_ok'] += ok_v; stats['total_ok'] += ok_t; stats['conc_ok'] += ok_c
    pc = per.setdefault(plate, Counter()); pc['rows'] += 1; pc['vol'] += ok_v; pc['total'] += ok_t; pc['conc'] += ok_c
    pc['norm_rows'] += key[2] == 'norm'
    if not ok_v and plate >= int(__import__('os').environ.get('MINPLATE','1')) and len(bad) < 15: bad.append((key, 'report', vol, conc, total, 'engine', m['volume'], m['conc'], m['total']))
extra = [k for k in idx if k not in seen]
print(dict(stats), '| normalization planned but not dispensed (aborted run) on plates', sorted(UNDISPENSED_NORM_PLATES), '| engine norm rows absent from report:', len(extra))
if stats['rows'] and stats['vol_ok'] == stats['total_ok'] == stats['conc_ok'] == stats['rows']: print('ALL ROWS MATCH')
for pl in sorted(per): print('plate', pl, dict(per[pl]))
for b in bad[:15]: print(b)
