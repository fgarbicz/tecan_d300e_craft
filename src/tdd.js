// Semantic model for D300e Control protocol files (.tdd, "Version 4").
//
// Format knowledge comes ONLY from (a) protocol files saved by D300e Control 4.0.1
// (fixtures/reference/) and (b) the vendor user guide (docs/spec_from_user_guide.md).
// Anything not yet confirmed against the real software is marked "UNVERIFIED".
//
// Design rule: parse -> model -> write must reproduce a file saved by D300e Control
// byte for byte (tests/tdd.test.js). Elements this model does not know are kept as
// raw XML subtrees in their original position so nothing is silently dropped.

import { parseXml, writeXml, el, child, childrenNamed, attr, textOf } from './xmltree.js';

// ---------- number formatting ----------
// Per-well values in the reference file are written with 13 significant digits,
// trailing zeros removed (matches .NET Double.ToString("G13")): 4908/4908 values match.
// Exponent form confirmed for small values: 1E-05 (T01).
export function formatNumber(x) {
  if (!Number.isFinite(x)) throw new Error(`Cannot write non-finite number ${x}`);
  if (x === 0) return '0';
  // Round to 13 significant digits first; the exponent is taken after rounding
  // (9.9999999999999 -> 10), as .NET does.
  const [mant, expStr] = x.toExponential(12).split('e');
  const e = parseInt(expStr, 10);
  // .NET "G": scientific when the exponent is < -4 or >= precision.
  // Confirmed: 0.00001 is saved as "1E-05" (fixtures/reference/t01-setvalue-units.tdd, well A13).
  if (e < -4 || e >= 13) {
    const m = mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant;
    return `${m}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  }
  const fixed = Number(mant + 'e' + e).toFixed(Math.max(0, 12 - e));
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

const bool = (s) => s === 'True';
const boolStr = (b) => (b ? 'True' : 'False');

// ---------- constants observed in files ----------
export const PROTOCOL_DEFAULT_ORDER = [
  'Version', 'VolumeUnit', 'MolarityConcentrationUnit', 'MassConcentrationUnit', 'Fluids',
  'BlockFluidOnCellFail', 'ShowCellCountAsDispensed', 'CellDispenseMode', 'ShakePerFluid',
  'ShakePlateDuration', 'ShakePerWell', 'ShakeThresholdVolume', 'PrioritizeSurfactantFreeCassettes',
  'FluidOrderRun', 'BackfillOrder', 'BackfillNoDispense', 'Plates', 'HPDDPlates', 'Backfills',
  'Revisions', 'Thumbnail',
];
// Defaults of a NEW protocol in D300e Control 4.0.1 (fixtures/reference/t01-setvalue-units.tdd).
export const DEFAULT_SETTINGS = {
  Version: '4', VolumeUnit: 'nL', MolarityConcentrationUnit: 'µM', MassConcentrationUnit: 'ng_mL',
  BlockFluidOnCellFail: 'True', ShowCellCountAsDispensed: 'True', CellDispenseMode: '3',
  ShakePerFluid: 'False', ShakePlateDuration: '5', ShakePerWell: 'False', ShakeThresholdVolume: '100',
  PrioritizeSurfactantFreeCassettes: 'True', FluidOrderRun: 'False', BackfillOrder: 'Mixed',
  BackfillNoDispense: 'False',
};
export const DEFAULT_COMMENTS = [
  'Protocol files are intended for programmatic access.  File format may change without notice.',
  'Application: Version: 4.0.1, DLL version: 2.182',
];

const FLUID_ORDER = ['Name', 'RootFluidID', 'DilutionFactor', 'ByVol', 'Concentration', 'ConcentrationUnit', 'MaxVolume', 'MaxVolumeUnit', 'ClassID', 'Color'];
const PLATE_ORDER = ['PlateType', 'Rows', 'Cols', 'Name', 'AssayVolume', 'DMSOLimit', 'DontShake', 'Deionize', 'PromptPlateLoad', 'Wells', 'Randomize'];

// ---------- parse ----------
export function parseTdd(src) {
  const doc = parseXml(src);
  // Format version 4 wraps <Protocol> in <Root>; versions 2-3 (Tecan's example protocols) use <Protocol> as root.
  const legacyRoot = doc.root.name === 'Protocol';
  if (!legacyRoot && doc.root.name !== 'Root') throw new Error(`Expected <Root>, found <${doc.root.name}>`);
  const pnode = legacyRoot ? doc.root : child(doc.root, 'Protocol');
  if (!pnode) throw new Error('Missing <Protocol> element');

  const protocol = {
    _doc: { bom: doc.bom, declaration: doc.declaration, newline: doc.newline, trailingNewline: doc.trailingNewline, legacyRoot },
    _platesExtra: [], // non-<Plate> children of <Plates> (e.g. <Mode> in version 2), with their position
    _layout: [], // ordered list of {kind, name, value?} describing Protocol children
    settings: {},
    fluids: [],
    plates: [],
    hpddPlates: null,
    backfills: [],
    revisions: [],
    thumbnail: null,
  };
  for (const n of pnode.children) {
    if (n.type === 'comment') { protocol._layout.push({ kind: 'comment', text: n.text }); continue; }
    switch (n.name) {
      case 'Fluids': protocol.fluids = childrenNamed(n, 'Fluid').map(parseFluid); break;
      case 'Plates':
        protocol.plates = childrenNamed(n, 'Plate').map(parsePlate);
        (n.children || []).forEach((c, i) => { if (c.type !== 'element' || c.name !== 'Plate') protocol._platesExtra.push({ index: i, node: c }); });
        if (n.text !== undefined) protocol._platesText = n.text;
        break;
      case 'HPDDPlates': protocol.hpddPlates = n; break; // UNVERIFIED semantics: kept raw
      case 'Backfills': protocol.backfills = childrenNamed(n, 'Backfill').map(parseBackfill); break;
      case 'Revisions':
        protocol.revisions = childrenNamed(n, 'Revision').map((r) => ({ time: attr(r, 'Time'), userId: attr(r, 'UserID'), _attrs: r.attrs }));
        break;
      case 'Thumbnail': protocol.thumbnail = textOf(n); break;
      default:
        if (n.text !== undefined || (n.children && n.children.length === 0 && n.attrs.length === 0)) {
          protocol.settings[n.name] = n.text !== undefined ? n.text : '';
        } else {
          protocol._layout.push({ kind: 'raw', name: n.name, node: n });
          continue;
        }
    }
    protocol._layout.push({ kind: 'element', name: n.name });
  }
  return protocol;
}

function parseFluid(n) {
  const f = { id: Number(attr(n, 'ID')), _order: [], _extra: {} };
  for (const c of n.children) {
    if (c.type !== 'element') continue;
    f._order.push(c.name);
    const t = textOf(c);
    switch (c.name) {
      case 'Name': f.name = t; break;
      case 'ByVol': f.byVol = bool(t); break;
      case 'Concentration': f.concentration = Number(t); f._concText = t; break;
      case 'ConcentrationUnit': f.concentrationUnit = t; break;
      case 'MaxVolume': f.maxVolume = Number(t); f._maxVolText = t; break;
      case 'MaxVolumeUnit': f.maxVolumeUnit = t; break;
      case 'ClassID': f.classId = Number(t); break;
      case 'Color': f.color = Number(t); break;
      case 'RootFluidID': f.rootFluidId = Number(t); break;
      case 'DilutionFactor': f.dilutionFactor = Number(t); f._dilText = t; break;
      default: f._extra[c.name] = c;
    }
  }
  return f;
}

function parsePlate(n) {
  const p = { _order: [], _extra: {}, wells: new Map(), randomization: [] };
  for (const c of n.children) {
    if (c.type !== 'element') continue;
    p._order.push(c.name);
    const t = textOf(c);
    switch (c.name) {
      case 'PlateType': p.plateType = t; break;
      case 'Rows': p.rows = Number(t); break;
      case 'Cols': p.cols = Number(t); break;
      case 'Name': p.name = t; break;
      case 'AssayVolume': p.assayVolume = Number(t); p._assayText = t; break;
      case 'DMSOLimit': p.dmsoLimit = Number(t); p._dmsoText = t; break;
      case 'DontShake': p.dontShake = bool(t); break;
      case 'Deionize': p.deionize = bool(t); break;
      case 'PromptPlateLoad': p.promptPlateLoad = bool(t); break;
      case 'Wells':
        if (c.text !== undefined) p._wellsText = c.text;
        for (const w of childrenNamed(c, 'Well')) {
          const r = Number(attr(w, 'Row')), col = Number(attr(w, 'Col'));
          const m = new Map();
          for (const fl of childrenNamed(w, 'Fluid')) m.set(Number(attr(fl, 'ID')), Number(textOf(fl)));
          p.wells.set(wellKey(r, col), m);
        }
        break;
      case 'Randomize':
        // <Well R C ToR ToC/>: R,C is the well the D300e DISPENSES INTO; ToR,ToC is the design (non-random) well
        // whose contents go there. Confirmed with the run report of probe-28 (2026-11-16): for all 850 dispense
        // rows, "Non-random Well" = the file's To of the "Dispensed Well" (D300e's tooltip "Well G7 (C13)" is the
        // entry R=2 C=12 → ToR=6 ToC=6). Well contents stay at their design positions in <Wells>.
        // In memory the map reads the natural way: { r, c } design well → { toR, toC } dispensed well.
        // (was: R,C read as the design well — the inverse permutation; T09 alone could not tell the two apart.)
        p.randomization = childrenNamed(c, 'Well').map((w) => ({ r: Number(attr(w, 'ToR')), c: Number(attr(w, 'ToC')), toR: Number(attr(w, 'R')), toC: Number(attr(w, 'C')) }));
        p._randomizeRaw = c; p._randomizeJson = JSON.stringify(p.randomization);
        break;
      default: p._extra[c.name] = c;
    }
  }
  return p;
}

function parseBackfill(n) {
  const b = { classId: Number(attr(n, 'ClassID')), type: attr(n, 'Type'), param: attr(n, 'Param'), wells: [] };
  b.param = b.param === undefined ? undefined : Number(b.param);
  b._paramText = attr(n, 'Param');
  const ws = child(n, 'Wells');
  if (ws) for (const w of childrenNamed(ws, 'Well')) b.wells.push({ p: Number(attr(w, 'P')), r: Number(attr(w, 'R')), c: Number(attr(w, 'C')) });
  return b;
}

// ---------- write ----------
// Numbers parsed from a file keep their original text if unchanged, so values that the
// original software formatted differently from our formatter still round-trip exactly.
const numText = (val, origText) => (origText !== undefined && Number(origText) === val ? origText : formatNumber(val));

export function writeTdd(protocol) {
  const kids = [];
  const layout = protocol._layout && protocol._layout.length ? protocol._layout : defaultLayout(protocol);
  const emitted = new Set();
  for (const item of layout) {
    if (item.kind === 'comment') { kids.push({ type: 'comment', text: item.text }); continue; }
    if (item.kind === 'raw') { kids.push(item.node); continue; }
    const node = protocolElement(protocol, item.name);
    if (node) kids.push(node);
    emitted.add(item.name);
  }
  // settings added after parsing (not in layout) go before <Plates>
  for (const k of Object.keys(protocol.settings)) {
    if (emitted.has(k)) continue;
    const idx = kids.findIndex((n) => n.name === 'Plates');
    const node = el(k, [], String(protocol.settings[k]));
    if (idx >= 0) kids.splice(idx, 0, node); else kids.push(node);
  }
  const pnode = el('Protocol', [], kids);
  const root = protocol._doc && protocol._doc.legacyRoot ? pnode : el('Root', [], [pnode]);
  const d = protocol._doc || { bom: false, declaration: '<?xml version="1.0" encoding="utf-8"?>', newline: '\r\n', trailingNewline: false };
  return writeXml({ ...d, root });
}

function defaultLayout(protocol) {
  const items = DEFAULT_COMMENTS.map((text) => ({ kind: 'comment', text }));
  for (const name of PROTOCOL_DEFAULT_ORDER) {
    if (name === 'Version' && !('Version' in protocol.settings)) continue;
    items.push({ kind: 'element', name });
  }
  return items;
}

function protocolElement(protocol, name) {
  switch (name) {
    case 'Fluids': return el('Fluids', [], protocol.fluids.map(writeFluid));
    case 'Plates': {
      const kids = protocol.plates.map(writePlate);
      for (const { index, node } of protocol._platesExtra || []) kids.splice(Math.min(index, kids.length), 0, node);
      if (!kids.length && protocol._platesText !== undefined) return el('Plates', [], protocol._platesText);
      return el('Plates', [], kids);
    }
    case 'HPDDPlates': return protocol.hpddPlates || el('HPDDPlates');
    case 'Backfills': return el('Backfills', [], protocol.backfills.filter((b) => b.wells.length).map(writeBackfill));
    case 'Revisions': return el('Revisions', [], protocol.revisions.map((r) => el('Revision', r._attrs || [['Time', r.time], ['UserID', r.userId]])));
    case 'Thumbnail': return protocol.thumbnail != null ? el('Thumbnail', [], protocol.thumbnail) : null;
    default:
      if (name in protocol.settings) return el(name, [], String(protocol.settings[name]));
      return null;
  }
}

function writeFluid(f) {
  const optional = { Color: f.color, RootFluidID: f.rootFluidId, DilutionFactor: f.dilutionFactor };
  const order = f._order && f._order.length ? [...f._order] : FLUID_ORDER.filter((k) => !(k in optional) || optional[k] != null);
  if (f.color != null && !order.includes('Color')) order.push('Color');
  const kids = [];
  for (const k of order) {
    switch (k) {
      case 'Name': kids.push(el('Name', [], f.name || '')); break;
      case 'ByVol': kids.push(el('ByVol', [], boolStr(f.byVol))); break;
      case 'Concentration': kids.push(el('Concentration', [], numText(f.concentration, f._concText))); break;
      case 'ConcentrationUnit': kids.push(el('ConcentrationUnit', [], f.concentrationUnit)); break;
      case 'MaxVolume': kids.push(el('MaxVolume', [], numText(f.maxVolume, f._maxVolText))); break;
      case 'MaxVolumeUnit': kids.push(el('MaxVolumeUnit', [], f.maxVolumeUnit)); break;
      case 'ClassID': kids.push(el('ClassID', [], String(f.classId))); break;
      case 'Color': if (f.color != null) kids.push(el('Color', [], String(f.color))); break;
      case 'RootFluidID': if (f.rootFluidId != null) kids.push(el('RootFluidID', [], String(f.rootFluidId))); break;
      case 'DilutionFactor': if (f.dilutionFactor != null) kids.push(el('DilutionFactor', [], numText(f.dilutionFactor, f._dilText))); break;
      default: if (f._extra && f._extra[k]) kids.push(f._extra[k]);
    }
  }
  return el('Fluid', [['ID', String(f.id)]], kids);
}

function writePlate(p) {
  const order = p._order && p._order.length ? p._order : PLATE_ORDER;
  const kids = [];
  for (const k of order) {
    switch (k) {
      case 'PlateType': kids.push(el('PlateType', [], p.plateType)); break;
      case 'Rows': kids.push(el('Rows', [], String(p.rows))); break;
      case 'Cols': kids.push(el('Cols', [], String(p.cols))); break;
      case 'Name': kids.push(p.name ? el('Name', [], p.name) : el('Name')); break;
      case 'AssayVolume': kids.push(el('AssayVolume', [], numText(p.assayVolume, p._assayText))); break;
      case 'DMSOLimit': kids.push(el('DMSOLimit', [], numText(p.dmsoLimit, p._dmsoText))); break;
      case 'DontShake': kids.push(el('DontShake', [], boolStr(p.dontShake))); break;
      case 'Deionize': kids.push(el('Deionize', [], boolStr(p.deionize))); break;
      case 'PromptPlateLoad': kids.push(el('PromptPlateLoad', [], boolStr(p.promptPlateLoad))); break;
      case 'Wells': {
        const ws = writeWells(p);
        kids.push(!ws.length && p._wellsText !== undefined ? el('Wells', [], p._wellsText) : el('Wells', [], ws));
        break;
      }
      case 'Randomize': {
        const list = p.randomization || [];
        if (p._randomizeRaw && JSON.stringify(list) === p._randomizeJson) { kids.push(p._randomizeRaw); break; }
        // file attributes: R,C = dispensed well, ToR,ToC = design well; D300e lists them by dispensed well
        kids.push(el('Randomize', [], [...list].sort((a, b) => a.toR - b.toR || a.toC - b.toC)
          .map((m) => el('Well', [['R', String(m.toR)], ['C', String(m.toC)], ['ToR', String(m.r)], ['ToC', String(m.c)]]))));
        break;
      }
      default: if (p._extra && p._extra[k]) kids.push(p._extra[k]);
    }
  }
  return el('Plate', [], kids);
}

function writeWells(p) {
  // Observed: wells row-major; empty wells omitted.
  const entries = [...p.wells.entries()]
    .map(([k, m]) => [splitKey(k), m])
    .filter(([, m]) => [...m.values()].some((v) => v !== 0))
    .sort(([a], [b]) => a[0] - b[0] || a[1] - b[1]);
  return entries.map(([[r, c], m]) => el('Well', [['Row', String(r)], ['Col', String(c)]],
    // Fluids inside a well keep the order in which they were applied (not sorted by ID):
    // t07-synergy3.tdd lists A, B, C = IDs 0, 2, 1. Map insertion order preserves that.
    [...m.entries()].filter(([, v]) => v !== 0)
      .map(([id, v]) => el('Fluid', [['ID', String(id)]], formatNumber(v)))));
}

function writeBackfill(b) {
  const attrs = [['ClassID', String(b.classId)], ['Type', b.type]];
  if (b.param !== undefined && b.param !== null) attrs.push(['Param', numText(b.param, b._paramText)]);
  const ws = [...b.wells].sort((x, y) => x.p - y.p || x.r - y.r || x.c - y.c);
  return el('Backfill', attrs, [el('Wells', [], ws.map((w) => el('Well', [['P', String(w.p)], ['R', String(w.r)], ['C', String(w.c)]])))]);
}

// ---------- helpers ----------
export const wellKey = (r, c) => `${r},${c}`;
export const splitKey = (k) => k.split(',').map(Number);
export const wellName = (r, c) => {
  // rows beyond Z (1536 plates) use AA, AB ... as in standard plate notation
  const letters = r < 26 ? String.fromCharCode(65 + r) : String.fromCharCode(64 + Math.floor(r / 26)) + String.fromCharCode(65 + (r % 26));
  return `${letters}${c + 1}`;
};

export function newProtocol() {
  return {
    _doc: null, _layout: [], settings: { ...DEFAULT_SETTINGS }, fluids: [], plates: [],
    hpddPlates: null, backfills: [], revisions: [], thumbnail: null,
  };
}
