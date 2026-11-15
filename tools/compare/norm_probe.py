"""Find which normalization model reproduces the D300e report: for each candidate (class volume = exact
or rounded; rounding = nearest/floor/ceil), compute the feasible target interval across all normalized
wells of a group and report whether it is non-empty."""
import json, re, subprocess, sys, xml.etree.ElementTree as ET, math
sys.path.insert(0, 'tools/compare')
NS = '{urn:schemas-microsoft-com:office:spreadsheet}'
tdd, rep = sys.argv[1], sys.argv[2]
dump = json.loads(subprocess.run(['node', '-e', '''
import("./src/tdd.js").then(async ({parseTdd, wellName, splitKey}) => {
 const {computeProtocol} = await import("./src/dispense.js");
 const fs = await import("node:fs");
 const p = parseTdd(fs.readFileSync(process.argv[1], "utf8"));
 // compute WITHOUT normalization
 const q = {...p, backfills: []};
 const out = [];
 computeProtocol(q).forEach(({wells}, pi) => { for (const [k, w] of wells) { const [r,c] = splitKey(k);
   out.push({plate: pi+1, well: wellName(r,c), exact: w.fluids.reduce((s,x)=>s+x.exactVolume,0), rounded: w.fluids.reduce((s,x)=>s+x.volume,0)}); } });
 process.stdout.write(JSON.stringify(out));
});''', tdd], capture_output=True, text=True, check=True).stdout)
vol = {(d['plate'], d['well']): d for d in dump}
root = ET.parse(rep).getroot()
rows = []
for ws in root.iter(NS + 'Worksheet'):
    if ws.get(NS + 'Name') == 'Tabular Detail':
        for r in ws.iter(NS + 'Row'):
            cells = [ (c.find(NS+'Data').text if c.find(NS+'Data') is not None else '') for c in r.findall(NS + 'Cell')]
            rows.append(cells)
norm = {}
for r in rows[1:]:
    if len(r) > 15 and r[9] and r[9].endswith('normalization'):
        w = re.sub(r'([A-Z]+)0*(\d+)', r'\1\2', r[2]); norm[(int(r[1]), w)] = float(r[15])
grid = lambda v: 0.4 if v > 3.6 else 0.02
for group, plates in [('ToMaxVolume P1-3', {1, 2, 3}), ('ToMaxVolume P4-6', {4, 5, 6})]:
    items = [(k, n) for k, n in norm.items() if k[0] in plates]
    print(group, 'normalized wells in report:', len(items))
    for basis in ('exact', 'rounded'):
        for mode in ('nearest', 'floor', 'ceil'):
            lo, hi = -math.inf, math.inf
            for k, n in items:
                v = vol.get(k, {'exact': 0, 'rounded': 0})[basis]
                g = 0.4
                if mode == 'nearest': a, b = n - g / 2, n + g / 2
                elif mode == 'floor': a, b = n, n + g
                else: a, b = n - g, n
                lo, hi = max(lo, v + a), min(hi, v + b)
            print(f'  {basis:8s} {mode:8s} target in [{lo:.4f}, {hi:.4f})', 'OK' if lo < hi else 'impossible')
    # also: max class volume in group
    mx_e = max(vol.get(k, {'exact': 0})['exact'] for k, _ in items); mx_r = max(vol.get(k, {'rounded': 0})['rounded'] for k, _ in items)
    print('  max exact class vol', round(mx_e, 4), 'max rounded', mx_r)
