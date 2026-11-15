//! Minimal ordered XML tree parser/writer matching the formatting that
//! D300e Control (.NET XmlWriter, Indent=true) produces for .tdd protocol files:
//!   - optional UTF-8 BOM (preserved), XML declaration on line 1
//!   - CRLF line endings, 2-space indentation
//!   - empty elements written as "<Name />"
//!   - leaf elements written inline: <Tag>text</Tag>
//!   - comments on their own line
//!
//! The tree is deliberately generic so elements we do not model are preserved.
//! Port of src/xmltree.js; parsing rules (regexes, whitespace classes, error cases) follow it exactly.

use crate::error::{Error, Result};
use crate::jsnum::{is_js_space, js_trim};
use serde::{Deserialize, Serialize};

/// A node of the generic tree (JS shapes `{type:'element', ...}` / `{type:'comment', text}`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Node {
    Element(Element),
    Comment { text: String },
}

/// An element: either a list of children (possibly empty → `<X />`) or inline text (`<X>text</X>`;
/// `<X></X>` is text ""). Text "" and empty children are distinct and round-trip distinctly.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    #[serde(flatten)]
    pub content: Content,
    /// For self-closing tags: whether a space preceded "/>" (recorded, never used by the writer).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub self_closing_space: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Content {
    Text { text: String },
    Children { children: Vec<Node> },
}

impl Element {
    /// `el(name, attrs, children)`
    pub fn new(name: impl Into<String>, attrs: Vec<(String, String)>, children: Vec<Node>) -> Self {
        Element {
            name: name.into(),
            attrs,
            content: Content::Children { children },
            self_closing_space: None,
        }
    }
    /// `el(name, attrs, text)`
    pub fn leaf(
        name: impl Into<String>,
        attrs: Vec<(String, String)>,
        text: impl Into<String>,
    ) -> Self {
        Element {
            name: name.into(),
            attrs,
            content: Content::Text { text: text.into() },
            self_closing_space: None,
        }
    }
    /// `el(name)`: empty element.
    pub fn empty(name: impl Into<String>) -> Self {
        Element::new(name, vec![], vec![])
    }
    /// `n.children || []`
    pub fn children(&self) -> &[Node] {
        match &self.content {
            Content::Children { children } => children,
            Content::Text { .. } => &[],
        }
    }
    /// `n.text` (None when the element has children / is empty).
    pub fn text(&self) -> Option<&str> {
        match &self.content {
            Content::Text { text } => Some(text),
            Content::Children { .. } => None,
        }
    }
    /// `child(n, name)`: first child element with that name.
    pub fn child(&self, name: &str) -> Option<&Element> {
        self.children().iter().find_map(|c| match c {
            Node::Element(e) if e.name == name => Some(e),
            _ => None,
        })
    }
    /// `childrenNamed(n, name)`
    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Element> + 'a {
        self.children().iter().filter_map(move |c| match c {
            Node::Element(e) if e.name == name => Some(e),
            _ => None,
        })
    }
    /// `attr(n, k)`: first attribute with that name.
    pub fn attr(&self, k: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(kk, _)| kk == k)
            .map(|(_, v)| v.as_str())
    }
    /// `textOf(n)` for an existing node: its text, or "" for an element with children/empty.
    pub fn text_of(&self) -> String {
        self.text().unwrap_or("").to_string()
    }
}

impl From<Element> for Node {
    fn from(e: Element) -> Self {
        Node::Element(e)
    }
}

/// A parsed document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XmlDoc {
    pub bom: bool,
    pub declaration: String,
    pub newline: String,
    pub trailing_newline: bool,
    pub root: Element,
}

pub const DEFAULT_DECLARATION: &str = "<?xml version=\"1.0\" encoding=\"utf-8\"?>";

// ---------- entities ----------

/// Decode `&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);` (JS `decodeEntities`). Text that does not match the
/// pattern (e.g. a bare `&`, `&#X41;`, `&Amp;`) is left as is; an unknown lowercase name is an error.
pub fn decode_entities(s: &str) -> Result<String> {
    if !s.contains('&') {
        return Ok(s.to_string());
    }
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut last = 0;
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'&' {
            i += 1;
            continue;
        }
        if let Some((end, rep)) = match_entity(s, i)? {
            out.push_str(&s[last..i]);
            out.push_str(&rep);
            i = end;
            last = end;
        } else {
            i += 1;
        }
    }
    out.push_str(&s[last..]);
    Ok(out)
}

/// Try the entity regex at byte `i` (which holds '&'); returns (end, replacement).
fn match_entity(s: &str, i: usize) -> Result<Option<(usize, String)>> {
    let b = s.as_bytes();
    let run = |from: usize, pred: fn(u8) -> bool| {
        let mut j = from;
        while j < b.len() && pred(b[j]) {
            j += 1;
        }
        j
    };
    let code_point = |digits: &str, radix: u32| -> Result<String> {
        u32::from_str_radix(digits, radix)
            .ok()
            .and_then(char::from_u32)
            .map(|c| c.to_string())
            .ok_or_else(|| {
                Error::new(format!(
                    "Invalid code point &#{}{};",
                    if radix == 16 { "x" } else { "" },
                    digits
                ))
            })
    };
    if b.get(i + 1) == Some(&b'#') {
        // alternative 1: #x[0-9a-fA-F]+;
        if b.get(i + 2) == Some(&b'x') {
            let j = run(i + 3, |c| c.is_ascii_hexdigit());
            if j > i + 3 && b.get(j) == Some(&b';') {
                return Ok(Some((j + 1, code_point(&s[i + 3..j], 16)?)));
            }
        }
        // alternative 2: #[0-9]+;
        let j = run(i + 2, |c| c.is_ascii_digit());
        if j > i + 2 && b.get(j) == Some(&b';') {
            return Ok(Some((j + 1, code_point(&s[i + 2..j], 10)?)));
        }
        return Ok(None);
    }
    // alternative 3: [a-z]+;
    let j = run(i + 1, |c| c.is_ascii_lowercase());
    if j > i + 1 && b.get(j) == Some(&b';') {
        let rep = match &s[i + 1..j] {
            "amp" => "&",
            "lt" => "<",
            "gt" => ">",
            "quot" => "\"",
            "apos" => "'",
            other => return Err(Error::new(format!("Unknown XML entity &{other};"))),
        };
        return Ok(Some((j + 1, rep.to_string())));
    }
    Ok(None)
}

pub fn escape_text(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn escape_attr(s: &str) -> String {
    escape_text(s).replace('"', "&quot;")
}

// ---------- parse ----------

fn is_name_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_'
}
fn is_name_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b':' | b'-')
}
/// JS string offsets are UTF-16 code units; used only in error messages.
fn js_offset(s: &str, byte: usize) -> usize {
    s[..byte].encode_utf16().count()
}

struct Open {
    el: Element,
    children: Vec<Node>,
}

/// Parse a document (JS `parseXml`).
pub fn parse_xml(src: &str) -> Result<XmlDoc> {
    let mut src = src;
    let bom = src.starts_with('\u{FEFF}');
    if bom {
        src = &src['\u{FEFF}'.len_utf8()..];
    }
    // /^<\?xml[^?]*\?>/
    let declaration = (|| {
        if !src.starts_with("<?xml") {
            return None;
        }
        let q = 5 + src[5..].find('?')?;
        (src.as_bytes().get(q + 1) == Some(&b'>')).then(|| &src[..q + 2])
    })()
    .ok_or_else(|| Error::new("Not an XML document (missing <?xml ... ?> declaration)"))?;
    let newline = if src.contains("\r\n") { "\r\n" } else { "\n" };
    let b = src.as_bytes();
    let mut i = declaration.len();
    let mut stack: Vec<Open> = vec![Open {
        el: Element::empty("#doc"),
        children: vec![],
    }];

    while i < src.len() {
        let Some(lt) = src[i..].find('<').map(|p| p + i) else {
            if !js_trim(&src[i..]).is_empty() {
                return Err(Error::new("Trailing text after document element"));
            }
            break;
        };
        let between = &src[i..lt];
        if src[lt..].starts_with("<!--") {
            let end = src[lt..]
                .find("-->")
                .map(|p| p + lt)
                .ok_or_else(|| Error::new("Unterminated comment"))?;
            if !js_trim(between).is_empty() {
                return Err(Error::new(format!(
                    "Mixed content not supported near offset {}",
                    js_offset(src, i)
                )));
            }
            // JS slice(lt + 4, end) is "" when "-->" overlaps "<!--" (as in "<!-->")
            let text = if end >= lt + 4 { &src[lt + 4..end] } else { "" };
            stack.last_mut().unwrap().children.push(Node::Comment {
                text: text.to_string(),
            });
            i = end + 3;
            continue;
        }
        if b.get(lt + 1) == Some(&b'/') {
            let gt = src[lt..].find('>').map(|p| p + lt).ok_or_else(|| {
                Error::new(format!("Unterminated tag at offset {}", js_offset(src, lt)))
            })?;
            let name = js_trim(&src[lt + 2..gt]);
            let open = stack.pop().unwrap();
            if open.el.name != name || stack.is_empty() {
                return Err(Error::new(format!(
                    "Mismatched closing tag </{name}> (open: <{}>)",
                    open.el.name
                )));
            }
            let mut el = open.el;
            if open.children.is_empty() {
                // <Tag>text</Tag>, and <Tag></Tag> / whitespace-only content kept as text so it round-trips.
                el.content = Content::Text {
                    text: decode_entities(between)?,
                };
            } else {
                if !js_trim(between).is_empty() {
                    return Err(Error::new(format!(
                        "Mixed content not supported in <{name}>"
                    )));
                }
                el.content = Content::Children {
                    children: open.children,
                };
            }
            stack.last_mut().unwrap().children.push(Node::Element(el));
            i = gt + 1;
            continue;
        }
        if !js_trim(between).is_empty() {
            return Err(Error::new(format!(
                "Unexpected text before <... at offset {}",
                js_offset(src, lt)
            )));
        }
        // start tag
        let gt = find_tag_end(src, lt)?;
        let mut inner = &src[lt + 1..gt];
        let self_closing = inner.ends_with('/');
        if self_closing {
            inner = &inner[..inner.len() - 1];
        }
        let ib = inner.as_bytes();
        if ib.is_empty() || !is_name_start(ib[0]) {
            return Err(Error::new(format!(
                "Bad tag at offset {}",
                js_offset(src, lt)
            )));
        }
        let mut nlen = 1;
        while nlen < ib.len() && is_name_char(ib[nlen]) {
            nlen += 1;
        }
        let name = &inner[..nlen];
        let attrs = parse_attrs(&inner[nlen..])?;
        let mut el = Element::new(name, attrs, vec![]);
        if self_closing {
            el.self_closing_space = Some(inner.chars().next_back().is_some_and(is_js_space));
            stack.last_mut().unwrap().children.push(Node::Element(el));
        } else {
            stack.push(Open {
                el,
                children: vec![],
            });
        }
        i = gt + 1;
    }
    if stack.len() != 1 {
        return Err(Error::new(format!(
            "Unclosed element <{}>",
            stack.last().unwrap().el.name
        )));
    }
    let doc = stack.pop().unwrap();
    let mut roots = doc.children.into_iter().filter_map(|n| match n {
        Node::Element(e) => Some(e),
        Node::Comment { .. } => None,
    });
    let (Some(root), None) = (roots.next(), roots.next()) else {
        return Err(Error::new("Document must have exactly one root element"));
    };
    Ok(XmlDoc {
        bom,
        declaration: declaration.to_string(),
        newline: newline.to_string(),
        trailing_newline: src.ends_with('\n'), // /\r?\n$/
        root,
    })
}

fn find_tag_end(src: &str, lt: usize) -> Result<usize> {
    let mut q = false;
    for (j, &c) in src.as_bytes().iter().enumerate().skip(lt + 1) {
        if c == b'"' {
            q = !q;
        } else if c == b'>' && !q {
            return Ok(j);
        }
    }
    Err(Error::new(format!(
        "Unterminated tag at offset {}",
        js_offset(src, lt)
    )))
}

/// Global search of /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g over the tag text after the name.
/// Backtracking can never help this pattern (a shorter name is followed by a name character, which
/// is neither \s nor '='), so each start position is tried once with a greedy name.
fn parse_attrs(rest: &str) -> Result<Vec<(String, String)>> {
    let b = rest.as_bytes();
    let mut attrs = vec![];
    let mut p = 0;
    'scan: while p < b.len() {
        if !is_name_start(b[p]) {
            p += 1;
            continue;
        }
        let mut j = p + 1;
        while j < b.len() && is_name_char(b[j]) {
            j += 1;
        }
        let name_end = j;
        let skip_ws = |mut j: usize| {
            while let Some(c) = rest[j..].chars().next() {
                if !is_js_space(c) {
                    break;
                }
                j += c.len_utf8();
            }
            j
        };
        j = skip_ws(j);
        if b.get(j) != Some(&b'=') {
            p += 1;
            continue 'scan;
        }
        j = skip_ws(j + 1);
        if b.get(j) != Some(&b'"') {
            p += 1;
            continue 'scan;
        }
        let Some(close) = rest[j + 1..].find('"').map(|x| x + j + 1) else {
            p += 1;
            continue 'scan;
        };
        attrs.push((
            rest[p..name_end].to_string(),
            decode_entities(&rest[j + 1..close])?,
        ));
        p = close + 1;
    }
    Ok(attrs)
}

// ---------- write ----------

/// Serialize a document (JS `writeXml` with the default 2-space indent).
pub fn write_xml(doc: &XmlDoc) -> String {
    write_xml_indent(doc, "  ")
}

pub fn write_xml_indent(doc: &XmlDoc, indent: &str) -> String {
    let nl = if doc.newline.is_empty() {
        "\r\n"
    } else {
        doc.newline.as_str()
    };
    let mut out: Vec<String> = vec![];
    out.push(if doc.declaration.is_empty() {
        DEFAULT_DECLARATION.to_string()
    } else {
        doc.declaration.clone()
    });
    write_element(&doc.root, 0, indent, &mut out);
    let mut s = String::new();
    if doc.bom {
        s.push('\u{FEFF}');
    }
    s.push_str(&out.join(nl));
    if doc.trailing_newline {
        s.push_str(nl);
    }
    s
}

fn write_node(n: &Node, depth: usize, indent: &str, out: &mut Vec<String>) {
    match n {
        Node::Comment { text } => out.push(format!("{}<!--{text}-->", indent.repeat(depth))),
        Node::Element(e) => write_element(e, depth, indent, out),
    }
}

fn write_element(n: &Element, depth: usize, indent: &str, out: &mut Vec<String>) {
    let pad = indent.repeat(depth);
    let attrs: String = n
        .attrs
        .iter()
        .map(|(k, v)| format!(" {k}=\"{}\"", escape_attr(v)))
        .collect();
    match &n.content {
        Content::Text { text } => out.push(format!(
            "{pad}<{}{attrs}>{}</{}>",
            n.name,
            escape_text(text),
            n.name
        )),
        Content::Children { children } if children.is_empty() => {
            out.push(format!("{pad}<{}{attrs} />", n.name))
        }
        Content::Children { children } => {
            out.push(format!("{pad}<{}{attrs}>", n.name));
            for c in children {
                write_node(c, depth + 1, indent, out);
            }
            out.push(format!("{pad}</{}>", n.name));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entities() {
        assert_eq!(
            decode_entities("a &amp; &lt;b&gt; &#65;&#x42; & &#X41; &Amp;").unwrap(),
            "a & <b> AB & &#X41; &Amp;"
        );
        assert!(decode_entities("&nbsp;").is_err());
    }

    #[test]
    fn shapes_round_trip() {
        let src = "<?xml version=\"1.0\"?>\n<A x=\"1\" y=\"a&quot;\">\n  <B />\n  <C></C>\n  <D>  </D>\n  <!--c-->\n  <E>t &amp; u</E>\n</A>\n";
        let d = parse_xml(src).unwrap();
        assert!(d.trailing_newline && d.newline == "\n");
        assert_eq!(write_xml(&d), src);
        let kids = d.root.children();
        assert!(
            matches!(kids[0], Node::Element(ref e) if e.children().is_empty() && e.text().is_none())
        );
        assert!(matches!(kids[1], Node::Element(ref e) if e.text() == Some("")));
        assert!(matches!(kids[2], Node::Element(ref e) if e.text() == Some("  ")));
        // the writer normalizes attribute spacing, as the JS does
        let d2 = parse_xml("<?xml version=\"1.0\"?><A y = \"1\" />").unwrap();
        assert_eq!(write_xml(&d2), "<?xml version=\"1.0\"?>\n<A y=\"1\" />");
    }
}
