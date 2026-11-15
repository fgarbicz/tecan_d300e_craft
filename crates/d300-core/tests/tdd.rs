//! Port of tests/tdd.test.js (round-trip cases are in tests/roundtrip.rs).
mod common;
use common::*;
use d300_core::ops::diluted_fluid;
use d300_core::tdd::{format_number, new_protocol, parse_tdd, write_tdd, WellKey};

#[test]
fn format_number_matches_dotnet_g13_conventions() {
    let cases: [(f64, &str); 15] = [
        (0.0, "0"),
        (6.0, "6"),
        (0.02, "0.02"),
        (1.0 / 98.0, "0.01020408163265"),
        (0.0009680051649410, "0.000968005164941"),
        (50000.0, "50000"),
        (0.01, "0.01"),
        (1e-4, "0.0001"),
        (1e-5, "1E-05"),
        (1e-6, "1E-06"),
        (1.5e-7, "1.5E-07"),
        (1e13, "1E+13"),
        (9.99999999999999, "10"),
        (-0.5, "-0.5"),
        (1.0 / 3.0, "0.3333333333333"),
    ];
    for (x, s) in cases {
        assert_eq!(format_number(x).unwrap(), s, "formatNumber({x})");
    }
    assert!(format_number(f64::NAN).is_err());
}

#[test]
fn a_new_empty_protocol_writes_valid_structure() {
    let out = write_tdd(&new_protocol()).unwrap();
    assert!(out.starts_with("<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n<Root>\r\n  <Protocol>\r\n    <!--Protocol files"), "{out}");
    assert!(out.contains("<Fluids />"));
    assert!(!out.ends_with("\r\n"));
    assert_eq!(
        parse_tdd(&out)
            .unwrap()
            .settings
            .get("Version")
            .map(String::as_str),
        Some("4")
    );
}

#[test]
fn t01_stock_units_13_digit_values_exponent_form_diluted_fluid() {
    let p = load("t01-setvalue-units.tdd");
    // "DMSO @ 10.0 mM" in the UI is stored as 10000 (µM) with display unit mM
    assert_eq!(p.fluids[0].concentration, Some(10000.0));
    assert_eq!(p.fluids[0].concentration_unit.as_deref(), Some("mM"));
    // 1:300 dilution: concentration in µM, RootFluidID/DilutionFactor recorded
    assert_eq!(p.fluids[1].name.as_deref(), Some("Fluid 1 - 1:300"));
    assert_eq!(p.fluids[1].root_fluid_id, Some(0));
    assert_eq!(p.fluids[1].dilution_factor, Some(300.0));
    assert_eq!(format_number(10000.0 / 300.0).unwrap(), "33.33333333333");
    let w = &p.plates[0].wells;
    assert_eq!(w[&WellKey(0, 1)][&0], 33.33333333333);
    assert_eq!(w[&WellKey(0, 12)][&1], 1e-5);
}

#[test]
fn a_diluted_fluid_created_by_the_app_is_written_like_d300e_control_writes_it() {
    let t01 = read_text(&reference_dir().join("t01-setvalue-units.tdd"));
    let reference = parse_tdd(&t01).unwrap();
    let mut mine = new_protocol();
    let mut f0 = reference.fluids[0].clone();
    f0.order.clear(); // { ...ref.fluids[0], _order: undefined }
    mine.fluids.push(f0.clone());
    diluted_fluid(&mut mine, &f0, 300.0);
    let block = |txt: &str| {
        txt.split("<Fluids>")
            .nth(1)
            .unwrap()
            .split("</Fluids>")
            .next()
            .unwrap()
            .to_string()
    };
    assert_eq!(block(&write_tdd(&mine).unwrap()), block(&t01));
}

#[test]
fn negative_control_a_changed_value_changes_the_bytes() {
    // The round-trip tests compare bytes; prove the comparison sees a single changed digit.
    let src = read_text(&reference_dir().join("t01-setvalue-units.tdd"));
    let mut p = parse_tdd(&src).unwrap();
    *p.plates[0]
        .wells
        .get_mut(&WellKey(0, 1))
        .unwrap()
        .get_mut(&0)
        .unwrap() = 33.33333333334;
    let out = write_tdd(&p).unwrap();
    assert_ne!(out, src);
    assert_eq!(out.len(), src.len());
}

#[test]
fn empty_elements_round_trip_as_self_closing() {
    // Empty <Name /> and unknown empty protocol-level elements come back as written (fixed; previously <X></X>).
    let src = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n<Root>\r\n  <Protocol>\r\n    <Version>4</Version>\r\n    <Foo />\r\n    <Fluids>\r\n      <Fluid ID=\"0\">\r\n        <Name />\r\n      </Fluid>\r\n    </Fluids>\r\n  </Protocol>\r\n</Root>";
    assert_eq!(write_tdd(&parse_tdd(src).unwrap()).unwrap(), src);
}
