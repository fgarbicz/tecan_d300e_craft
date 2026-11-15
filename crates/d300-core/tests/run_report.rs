//! The D300e Control 4.0.1 run report of the D3 protocol: every dispense is reproduced.
//! Port of tools/compare/compare_report.py (same columns, well-name normalisation, tolerances and the
//! rule for plates whose normalization was planned but not dispensed because the run was aborted),
//! fed by the Rust engine instead of tools/compare/engine_dump.mjs.
mod common;
use common::*;
use quick_xml::events::Event;
use quick_xml::name::ResolveResult;
use quick_xml::NsReader;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

const NS: &[u8] = b"urn:schemas-microsoft-com:office:spreadsheet";

/// A cell as ElementTree sees it: `d.text` (None for an empty <Data>), or "" when the cell has no <Data>.
type Cell = Option<String>;

/// Rows of the named worksheets, like compare_report.py's sheet(): every <Row> under the worksheet,
/// its direct <Cell> children, ss:Index padding with '', the first direct <Data> child's leading text.
fn sheets(xml: &str, wanted: &[&str]) -> HashMap<String, Vec<Vec<Cell>>> {
    let mut r = NsReader::from_str(xml);
    r.config_mut().expand_empty_elements = true;
    let mut out: HashMap<String, Vec<Vec<Cell>>> = HashMap::new();
    let mut depth = 0usize;
    let mut ws: Option<(String, usize)> = None;
    let mut row: Option<(Vec<Cell>, usize)> = None;
    let mut cell: Option<(usize, Option<Cell>)> = None; // (depth, data text if a <Data> was seen)
    let mut data: Option<(usize, Option<String>, bool)> = None; // (depth, text, child seen)
    let is_ss = |res: &ResolveResult, local: &[u8], want: &[u8]| {
        matches!(res, ResolveResult::Bound(ns) if ns.as_ref() == NS) && local == want
    };
    loop {
        let (res, ev) = r.read_resolved_event().unwrap();
        match ev {
            Event::Start(e) => {
                depth += 1;
                let local = e.local_name().as_ref().to_vec();
                if let Some((_, _, child)) = data.as_mut() {
                    *child = true; // ElementTree .text stops at the first child element
                }
                if is_ss(&res, &local, b"Worksheet") {
                    let mut name = None;
                    for a in e.attributes() {
                        let a = a.unwrap();
                        let (ares, alocal) = r.resolver().resolve_attribute(a.key);
                        if is_ss(&ares, alocal.as_ref(), b"Name") {
                            name = Some(
                                a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                                    .unwrap()
                                    .into_owned(),
                            );
                        }
                    }
                    if let Some(n) =
                        name.filter(|n| wanted.contains(&n.as_str()) && !out.contains_key(n))
                    {
                        ws = Some((n, depth));
                    }
                } else if ws.is_some() && is_ss(&res, &local, b"Row") && row.is_none() {
                    row = Some((vec![], depth));
                } else if let (Some((cells, rd)), true) =
                    (row.as_mut(), is_ss(&res, &local, b"Cell"))
                {
                    if depth == *rd + 1 {
                        for a in e.attributes() {
                            let a = a.unwrap();
                            let (ares, alocal) = r.resolver().resolve_attribute(a.key);
                            if is_ss(&ares, alocal.as_ref(), b"Index") {
                                let idx: i64 = a
                                    .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                                    .unwrap()
                                    .trim()
                                    .parse()
                                    .unwrap();
                                let pad = idx - 1 - cells.len() as i64;
                                for _ in 0..pad.max(0) {
                                    cells.push(Some(String::new()));
                                }
                            }
                        }
                        cell = Some((depth, None));
                    }
                } else if let (Some((cd, seen)), true) =
                    (cell.as_mut(), is_ss(&res, &local, b"Data"))
                {
                    if depth == *cd + 1 && seen.is_none() && data.is_none() {
                        data = Some((depth, None, false));
                    }
                }
            }
            Event::Text(t) => {
                if let Some((_, text, false)) = data.as_mut() {
                    let s = t.decode().unwrap().replace("\r\n", "\n");
                    text.get_or_insert_with(String::new).push_str(&s);
                }
            }
            Event::GeneralRef(g) => {
                if let Some((_, text, false)) = data.as_mut() {
                    let ch = match g.resolve_char_ref().unwrap() {
                        Some(c) => c.to_string(),
                        None => match g.decode().unwrap().as_ref() {
                            "amp" => "&".into(),
                            "lt" => "<".into(),
                            "gt" => ">".into(),
                            "quot" => "\"".into(),
                            "apos" => "'".into(),
                            other => panic!("unknown entity &{other};"),
                        },
                    };
                    text.get_or_insert_with(String::new).push_str(&ch);
                }
            }
            Event::End(_) => {
                if let Some((dd, text, _)) = data.as_ref() {
                    if *dd == depth {
                        let text = text.clone();
                        data = None;
                        if let Some((_, seen)) = cell.as_mut() {
                            *seen = Some(text);
                        }
                    }
                }
                if let Some((cd, seen)) = cell.as_ref() {
                    if *cd == depth {
                        let v = seen.clone().unwrap_or(Some(String::new()));
                        row.as_mut().unwrap().0.push(v);
                        cell = None;
                    }
                }
                if let Some((_, rd)) = row.as_ref() {
                    if *rd == depth {
                        let (cells, _) = row.take().unwrap();
                        out.entry(ws.as_ref().unwrap().0.clone())
                            .or_default()
                            .push(cells);
                    }
                }
                if let Some((n, wd)) = ws.as_ref() {
                    if *wd == depth {
                        out.entry(n.clone()).or_default();
                        ws = None;
                    }
                }
                depth -= 1;
            }
            Event::Eof => break,
            _ => {}
        }
    }
    out
}

fn s(c: &Cell) -> &str {
    c.as_deref().unwrap_or("")
}
/// Python truthiness of a cell (None and '' are false).
fn t(c: &Cell) -> bool {
    !s(c).is_empty()
}

/// A1 / A01 -> A1 (re.match(r'([A-Z]+)0*(\d+)$')).
fn norm_well(w: &str) -> String {
    let letters: String = w.chars().take_while(|c| c.is_ascii_uppercase()).collect();
    let digits = &w[letters.len()..];
    assert!(
        !letters.is_empty() && !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()),
        "bad well name {w:?}"
    );
    let trimmed = digits.trim_start_matches('0');
    format!(
        "{letters}{}",
        if trimmed.is_empty() { "0" } else { trimmed }
    )
}

#[derive(Debug, Default, PartialEq)]
struct Stats {
    rows: usize,
    vol_ok: usize,
    total_ok: usize,
    conc_ok: usize,
    missing_in_engine: usize,
    undispensed_norm_plates: Vec<usize>,
    extra_engine_rows: usize,
    per_plate: BTreeMap<usize, [usize; 5]>, // rows, vol, total, conc, norm_rows
    bad: Vec<String>,
}

type Key = (usize, String, DumpFluid);

fn compare(mine: &[DumpRow], fluids_sheet: &[Vec<Cell>], td: &[Vec<Cell>]) -> Stats {
    let mut fluid_names: HashMap<String, i64> = HashMap::new();
    for r in &fluids_sheet[1..] {
        if r.is_empty() || !t(&r[0]) || !s(&r[0]).chars().all(|c| c.is_ascii_digit()) {
            break;
        }
        fluid_names.insert(s(&r[1]).to_string(), s(&r[0]).parse().unwrap());
    }
    let norm_ids: HashSet<i64> = fluid_names
        .iter()
        .filter(|(k, _)| k.ends_with("normalization"))
        .map(|(_, v)| *v)
        .collect();
    assert!(
        !norm_ids.is_empty(),
        "no normalization fluid in the Fluids sheet"
    );
    let mut idx: HashMap<Key, &DumpRow> = HashMap::new();
    for m in mine {
        idx.insert((m.plate, m.well.clone(), m.fluid), m);
    }
    let mut st = Stats::default();
    // plates whose report has no normalization rows although the protocol normalizes them (run aborted)
    let report_norm_plates: BTreeSet<usize> = td[1..]
        .iter()
        .filter(|r| r.len() > 9 && t(&r[1]) && s(&r[9]).ends_with("normalization"))
        .map(|r| s(&r[1]).trim().parse().unwrap())
        .collect();
    let engine_norm_plates: BTreeSet<usize> = mine
        .iter()
        .filter(|m| m.fluid == DumpFluid::Norm)
        .map(|m| m.plate)
        .collect();
    let undispensed: BTreeSet<usize> = engine_norm_plates
        .difference(&report_norm_plates)
        .copied()
        .collect();
    st.undispensed_norm_plates = undispensed.iter().copied().collect();
    let mut seen: HashSet<Key> = HashSet::new();
    let fnum = |c: &Cell| -> f64 {
        s(c).trim()
            .parse()
            .unwrap_or_else(|_| panic!("not a number: {c:?}"))
    };
    for r in &td[1..] {
        if r.len() < 18 || !t(&r[1]) {
            continue;
        }
        let plate: usize = s(&r[1]).trim().parse().unwrap();
        let well = norm_well(s(&r[2]));
        let fluid: i64 = s(&r[8]).trim().parse().unwrap();
        let (vol, conc, total) = (
            fnum(&r[15]),
            if t(&r[13]) { Some(fnum(&r[13])) } else { None },
            fnum(&r[17]),
        );
        let key: Key = (
            plate,
            well,
            if norm_ids.contains(&fluid) {
                DumpFluid::Norm
            } else {
                DumpFluid::Fluid(fluid)
            },
        );
        seen.insert(key.clone());
        let Some(m) = idx.get(&key) else {
            st.missing_in_engine += 1;
            st.bad.push(format!("missing {key:?} {vol}"));
            continue;
        };
        let conc_ok = |mc: Option<f64>, c: f64| {
            mc.is_some_and(|mc| (mc - c).abs() <= 1e-9 * c.abs().max(1.0) + 5e-12)
        };
        let ok_v = (m.volume - vol).abs() < 1e-6;
        let mut ok_t = (m.total - total).abs() < 1e-6;
        let mut ok_c = match conc {
            None => true,
            Some(c) => conc_ok(m.conc, c),
        };
        if undispensed.contains(&plate) && !ok_t {
            // normalization planned but not dispensed (aborted run): report total excludes it
            let t2 = m.total - m.norm;
            ok_t = (t2 - total).abs() < 1e-6;
            if let (Some(mc), Some(c)) = (m.conc, conc) {
                ok_c = conc_ok(Some(mc * m.total / t2), c);
            }
        }
        st.rows += 1;
        st.vol_ok += ok_v as usize;
        st.total_ok += ok_t as usize;
        st.conc_ok += ok_c as usize;
        let pc = st.per_plate.entry(plate).or_default();
        pc[0] += 1;
        pc[1] += ok_v as usize;
        pc[2] += ok_t as usize;
        pc[3] += ok_c as usize;
        pc[4] += (key.2 == DumpFluid::Norm) as usize;
        if !(ok_v && ok_t && ok_c) && st.bad.len() < 15 {
            st.bad.push(format!(
                "{key:?} report {vol} {conc:?} {total} engine {} {:?} {}",
                m.volume, m.conc, m.total
            ));
        }
    }
    st.extra_engine_rows = idx.keys().filter(|k| !seen.contains(*k)).count();
    st
}

#[test]
fn d300e_run_report_every_dispense_of_the_d3_protocol_is_reproduced() {
    let rep = read_text(
        &reference_dir()
            .join("reports")
            .join("2026.08.28 synergy D3.xml"),
    );
    let sh = sheets(&rep, &["Fluids", "Tabular Detail"]);
    let td = &sh["Tabular Detail"];
    let fl = &sh["Fluids"];
    assert_eq!(s(&td[0][0]), "Plate ID", "header of Tabular Detail");
    assert_eq!(s(&td[0][15]), "Dispensed Volume");
    assert_eq!(s(&td[0][17]), "Total Well Volume");
    let mine = engine_dump(&load("2026.08.28 synergy D3.tdd"));
    let st = compare(&mine, fl, td);
    println!("{st:?}");
    // Same figures as `python3 -I tools/compare/compare_report.py` prints for the JS engine.
    assert_eq!(
        (st.rows, st.vol_ok, st.total_ok, st.conc_ok),
        (5752, 5752, 5752, 5752),
        "{:#?}",
        st.bad
    );
    assert_eq!(st.missing_in_engine, 0);
    assert_eq!(st.undispensed_norm_plates, vec![3, 4, 5, 6, 7, 8]);
    assert_eq!(st.extra_engine_rows, 1688);
    let per: Vec<(usize, usize, usize)> =
        st.per_plate.iter().map(|(p, c)| (*p, c[0], c[4])).collect();
    assert_eq!(
        per,
        vec![
            (1, 814, 268),
            (2, 814, 268),
            (3, 546, 0),
            (4, 545, 0),
            (5, 545, 0),
            (6, 545, 0),
            (7, 545, 0),
            (8, 545, 0),
            (9, 853, 308)
        ]
    );
    for (p, c) in &st.per_plate {
        assert!(
            c[0] == c[1] && c[0] == c[2] && c[0] == c[3],
            "plate {p}: {c:?}"
        );
    }

    // Negative control: the comparison must notice one wrong volume and one wrong concentration.
    let mut broken = mine.clone();
    let i = broken
        .iter()
        .position(|m| m.plate == 9 && m.fluid != DumpFluid::Norm && m.conc.is_some())
        .unwrap();
    broken[i].volume += 0.4;
    let j = broken
        .iter()
        .position(|m| m.plate == 1 && m.conc.is_some_and(|c| c > 1.0))
        .unwrap();
    broken[j].conc = broken[j].conc.map(|c| c * (1.0 + 1e-8));
    let st2 = compare(&broken, fl, td);
    assert_eq!((st2.rows, st2.vol_ok, st2.conc_ok), (5752, 5751, 5751));
}
