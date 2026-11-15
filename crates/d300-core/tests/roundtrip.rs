//! Byte-identical round-trips of every reference .tdd (port of tests/xmltree.test.js and the round-trip
//! part of tests/tdd.test.js, extended to tecan_examples/ and roundtrip/ at tree level, plus JSON).
mod common;
use common::*;
use d300_core::tdd::{parse_tdd, write_tdd, Protocol};
use d300_core::xmltree::{parse_xml, write_xml};

fn each_file(f: impl Fn(&str, &[u8], &str)) {
    let files = reference_tdd_files();
    assert!(
        files.len() >= 14,
        "expected at least 14 reference files, found {}",
        files.len()
    );
    for p in files {
        let bytes = std::fs::read(&p).unwrap();
        let text = read_text(&p);
        f(&rel(&p), &bytes, &text);
    }
}

#[test]
fn tree_round_trip_is_byte_identical() {
    each_file(|name, bytes, text| {
        let out = write_xml(&parse_xml(text).unwrap_or_else(|e| panic!("{name}: {e}")));
        assert!(out.as_bytes() == bytes, "tree round-trip differs: {name}");
    });
}

#[test]
fn model_round_trip_is_byte_identical() {
    each_file(|name, bytes, text| {
        let out = write_tdd(&parse_tdd(text).unwrap_or_else(|e| panic!("{name}: {e}"))).unwrap();
        assert!(out.as_bytes() == bytes, "model round-trip differs: {name}");
    });
}

#[test]
fn model_round_trip_survives_reformatting_of_every_number() {
    // Drop the original text of all numbers so the formatter has to reproduce them.
    each_file(|name, _bytes, text| {
        let mut p = parse_tdd(text).unwrap();
        for f in &mut p.fluids {
            f.conc_text = None;
            f.max_vol_text = None;
            f.dil_text = None;
        }
        for pl in &mut p.plates {
            pl.assay_text = None;
            pl.dmso_text = None;
        }
        for b in &mut p.backfills {
            b.param_text = None;
        }
        assert!(
            write_tdd(&p).unwrap() == text,
            "re-formatted round-trip differs: {name}"
        );
    });
}

#[test]
fn json_round_trip_of_the_model_is_lossless() {
    // The model is exchanged as JSON with a UI: protocol -> JSON -> protocol must still write the same bytes.
    each_file(|name, bytes, text| {
        let p = parse_tdd(text).unwrap();
        let json = serde_json::to_string(&p).unwrap();
        let back: Protocol = serde_json::from_str(&json).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(back, p, "{name}: model changed through JSON");
        assert!(
            write_tdd(&back).unwrap().as_bytes() == bytes,
            "{name}: JSON round-trip changes the file"
        );
    });
}

#[test]
fn bom_and_legacy_root_are_preserved() {
    let p = load("tecan_examples/384 Four Corners Protocol.tdd");
    let d = p.doc.as_ref().unwrap();
    assert!(d.bom && d.legacy_root && d.newline == "\r\n");
    assert_eq!(p.plates_extra.len(), 1, "<Plates><Mode> kept");
}
