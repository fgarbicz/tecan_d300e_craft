//! End-to-end: the protocol of tools/roundtrip/make_protocol.mjs built with the Rust engine (ops +
//! writer, no inherited layout) is byte-identical to the JS output and to
//! fixtures/reference/roundtrip/mac-made-1.tdd (which D300e Control opened and re-saved unchanged).
mod common;
use common::*;
use d300_core::dispense::{scrap_well_values, PRIMING_VOLUME};
use d300_core::ops::*;
use d300_core::tdd::{new_protocol, write_tdd, BackfillWell};

fn build() -> String {
    let mut p = new_protocol();
    let fields = |name: &str, c: f64| FluidFields {
        name: Some(name.into()),
        concentration: Some(c),
        concentration_unit: Some("mM".into()),
        class_id: Some(0),
        ..Default::default()
    };
    let a = add_fluid(&mut p, &fields("DrugA", 10000.0)).clone();
    let b = add_fluid(&mut p, &fields("DrugB", 5000.0)).clone();
    let ad = diluted_fluid(&mut p, &a, 100.0).clone();
    // plate 1: titration of DrugA across row B (12 levels, 10 -> 0.001 µM), DrugB set value in row C
    let mut p1 = new_plate(&PlateTemplate {
        plate_type: Some("Default384".into()),
        name: Some("Mac titration".into()),
        ..Default::default()
    })
    .unwrap();
    let cells: Vec<Cell> = (0..12).map(|i| (1, i + 1)).collect();
    let levels = titration_levels(&TitrationOptions {
        mode: TitrationMode::HighLow,
        high: Some(10.0),
        low: Some(0.003),
        levels: 12,
        distribution: Distribution::Log,
        ..Default::default()
    })
    .unwrap();
    apply_titration(
        &mut p1,
        &cells,
        a.id,
        &levels,
        &TitrationPlacement::default(),
    )
    .unwrap();
    for c in 1..=6 {
        set_well(&mut p1, 2, c, b.id, 1.5);
    }
    set_well(&mut p1, 3, 1, ad.id, 0.0005);
    for (id, v) in scrap_well_values(&[&a, &b, &ad], &p1, PRIMING_VOLUME) {
        set_well(&mut p1, 0, 23, id, v);
    }
    p.plates.push(p1);
    // plate 2: synergy 6x6 with zeros (as D300e builds it)
    let lv = |id: i64, order: AxisOrder, high: f64, low: f64| SynergyFluid {
        fluid_id: id,
        include_zero: true,
        order,
        levels: synergy_levels(
            &TitrationOptions {
                mode: TitrationMode::HighLow,
                high: Some(high),
                low: Some(low),
                levels: 6,
                distribution: Distribution::Log,
                ..Default::default()
            },
            true,
        )
        .unwrap(),
    };
    let p2 = build_synergy(&SynergySpec {
        kind: SynergyType::Abc,
        layout: SynergyLayout::Single,
        plate: PlateTemplate {
            plate_type: Some("Default384".into()),
            assay_volume: Some(50000.0),
            dmso_limit: Some(0.01),
            ..Default::default()
        },
        fluids: vec![
            lv(a.id, AxisOrder::HighFirst, 20.0, 0.02),
            lv(b.id, AxisOrder::LowFirst, 20.0, 0.02),
        ],
        ..Default::default()
    })
    .unwrap()
    .remove(0);
    let p2_wells: Vec<BackfillWell> = p2
        .wells
        .keys()
        .map(|k| BackfillWell {
            p: 1,
            r: k.0,
            c: k.1,
        })
        .collect();
    p.plates.push(p2);
    add_normalization(&mut p, 0, "ToMaxVolume", None, &p2_wells);
    add_normalization(
        &mut p,
        0,
        "ToAssayVolumePct",
        Some(0.005),
        &cells
            .iter()
            .map(|&(r, c)| BackfillWell { p: 0, r, c })
            .collect::<Vec<_>>(),
    );
    write_tdd(&p).unwrap()
}

#[test]
fn rust_built_protocol_equals_the_d300e_round_trip_fixture() {
    let mine = build();
    let fixture = std::fs::read(reference_dir().join("roundtrip").join("mac-made-1.tdd")).unwrap();
    assert!(
        mine.as_bytes() == fixture.as_slice(),
        "differs from mac-made-1.tdd"
    );
}

#[test]
fn rust_built_protocol_equals_the_js_built_protocol() {
    let out = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("make_protocol_js.tdd");
    let Some(_) = run_node(
        &["tools/roundtrip/make_protocol.mjs", out.to_str().unwrap()],
        None,
    ) else {
        return;
    };
    assert!(
        build().as_bytes() == std::fs::read(&out).unwrap().as_slice(),
        "differs from node tools/roundtrip/make_protocol.mjs"
    );
}
