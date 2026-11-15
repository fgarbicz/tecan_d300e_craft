//! Semantic model for D300e Control protocol files (.tdd, "Version 4"). Port of src/tdd.js.
//!
//! Format knowledge comes ONLY from (a) protocol files saved by D300e Control 4.0.1
//! (fixtures/reference/) and (b) the vendor user guide (docs/spec_from_user_guide.md).
//! Anything not yet confirmed against the real software is marked "UNVERIFIED".
//!
//! Design rule: parse -> model -> write must reproduce a file saved by D300e Control
//! byte for byte (tests/roundtrip.rs). Elements this model does not know are kept as
//! raw XML subtrees in their original position so nothing is silently dropped.
//!
//! Deliberate difference from the JS: integer fields (fluid/class/colour IDs, rows/cols, well and
//! backfill coordinates) must hold integral numbers; JS would carry NaN/fractions through and write
//! garbage ("NaN"), the port returns `Err` instead. Every file D300e Control writes satisfies this.

use crate::error::{Error, Result};
use crate::jsnum::{to_exponential, to_fixed, to_js_string, to_number};
use crate::xmltree::{parse_xml, write_xml, Element, Node, XmlDoc, DEFAULT_DECLARATION};
use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashSet;
use std::fmt;

// ---------- number formatting ----------

/// Per-well values in the reference file are written with 13 significant digits,
/// trailing zeros removed (matches .NET Double.ToString("G13")): 4908/4908 values match.
/// Exponent form confirmed for small values: 1E-05 (T01).
pub fn format_number(x: f64) -> Result<String> {
    if !x.is_finite() {
        return Err(Error::new(format!(
            "Cannot write non-finite number {}",
            to_js_string(x)
        )));
    }
    if x == 0.0 {
        return Ok("0".into());
    }
    // Round to 13 significant digits first; the exponent is taken after rounding
    // (9.9999999999999 -> 10), as .NET does.
    let s = to_exponential(x, 12);
    let (mant, exp_str) = s.split_once('e').unwrap();
    let e: i32 = exp_str.parse().unwrap();
    // .NET "G": scientific when the exponent is < -4 or >= precision.
    // Confirmed: 0.00001 is saved as "1E-05" (fixtures/reference/t01-setvalue-units.tdd, well A13).
    if !(-4..13).contains(&e) {
        let m = if mant.contains('.') {
            mant.trim_end_matches('0').trim_end_matches('.')
        } else {
            mant
        };
        return Ok(format!(
            "{m}E{}{:02}",
            if e < 0 { '-' } else { '+' },
            e.abs()
        ));
    }
    let fixed = to_fixed(to_number(&format!("{mant}e{e}")), (12 - e).max(0) as usize);
    Ok(if fixed.contains('.') {
        fixed
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    } else {
        fixed
    })
}

fn bool_of(s: &str) -> bool {
    s == "True"
}
fn bool_str(b: bool) -> &'static str {
    if b {
        "True"
    } else {
        "False"
    }
}

/// `Number(text)` for a field that must be integral (see the module note).
fn int_of(t: Option<&str>, what: &str) -> Result<i64> {
    let v = t.map(to_number).unwrap_or(f64::NAN);
    if v.is_finite() && v.fract() == 0.0 && v.abs() <= 9.007_199_254_740_992e15 {
        Ok(v as i64)
    } else {
        Err(Error::new(format!(
            "{what}: expected an integer, found {:?}",
            t.unwrap_or("(missing)")
        )))
    }
}
fn uint_of(t: Option<&str>, what: &str) -> Result<u32> {
    let v = int_of(t, what)?;
    u32::try_from(v).map_err(|_| {
        Error::new(format!(
            "{what}: expected a non-negative integer, found {v}"
        ))
    })
}

// ---------- constants observed in files ----------
pub const PROTOCOL_DEFAULT_ORDER: [&str; 21] = [
    "Version",
    "VolumeUnit",
    "MolarityConcentrationUnit",
    "MassConcentrationUnit",
    "Fluids",
    "BlockFluidOnCellFail",
    "ShowCellCountAsDispensed",
    "CellDispenseMode",
    "ShakePerFluid",
    "ShakePlateDuration",
    "ShakePerWell",
    "ShakeThresholdVolume",
    "PrioritizeSurfactantFreeCassettes",
    "FluidOrderRun",
    "BackfillOrder",
    "BackfillNoDispense",
    "Plates",
    "HPDDPlates",
    "Backfills",
    "Revisions",
    "Thumbnail",
];
/// Defaults of a NEW protocol in D300e Control 4.0.1 (fixtures/reference/t01-setvalue-units.tdd).
pub const DEFAULT_SETTINGS: [(&str, &str); 15] = [
    ("Version", "4"),
    ("VolumeUnit", "nL"),
    ("MolarityConcentrationUnit", "µM"),
    ("MassConcentrationUnit", "ng_mL"),
    ("BlockFluidOnCellFail", "True"),
    ("ShowCellCountAsDispensed", "True"),
    ("CellDispenseMode", "3"),
    ("ShakePerFluid", "False"),
    ("ShakePlateDuration", "5"),
    ("ShakePerWell", "False"),
    ("ShakeThresholdVolume", "100"),
    ("PrioritizeSurfactantFreeCassettes", "True"),
    ("FluidOrderRun", "False"),
    ("BackfillOrder", "Mixed"),
    ("BackfillNoDispense", "False"),
];
pub const DEFAULT_COMMENTS: [&str; 2] = [
    "Protocol files are intended for programmatic access.  File format may change without notice.",
    "Application: Version: 4.0.1, DLL version: 2.182",
];

const FLUID_ORDER: [&str; 10] = [
    "Name",
    "RootFluidID",
    "DilutionFactor",
    "ByVol",
    "Concentration",
    "ConcentrationUnit",
    "MaxVolume",
    "MaxVolumeUnit",
    "ClassID",
    "Color",
];
const PLATE_ORDER: [&str; 11] = [
    "PlateType",
    "Rows",
    "Cols",
    "Name",
    "AssayVolume",
    "DMSOLimit",
    "DontShake",
    "Deionize",
    "PromptPlateLoad",
    "Wells",
    "Randomize",
];

// ---------- model ----------

/// Well key: (row, col), 0-based. Serialized as the JS key string "r,c" (so it can be a JSON map key).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct WellKey(pub u32, pub u32);

impl WellKey {
    pub fn row(&self) -> u32 {
        self.0
    }
    pub fn col(&self) -> u32 {
        self.1
    }
}
impl fmt::Display for WellKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{},{}", self.0, self.1)
    }
}
impl Serialize for WellKey {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}
impl<'de> Deserialize<'de> for WellKey {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        let (r, c) = s
            .split_once(',')
            .ok_or_else(|| serde::de::Error::custom(format!("bad well key {s:?}")))?;
        Ok(WellKey(
            r.parse().map_err(serde::de::Error::custom)?,
            c.parse().map_err(serde::de::Error::custom)?,
        ))
    }
}

/// `wellKey(r, c)`
pub fn well_key(r: u32, c: u32) -> WellKey {
    WellKey(r, c)
}
/// `splitKey(k)`
pub fn split_key(k: WellKey) -> (u32, u32) {
    (k.0, k.1)
}

/// Requested values of one well: fluid ID -> value (base concentration units, or nL for ByVol fluids),
/// in insertion order (the order matters: it is the summation order of the dispense engine).
pub type WellFluids = IndexMap<i64, f64>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocInfo {
    pub bom: bool,
    pub declaration: String,
    pub newline: String,
    pub trailing_newline: bool,
    pub legacy_root: bool,
}

/// One child of `<Protocol>` in file order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LayoutItem {
    Comment {
        text: String,
    },
    /// An element this model does not know (has attributes or children): kept verbatim.
    Raw {
        name: String,
        node: Element,
    },
    Element {
        name: String,
    },
}

/// A non-`<Plate>` child of `<Plates>` (e.g. `<Mode>` in version 2) and its position.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlatesExtra {
    pub index: usize,
    pub node: Node,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Fluid {
    pub id: i64,
    pub name: Option<String>,
    pub by_vol: bool,
    pub concentration: Option<f64>,
    pub concentration_unit: Option<String>,
    pub max_volume: Option<f64>,
    pub max_volume_unit: Option<String>,
    pub class_id: Option<i64>,
    pub color: Option<i64>,
    pub root_fluid_id: Option<i64>,
    pub dilution_factor: Option<f64>,
    /// Child element order as read (empty = default order for a new fluid).
    #[serde(rename = "_order")]
    pub order: Vec<String>,
    #[serde(rename = "_extra")]
    pub extra: IndexMap<String, Element>,
    #[serde(rename = "_concText", skip_serializing_if = "Option::is_none")]
    pub conc_text: Option<String>,
    #[serde(rename = "_maxVolText", skip_serializing_if = "Option::is_none")]
    pub max_vol_text: Option<String>,
    #[serde(rename = "_dilText", skip_serializing_if = "Option::is_none")]
    pub dil_text: Option<String>,
}

/// One randomized well: design well (r, c) is dispensed into (to_r, to_c).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RandomMap {
    pub r: u32,
    pub c: u32,
    pub to_r: u32,
    pub to_c: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Plate {
    pub plate_type: Option<String>,
    pub rows: u32,
    pub cols: u32,
    pub name: String,
    /// Additional volume A (nL). NaN when the file has no <AssayVolume> (JS: undefined).
    #[serde(deserialize_with = "f64_or_nan")]
    pub assay_volume: f64,
    pub dmso_limit: Option<f64>,
    pub dont_shake: bool,
    pub deionize: bool,
    pub prompt_plate_load: bool,
    pub wells: IndexMap<WellKey, WellFluids>,
    pub randomization: Vec<RandomMap>,
    #[serde(rename = "_order")]
    pub order: Vec<String>,
    #[serde(rename = "_extra")]
    pub extra: IndexMap<String, Element>,
    #[serde(rename = "_assayText", skip_serializing_if = "Option::is_none")]
    pub assay_text: Option<String>,
    #[serde(rename = "_dmsoText", skip_serializing_if = "Option::is_none")]
    pub dmso_text: Option<String>,
    #[serde(rename = "_wellsText", skip_serializing_if = "Option::is_none")]
    pub wells_text: Option<String>,
    /// The <Randomize> node as read, re-emitted while `randomization` is unchanged.
    #[serde(rename = "_randomizeRaw", skip_serializing_if = "Option::is_none")]
    pub randomize_raw: Option<Element>,
    /// `randomization` as read (JS keeps it as `_randomizeJson`).
    #[serde(rename = "_randomizeJson", skip_serializing_if = "Option::is_none")]
    pub randomize_snapshot: Option<Vec<RandomMap>>,
}

impl Default for Plate {
    fn default() -> Self {
        Plate {
            plate_type: None,
            rows: 0,
            cols: 0,
            name: String::new(),
            assay_volume: f64::NAN,
            dmso_limit: None,
            dont_shake: false,
            deionize: false,
            prompt_plate_load: false,
            wells: IndexMap::new(),
            randomization: vec![],
            order: vec![],
            extra: IndexMap::new(),
            assay_text: None,
            dmso_text: None,
            wells_text: None,
            randomize_raw: None,
            randomize_snapshot: None,
        }
    }
}

fn f64_or_nan<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::NAN))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct BackfillWell {
    pub p: u32,
    pub r: u32,
    pub c: u32,
}

/// A normalization group (`<Backfill ClassID Type [Param]>`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Backfill {
    pub class_id: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub param: Option<f64>,
    #[serde(rename = "_paramText", skip_serializing_if = "Option::is_none")]
    pub param_text: Option<String>,
    pub wells: Vec<BackfillWell>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Revision {
    pub time: Option<String>,
    pub user_id: Option<String>,
    /// Attributes as read; written back verbatim when present.
    #[serde(rename = "_attrs", skip_serializing_if = "Option::is_none")]
    pub attrs: Option<Vec<(String, String)>>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Protocol {
    #[serde(rename = "_doc")]
    pub doc: Option<DocInfo>,
    #[serde(rename = "_platesExtra")]
    pub plates_extra: Vec<PlatesExtra>,
    #[serde(rename = "_platesText", skip_serializing_if = "Option::is_none")]
    pub plates_text: Option<String>,
    #[serde(rename = "_layout")]
    pub layout: Vec<LayoutItem>,
    pub settings: IndexMap<String, String>,
    pub fluids: Vec<Fluid>,
    pub plates: Vec<Plate>,
    /// UNVERIFIED semantics: kept raw.
    pub hpdd_plates: Option<Element>,
    pub backfills: Vec<Backfill>,
    pub revisions: Vec<Revision>,
    pub thumbnail: Option<String>,
}

// ---------- parse ----------

pub fn parse_tdd(src: &str) -> Result<Protocol> {
    let doc = parse_xml(src)?;
    // Format version 4 wraps <Protocol> in <Root>; versions 2-3 (Tecan's example protocols) use <Protocol> as root.
    let legacy_root = doc.root.name == "Protocol";
    if !legacy_root && doc.root.name != "Root" {
        return Err(Error::new(format!(
            "Expected <Root>, found <{}>",
            doc.root.name
        )));
    }
    let pnode = if legacy_root {
        &doc.root
    } else {
        doc.root
            .child("Protocol")
            .ok_or_else(|| Error::new("Missing <Protocol> element"))?
    };
    if pnode.text().is_some() {
        return Err(Error::new(
            "<Protocol> has text content instead of child elements",
        ));
    }

    let mut protocol = Protocol {
        doc: Some(DocInfo {
            bom: doc.bom,
            declaration: doc.declaration.clone(),
            newline: doc.newline.clone(),
            trailing_newline: doc.trailing_newline,
            legacy_root,
        }),
        ..Default::default()
    };
    for n in pnode.children() {
        let n = match n {
            Node::Comment { text } => {
                protocol
                    .layout
                    .push(LayoutItem::Comment { text: text.clone() });
                continue;
            }
            Node::Element(e) => e,
        };
        match n.name.as_str() {
            "Fluids" => {
                protocol.fluids = n
                    .children_named("Fluid")
                    .map(parse_fluid)
                    .collect::<Result<_>>()?
            }
            "Plates" => {
                protocol.plates = n
                    .children_named("Plate")
                    .map(parse_plate)
                    .collect::<Result<_>>()?;
                for (i, c) in n.children().iter().enumerate() {
                    if !matches!(c, Node::Element(e) if e.name == "Plate") {
                        protocol.plates_extra.push(PlatesExtra {
                            index: i,
                            node: c.clone(),
                        });
                    }
                }
                if let Some(t) = n.text() {
                    protocol.plates_text = Some(t.to_string());
                }
            }
            "HPDDPlates" => protocol.hpdd_plates = Some(n.clone()),
            "Backfills" => {
                protocol.backfills = n
                    .children_named("Backfill")
                    .map(parse_backfill)
                    .collect::<Result<_>>()?
            }
            "Revisions" => {
                protocol.revisions = n
                    .children_named("Revision")
                    .map(|r| Revision {
                        time: r.attr("Time").map(str::to_string),
                        user_id: r.attr("UserID").map(str::to_string),
                        attrs: Some(r.attrs.clone()),
                    })
                    .collect()
            }
            "Thumbnail" => protocol.thumbnail = Some(n.text_of()),
            _ => {
                if n.text().is_some() || (n.children().is_empty() && n.attrs.is_empty()) {
                    protocol.settings.insert(n.name.clone(), n.text_of());
                } else {
                    protocol.layout.push(LayoutItem::Raw {
                        name: n.name.clone(),
                        node: n.clone(),
                    });
                    continue;
                }
            }
        }
        protocol.layout.push(LayoutItem::Element {
            name: n.name.clone(),
        });
    }
    Ok(protocol)
}

fn parse_fluid(n: &Element) -> Result<Fluid> {
    let mut f = Fluid {
        id: int_of(n.attr("ID"), "Fluid ID")?,
        ..Default::default()
    };
    for c in n.children() {
        let Node::Element(c) = c else { continue };
        f.order.push(c.name.clone());
        let t = c.text_of();
        match c.name.as_str() {
            "Name" => f.name = Some(t),
            "ByVol" => f.by_vol = bool_of(&t),
            "Concentration" => {
                f.concentration = Some(to_number(&t));
                f.conc_text = Some(t);
            }
            "ConcentrationUnit" => f.concentration_unit = Some(t),
            "MaxVolume" => {
                f.max_volume = Some(to_number(&t));
                f.max_vol_text = Some(t);
            }
            "MaxVolumeUnit" => f.max_volume_unit = Some(t),
            "ClassID" => f.class_id = Some(int_of(Some(&t), "ClassID")?),
            "Color" => f.color = Some(int_of(Some(&t), "Color")?),
            "RootFluidID" => f.root_fluid_id = Some(int_of(Some(&t), "RootFluidID")?),
            "DilutionFactor" => {
                f.dilution_factor = Some(to_number(&t));
                f.dil_text = Some(t);
            }
            _ => {
                f.extra.insert(c.name.clone(), c.clone());
            }
        }
    }
    Ok(f)
}

fn parse_plate(n: &Element) -> Result<Plate> {
    let mut p = Plate::default();
    for c in n.children() {
        let Node::Element(c) = c else { continue };
        p.order.push(c.name.clone());
        let t = c.text_of();
        match c.name.as_str() {
            "PlateType" => p.plate_type = Some(t),
            "Rows" => p.rows = uint_of(Some(&t), "Rows")?,
            "Cols" => p.cols = uint_of(Some(&t), "Cols")?,
            "Name" => p.name = t,
            "AssayVolume" => {
                p.assay_volume = to_number(&t);
                p.assay_text = Some(t);
            }
            "DMSOLimit" => {
                p.dmso_limit = Some(to_number(&t));
                p.dmso_text = Some(t);
            }
            "DontShake" => p.dont_shake = bool_of(&t),
            "Deionize" => p.deionize = bool_of(&t),
            "PromptPlateLoad" => p.prompt_plate_load = bool_of(&t),
            "Wells" => {
                if let Some(text) = c.text() {
                    p.wells_text = Some(text.to_string());
                }
                for w in c.children_named("Well") {
                    let key = WellKey(
                        uint_of(w.attr("Row"), "Well Row")?,
                        uint_of(w.attr("Col"), "Well Col")?,
                    );
                    let mut m = WellFluids::new();
                    for fl in w.children_named("Fluid") {
                        m.insert(
                            int_of(fl.attr("ID"), "Well Fluid ID")?,
                            to_number(&fl.text_of()),
                        );
                    }
                    p.wells.insert(key, m);
                }
            }
            "Randomize" => {
                // Confirmed (fixtures/reference/t09-randomize.tdd): <Well R C ToR ToC/> maps each design well to the
                // well it is dispensed into; well contents stay at their design (non-random) positions.
                p.randomization = c
                    .children_named("Well")
                    .map(|w| {
                        Ok(RandomMap {
                            r: uint_of(w.attr("R"), "Randomize R")?,
                            c: uint_of(w.attr("C"), "Randomize C")?,
                            to_r: uint_of(w.attr("ToR"), "Randomize ToR")?,
                            to_c: uint_of(w.attr("ToC"), "Randomize ToC")?,
                        })
                    })
                    .collect::<Result<_>>()?;
                p.randomize_raw = Some(c.clone());
                p.randomize_snapshot = Some(p.randomization.clone());
            }
            _ => {
                p.extra.insert(c.name.clone(), c.clone());
            }
        }
    }
    Ok(p)
}

fn parse_backfill(n: &Element) -> Result<Backfill> {
    let mut b = Backfill {
        class_id: int_of(n.attr("ClassID"), "Backfill ClassID")?,
        kind: n
            .attr("Type")
            .ok_or_else(|| Error::new("Backfill without Type"))?
            .to_string(),
        param: n.attr("Param").map(to_number),
        param_text: n.attr("Param").map(str::to_string),
        wells: vec![],
    };
    if let Some(ws) = n.child("Wells") {
        for w in ws.children_named("Well") {
            b.wells.push(BackfillWell {
                p: uint_of(w.attr("P"), "Backfill well P")?,
                r: uint_of(w.attr("R"), "Backfill well R")?,
                c: uint_of(w.attr("C"), "Backfill well C")?,
            });
        }
    }
    Ok(b)
}

// ---------- write ----------

/// Numbers parsed from a file keep their original text if unchanged, so values that the
/// original software formatted differently from our formatter still round-trip exactly.
fn num_text(val: Option<f64>, orig: Option<&str>) -> Result<String> {
    // JS formatNumber(undefined) throws "Cannot write non-finite number undefined".
    let Some(val) = val else {
        return Err(Error::new("Cannot write non-finite number undefined"));
    };
    match orig {
        Some(t) if to_number(t) == val => Ok(t.to_string()),
        _ => format_number(val),
    }
}

fn leaf(name: &str, text: impl Into<String>) -> Node {
    Node::Element(Element::leaf(name, vec![], text))
}
fn opt_leaf(name: &str, text: Option<&String>) -> Node {
    // JS el(name, [], undefined) falls back to the default (no children): <Name />
    match text {
        Some(t) => leaf(name, t.clone()),
        None => Node::Element(Element::empty(name)),
    }
}
fn int_text(v: Option<i64>) -> String {
    v.map(|x| x.to_string())
        .unwrap_or_else(|| "undefined".into()) // JS String(undefined)
}

pub fn write_tdd(protocol: &Protocol) -> Result<String> {
    let mut kids: Vec<Node> = vec![];
    let default_layout;
    let layout = if protocol.layout.is_empty() {
        default_layout = default_layout_for(protocol);
        &default_layout
    } else {
        &protocol.layout
    };
    let mut emitted: HashSet<&str> = HashSet::new();
    for item in layout {
        match item {
            LayoutItem::Comment { text } => kids.push(Node::Comment { text: text.clone() }),
            LayoutItem::Raw { node, .. } => kids.push(Node::Element(node.clone())),
            LayoutItem::Element { name } => {
                if let Some(node) = protocol_element(protocol, name)? {
                    kids.push(node);
                }
                emitted.insert(name);
            }
        }
    }
    // settings added after parsing (not in layout) go before <Plates>
    for (k, v) in &protocol.settings {
        if emitted.contains(k.as_str()) {
            continue;
        }
        let node = leaf(k, v.clone());
        match kids
            .iter()
            .position(|n| matches!(n, Node::Element(e) if e.name == "Plates"))
        {
            Some(idx) => kids.insert(idx, node),
            None => kids.push(node),
        }
    }
    let pnode = Element::new("Protocol", vec![], kids);
    let legacy = protocol.doc.as_ref().is_some_and(|d| d.legacy_root);
    let root = if legacy {
        pnode
    } else {
        Element::new("Root", vec![], vec![Node::Element(pnode)])
    };
    let d = protocol.doc.clone().unwrap_or(DocInfo {
        bom: false,
        declaration: DEFAULT_DECLARATION.into(),
        newline: "\r\n".into(),
        trailing_newline: false,
        legacy_root: false,
    });
    Ok(write_xml(&XmlDoc {
        bom: d.bom,
        declaration: d.declaration,
        newline: d.newline,
        trailing_newline: d.trailing_newline,
        root,
    }))
}

fn default_layout_for(protocol: &Protocol) -> Vec<LayoutItem> {
    let mut items: Vec<LayoutItem> = DEFAULT_COMMENTS
        .iter()
        .map(|t| LayoutItem::Comment {
            text: t.to_string(),
        })
        .collect();
    for name in PROTOCOL_DEFAULT_ORDER {
        if name == "Version" && !protocol.settings.contains_key("Version") {
            continue;
        }
        items.push(LayoutItem::Element {
            name: name.to_string(),
        });
    }
    items
}

fn protocol_element(protocol: &Protocol, name: &str) -> Result<Option<Node>> {
    Ok(Some(match name {
        "Fluids" => Element::new(
            "Fluids",
            vec![],
            protocol
                .fluids
                .iter()
                .map(write_fluid)
                .collect::<Result<_>>()?,
        )
        .into(),
        "Plates" => {
            let mut kids: Vec<Node> = protocol
                .plates
                .iter()
                .map(write_plate)
                .collect::<Result<_>>()?;
            for PlatesExtra { index, node } in &protocol.plates_extra {
                kids.insert((*index).min(kids.len()), node.clone());
            }
            match (&protocol.plates_text, kids.is_empty()) {
                (Some(t), true) => leaf("Plates", t.clone()),
                _ => Element::new("Plates", vec![], kids).into(),
            }
        }
        "HPDDPlates" => protocol
            .hpdd_plates
            .clone()
            .unwrap_or_else(|| Element::empty("HPDDPlates"))
            .into(),
        "Backfills" => Element::new(
            "Backfills",
            vec![],
            protocol
                .backfills
                .iter()
                .filter(|b| !b.wells.is_empty())
                .map(write_backfill)
                .collect::<Result<_>>()?,
        )
        .into(),
        "Revisions" => Element::new(
            "Revisions",
            vec![],
            protocol
                .revisions
                .iter()
                .map(|r| {
                    let attrs = r.attrs.clone().unwrap_or_else(|| {
                        vec![
                            (
                                "Time".into(),
                                r.time.clone().unwrap_or_else(|| "undefined".into()),
                            ),
                            (
                                "UserID".into(),
                                r.user_id.clone().unwrap_or_else(|| "undefined".into()),
                            ),
                        ]
                    });
                    Element::new("Revision", attrs, vec![]).into()
                })
                .collect(),
        )
        .into(),
        "Thumbnail" => match &protocol.thumbnail {
            Some(t) => leaf("Thumbnail", t.clone()),
            None => return Ok(None),
        },
        _ => match protocol.settings.get(name) {
            Some(v) => leaf(name, v.clone()),
            None => return Ok(None),
        },
    }))
}

fn write_fluid(f: &Fluid) -> Result<Node> {
    let present = |k: &str| match k {
        "Color" => f.color.is_some(),
        "RootFluidID" => f.root_fluid_id.is_some(),
        "DilutionFactor" => f.dilution_factor.is_some(),
        _ => true,
    };
    let mut order: Vec<String> = if !f.order.is_empty() {
        f.order.clone()
    } else {
        FLUID_ORDER
            .iter()
            .filter(|k| present(k))
            .map(|k| k.to_string())
            .collect()
    };
    if f.color.is_some() && !order.iter().any(|k| k == "Color") {
        order.push("Color".into());
    }
    let mut kids = vec![];
    for k in &order {
        match k.as_str() {
            "Name" => kids.push(leaf("Name", f.name.clone().unwrap_or_default())),
            "ByVol" => kids.push(leaf("ByVol", bool_str(f.by_vol))),
            "Concentration" => kids.push(leaf(
                "Concentration",
                num_text(f.concentration, f.conc_text.as_deref())?,
            )),
            "ConcentrationUnit" => {
                kids.push(opt_leaf("ConcentrationUnit", f.concentration_unit.as_ref()))
            }
            "MaxVolume" => kids.push(leaf(
                "MaxVolume",
                num_text(f.max_volume, f.max_vol_text.as_deref())?,
            )),
            "MaxVolumeUnit" => kids.push(opt_leaf("MaxVolumeUnit", f.max_volume_unit.as_ref())),
            "ClassID" => kids.push(leaf("ClassID", int_text(f.class_id))),
            "Color" => {
                if let Some(c) = f.color {
                    kids.push(leaf("Color", c.to_string()))
                }
            }
            "RootFluidID" => {
                if let Some(r) = f.root_fluid_id {
                    kids.push(leaf("RootFluidID", r.to_string()))
                }
            }
            "DilutionFactor" => {
                if f.dilution_factor.is_some() {
                    kids.push(leaf(
                        "DilutionFactor",
                        num_text(f.dilution_factor, f.dil_text.as_deref())?,
                    ))
                }
            }
            other => {
                if let Some(e) = f.extra.get(other) {
                    kids.push(e.clone().into())
                }
            }
        }
    }
    Ok(Element::new("Fluid", vec![("ID".into(), f.id.to_string())], kids).into())
}

fn write_plate(p: &Plate) -> Result<Node> {
    let order: Vec<&str> = if !p.order.is_empty() {
        p.order.iter().map(String::as_str).collect()
    } else {
        PLATE_ORDER.to_vec()
    };
    let mut kids = vec![];
    for k in order {
        match k {
            "PlateType" => kids.push(opt_leaf("PlateType", p.plate_type.as_ref())),
            "Rows" => kids.push(leaf("Rows", p.rows.to_string())),
            "Cols" => kids.push(leaf("Cols", p.cols.to_string())),
            "Name" => kids.push(if !p.name.is_empty() {
                leaf("Name", p.name.clone())
            } else {
                Element::empty("Name").into()
            }),
            "AssayVolume" => kids.push(leaf(
                "AssayVolume",
                num_text(Some(p.assay_volume), p.assay_text.as_deref())?,
            )),
            "DMSOLimit" => kids.push(leaf(
                "DMSOLimit",
                num_text(p.dmso_limit, p.dmso_text.as_deref())?,
            )),
            "DontShake" => kids.push(leaf("DontShake", bool_str(p.dont_shake))),
            "Deionize" => kids.push(leaf("Deionize", bool_str(p.deionize))),
            "PromptPlateLoad" => kids.push(leaf("PromptPlateLoad", bool_str(p.prompt_plate_load))),
            "Wells" => {
                let ws = write_wells(p)?;
                kids.push(match (&p.wells_text, ws.is_empty()) {
                    (Some(t), true) => leaf("Wells", t.clone()),
                    _ => Element::new("Wells", vec![], ws).into(),
                });
            }
            "Randomize" => {
                if let (Some(raw), Some(snap)) = (&p.randomize_raw, &p.randomize_snapshot) {
                    if *snap == p.randomization {
                        kids.push(raw.clone().into());
                        continue;
                    }
                }
                let mut list = p.randomization.clone();
                list.sort_by_key(|m| (m.r, m.c)); // stable, as JS sort
                kids.push(
                    Element::new(
                        "Randomize",
                        vec![],
                        list.iter()
                            .map(|m| {
                                Element::new(
                                    "Well",
                                    vec![
                                        ("R".into(), m.r.to_string()),
                                        ("C".into(), m.c.to_string()),
                                        ("ToR".into(), m.to_r.to_string()),
                                        ("ToC".into(), m.to_c.to_string()),
                                    ],
                                    vec![],
                                )
                                .into()
                            })
                            .collect(),
                    )
                    .into(),
                );
            }
            other => {
                if let Some(e) = p.extra.get(other) {
                    kids.push(e.clone().into())
                }
            }
        }
    }
    Ok(Element::new("Plate", vec![], kids).into())
}

fn write_wells(p: &Plate) -> Result<Vec<Node>> {
    // Observed: wells row-major; empty wells omitted.
    let mut entries: Vec<(&WellKey, &WellFluids)> = p
        .wells
        .iter()
        .filter(|(_, m)| m.values().any(|&v| v != 0.0))
        .collect();
    entries.sort_by_key(|(k, _)| **k); // (row, col), stable
    entries
        .into_iter()
        .map(|(k, m)| {
            // Fluids inside a well keep the order in which they were applied (not sorted by ID):
            // t07-synergy3.tdd lists A, B, C = IDs 0, 2, 1. IndexMap insertion order preserves that.
            let kids = m
                .iter()
                .filter(|(_, &v)| v != 0.0)
                .map(|(id, &v)| {
                    Ok(Element::leaf(
                        "Fluid",
                        vec![("ID".into(), id.to_string())],
                        format_number(v)?,
                    )
                    .into())
                })
                .collect::<Result<_>>()?;
            Ok(Element::new(
                "Well",
                vec![
                    ("Row".into(), k.0.to_string()),
                    ("Col".into(), k.1.to_string()),
                ],
                kids,
            )
            .into())
        })
        .collect()
}

fn write_backfill(b: &Backfill) -> Result<Node> {
    let mut attrs = vec![
        ("ClassID".to_string(), b.class_id.to_string()),
        ("Type".to_string(), b.kind.clone()),
    ];
    if b.param.is_some() {
        attrs.push(("Param".into(), num_text(b.param, b.param_text.as_deref())?));
    }
    let mut ws = b.wells.clone();
    ws.sort_by_key(|w| (w.p, w.r, w.c));
    let wells = ws
        .iter()
        .map(|w| {
            Element::new(
                "Well",
                vec![
                    ("P".into(), w.p.to_string()),
                    ("R".into(), w.r.to_string()),
                    ("C".into(), w.c.to_string()),
                ],
                vec![],
            )
            .into()
        })
        .collect();
    Ok(Element::new(
        "Backfill",
        attrs,
        vec![Element::new("Wells", vec![], wells).into()],
    )
    .into())
}

// ---------- helpers ----------

/// Rows beyond Z (1536 plates) use AA, AB ... as in standard plate notation.
pub fn well_name(r: u32, c: u32) -> String {
    // JS String.fromCharCode takes the code modulo 2^16
    let ch = |code: u32| char::from_u32(code & 0xFFFF).unwrap_or('\u{FFFD}');
    let letters = if r < 26 {
        ch(65 + r).to_string()
    } else {
        format!("{}{}", ch(64 + r / 26), ch(65 + r % 26))
    };
    format!("{letters}{}", c as u64 + 1)
}

pub fn new_protocol() -> Protocol {
    Protocol {
        settings: DEFAULT_SETTINGS
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        ..Default::default()
    }
}
