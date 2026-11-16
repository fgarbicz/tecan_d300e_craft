"""Print the fluid and cassette/head tables of a D300e Control run report (SpreadsheetML).
Usage: python3 -I tools/cassette/report_cassettes.py <report.xml> [--json]"""
import json, sys, xml.etree.ElementTree as ET
NS = '{urn:schemas-microsoft-com:office:spreadsheet}'

def sheets(root):
    out = {}
    for ws in root.iter(NS + 'Worksheet'):
        rows = []
        for r in ws.iter(NS + 'Row'):
            cells = []
            for c in r.findall(NS + 'Cell'):
                if c.get(NS + 'Index'):
                    cells += [''] * (int(c.get(NS + 'Index')) - 1 - len(cells))
                d = c.find(NS + 'Data'); cells.append(d.text if d is not None and d.text is not None else '')
            rows.append(cells)
        out[ws.get(NS + 'Name')] = rows
    return out

def tables(rows):
    """Split a sheet into blocks separated by empty rows; each block = header + rows."""
    blocks, cur = [], []
    for r in rows:
        if not any(x.strip() for x in r):
            if cur: blocks.append(cur); cur = []
        else: cur.append(r)
    if cur: blocks.append(cur)
    return blocks

def extract(path):
    sh = sheets(ET.parse(path).getroot())
    res = {'fluids': [], 'heads': [], 'cassettes': []}
    for name, rows in sh.items():
        for b in tables(rows):
            h = [x.replace('\n', ' ') for x in b[0]]
            recs = [dict(zip(h, r)) for r in b[1:]]
            if 'Dispense Heads' in h and 'Loaded Volume (µL)' in h: res['fluids'] = recs
            elif 'Dispense Head' in h and 'Loaded Volume (µL)' in h: res['heads'] = recs
            elif 'Cassette ID' in h and 'Cassette Type' in h: res['cassettes'] = recs
    return res

if __name__ == '__main__':
    r = extract(sys.argv[1])
    if '--json' in sys.argv: print(json.dumps(r, ensure_ascii=False)); sys.exit()
    for k in ('fluids', 'heads', 'cassettes'):
        print(f'== {k}')
        for x in r[k]: print({a: b for a, b in x.items() if b not in ('',)})
