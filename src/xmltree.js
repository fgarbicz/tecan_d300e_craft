// Minimal ordered XML tree parser/writer matching the formatting that
// D300e Control (.NET XmlWriter, Indent=true) produces for .tdd protocol files:
//   - optional UTF-8 BOM (preserved), XML declaration on line 1
//   - CRLF line endings, 2-space indentation
//   - empty elements written as "<Name />"
//   - leaf elements written inline: <Tag>text</Tag>
//   - comments on their own line
// The tree is deliberately generic so elements we do not model are preserved.
// Works in both Node and the browser (no DOMParser dependency).

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(cp);
    }
    if (!(e in ENT)) throw new Error(`Unknown XML entity &${e};`);
    return ENT[e];
  });
}

export function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Node shapes:
 *  {type:'element', name, attrs:[[k,v],...], children:[...]}   // children may be empty
 *  {type:'element', name, attrs, text:'...'}                   // leaf with text content
 *  {type:'comment', text}
 */
export function el(name, attrs = [], childrenOrText = []) {
  if (typeof childrenOrText === 'string') return { type: 'element', name, attrs, text: childrenOrText };
  return { type: 'element', name, attrs, children: childrenOrText };
}

export function parseXml(src) {
  let bom = false;
  if (src.charCodeAt(0) === 0xfeff) { bom = true; src = src.slice(1); }
  const declMatch = src.match(/^<\?xml[^?]*\?>/);
  if (!declMatch) throw new Error('Not an XML document (missing <?xml ... ?> declaration)');
  const declaration = declMatch[0];
  const newline = /\r\n/.test(src) ? '\r\n' : '\n';
  let i = declMatch[0].length;
  const stack = [{ type: 'element', name: '#doc', attrs: [], children: [] }];

  const top = () => stack[stack.length - 1];
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      if (src.slice(i).trim()) throw new Error('Trailing text after document element');
      break;
    }
    const between = src.slice(i, lt);
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      if (end === -1) throw new Error('Unterminated comment');
      if (between.trim()) throw new Error(`Mixed content not supported near offset ${i}`);
      top().children.push({ type: 'comment', text: src.slice(lt + 4, end) });
      i = end + 3;
      continue;
    }
    if (src[lt + 1] === '/') {
      const gt = src.indexOf('>', lt);
      const name = src.slice(lt + 2, gt).trim();
      const node = stack.pop();
      if (!node || node.name !== name) throw new Error(`Mismatched closing tag </${name}> (open: <${node && node.name}>)`);
      if (node.children.length === 0 && between.length > 0 && !/^\s*$/.test(between)) {
        node.text = decodeEntities(between);
        delete node.children;
      } else if (node.children.length === 0 && node._openEnded) {
        // <Tag></Tag> with only whitespace: keep as text so we round-trip it.
        node.text = decodeEntities(between);
        delete node.children;
      } else if (between.trim()) {
        throw new Error(`Mixed content not supported in <${name}>`);
      }
      delete node._openEnded;
      i = gt + 1;
      continue;
    }
    if (between.trim()) throw new Error(`Unexpected text before <... at offset ${lt}`);
    // start tag
    const gt = findTagEnd(src, lt);
    let inner = src.slice(lt + 1, gt);
    const selfClosing = inner.endsWith('/');
    if (selfClosing) inner = inner.slice(0, -1);
    const nameMatch = inner.match(/^([A-Za-z_][\w.:-]*)/);
    if (!nameMatch) throw new Error(`Bad tag at offset ${lt}`);
    const name = nameMatch[1];
    const attrs = [];
    const attrRe = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g;
    let m;
    const rest = inner.slice(name.length);
    while ((m = attrRe.exec(rest))) attrs.push([m[1], decodeEntities(m[2])]);
    const node = { type: 'element', name, attrs, children: [] };
    if (selfClosing) node.selfClosingSpace = /\s$/.test(inner);
    top().children.push(node);
    if (!selfClosing) { node._openEnded = true; stack.push(node); }
    i = gt + 1;
  }
  if (stack.length !== 1) throw new Error(`Unclosed element <${top().name}>`);
  const roots = stack[0].children.filter((n) => n.type === 'element');
  if (roots.length !== 1) throw new Error('Document must have exactly one root element');
  const trailingNewline = /\r?\n$/.test(src);
  for (const n of walk(stack[0])) delete n._openEnded;
  return { bom, declaration, newline, trailingNewline, root: roots[0] };
}

function findTagEnd(src, lt) {
  let q = false;
  for (let j = lt + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '"') q = !q;
    else if (c === '>' && !q) return j;
  }
  throw new Error(`Unterminated tag at offset ${lt}`);
}

function* walk(n) {
  yield n;
  if (n.children) for (const c of n.children) yield* walk(c);
}

export function writeXml(doc, { indent = '  ' } = {}) {
  const nl = doc.newline || '\r\n';
  const out = [];
  const writeNode = (n, depth) => {
    const pad = indent.repeat(depth);
    if (n.type === 'comment') { out.push(`${pad}<!--${n.text}-->`); return; }
    const attrs = n.attrs.map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`).join('');
    if (n.text !== undefined) {
      out.push(`${pad}<${n.name}${attrs}>${escapeText(String(n.text))}</${n.name}>`);
    } else if (!n.children || n.children.length === 0) {
      out.push(`${pad}<${n.name}${attrs} />`);
    } else {
      out.push(`${pad}<${n.name}${attrs}>`);
      for (const c of n.children) writeNode(c, depth + 1);
      out.push(`${pad}</${n.name}>`);
    }
  };
  out.push(doc.declaration || '<?xml version="1.0" encoding="utf-8"?>');
  writeNode(doc.root, 0);
  return (doc.bom ? '﻿' : '') + out.join(nl) + (doc.trailingNewline ? nl : '');
}

// Helpers for working with the generic tree.
export const child = (n, name) => (n.children || []).find((c) => c.type === 'element' && c.name === name);
export const childrenNamed = (n, name) => (n.children || []).filter((c) => c.type === 'element' && c.name === name);
export const attr = (n, k) => { const a = n.attrs.find(([kk]) => kk === k); return a ? a[1] : undefined; };
export const textOf = (n) => (n ? (n.text !== undefined ? n.text : '') : undefined);
