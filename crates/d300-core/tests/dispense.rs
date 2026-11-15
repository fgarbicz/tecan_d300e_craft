//! Port of tests/dispense.test.js (the run-report case is tests/run_report.rs). Same cases and
//! tolerances (`close` is absolute there).
mod common;
use common::*;
use d300_core::dispense::*;
use d300_core::tdd::{Backfill, BackfillWell, Fluid, Plate, Protocol, WellFluids, WellKey};

fn dmso_fluid(s: f64, id: i64) -> Fluid {
    Fluid {
        id,
        name: Some("F".into()),
        by_vol: false,
        concentration: Some(s),
        class_id: Some(0),
        ..Default::default()
    }
}
fn plate(a: f64, limit: f64) -> Plate {
    Plate {
        assay_volume: a,
        dmso_limit: Some(limit),
        ..Default::default()
    }
}
fn req(pairs: &[(i64, f64)]) -> WellFluids {
    pairs.iter().copied().collect()
}
fn has(r: &WellResult, code: &str) -> bool {
    r.warnings.iter().any(|w| w.code() == code)
}

/// Guide p.89 Tabular Detail report (values read from a 300 dpi render of the figure, row A): A = 100 µL,
/// Fluid 1 = 10 mM in DMSO. [requested µM, reported volume nL, reported concentration µM, tol]
/// tol = half a unit in the last digit shown in the report.
const P89: [(f64, f64, f64, f64); 8] = [
    (50.0, 502.4, 49.98885599, 5e-9),
    (10.0, 100.0, 9.99000999, 5e-9),
    (2.511886, 25.2, 2.51936512, 5e-9),
    (0.6309573, 6.4, 0.639959043, 5e-10),
    (0.1584893, 1.58, 0.157997504, 5e-10),
    (0.03981072, 0.4, 0.03999984, 5e-9),
    (0.01, 0.1, 0.00999999, 5e-9),
    (0.0013, 0.013, 0.0013, 5e-5),
];

#[test]
fn guide_p89_report_example_volumes_and_dispensed_concentrations() {
    let pl = plate(100000.0, 0.01);
    let fl = [dmso_fluid(10000.0, 0)];
    let fluids = fluid_lookup(&fl);
    for (c, vol, disp, tol) in P89 {
        let r = compute_well(&req(&[(0, c)]), &fluids, &pl, 0.0, None);
        close(r.fluids[0].volume, vol, 1e-9, &format!("volume for {c} µM"));
        close(
            r.fluids[0].dispensed.unwrap(),
            disp,
            tol,
            &format!("dispensed conc for {c} µM"),
        );
    }
}

#[test]
fn guide_p89_multi_fluid_wells_total_volume_includes_all_dispensed_fluids() {
    let pl = plate(100000.0, 0.02);
    let fl = [
        dmso_fluid(10000.0, 1),
        dmso_fluid(10000.0, 2),
        dmso_fluid(10000.0, 3),
    ];
    let fluids = fluid_lookup(&fl);
    // A09: two fluids at 50 µM -> 505.2 nL each, total 101010.4, 50.01465196 µM
    let r = compute_well(&req(&[(1, 50.0), (2, 50.0)]), &fluids, &pl, 0.0, None);
    for x in &r.fluids {
        close(x.volume, 505.2, 1e-9, "A09 volume");
        close(x.dispensed.unwrap(), 50.01465196, 5e-9, "A09 conc");
    }
    close(r.total_volume, 101010.4, 1e-6, "A09 total");
    // A08: 50 µM + 0.0013 µM -> 502.4 + 0.013 nL, total 100502.413, 49.98884952 µM
    let r = compute_well(&req(&[(1, 50.0), (2, 0.0013)]), &fluids, &pl, 0.0, None);
    close(r.total_volume, 100502.413, 1e-6, "A08 total");
    close(
        r.fluids[0].dispensed.unwrap(),
        49.98884952,
        5e-9,
        "A08 conc",
    );
    close(
        r.fluids[1].dispensed.unwrap(),
        0.001293501,
        5e-10,
        "A08 low conc",
    );
}

#[test]
fn guide_valid_range_screenshots() {
    let r = |s, a| valid_range(&dmso_fluid(s, 0), &plate(a, 0.01), 1.0);
    close(r(10000.0, 200000.0).min, 0.00065, 1e-6, "10 mM, 200 µL min");
    close(r(5000.0, 200000.0).min, 0.000325, 1e-6, "5 mM, 200 µL min");
    close(r(10000.0, 100000.0).min, 0.0013, 1e-6, "10 mM, 100 µL min");
    close(r(10000.0, 50000.0).min, 0.0026, 1e-6, "10 mM, 50 µL min");
    close(r(10000.0, 200000.0).max, 100.0, 1e-9, "10 mM max at 1 %");
    close(r(5000.0, 200000.0).max, 50.0, 1e-9, "5 mM max at 1 %");
}

#[test]
fn guide_p30_tooltip_1_um_of_1_25_mm_in_200_ul() {
    let fl = [dmso_fluid(1250.0, 0)];
    let r = compute_well(
        &req(&[(0, 1.0)]),
        &fluid_lookup(&fl),
        &plate(200000.0, 0.01),
        0.0,
        None,
    );
    close(r.fluids[0].volume, 160.0, 1e-9, "volume");
    close(r.dmso_fraction * 100.0, 0.0799, 5e-5, "DMSO %");
    close(r.total_volume, 200160.0, 1e-6, "total");
}

#[test]
fn dmso_rounding_bands() {
    let c = fluid_class(Some(0));
    for (v, want) in [
        (0.013, 0.013),
        (0.016, 0.013),
        (0.018, 0.02),
        (1.585, 1.58),
        (3.59, 3.6),
        (6.31, 6.4),
        (502.51, 502.4),
    ] {
        close(
            round_volume(v, c).volume,
            want,
            1e-12,
            &format!("round {v}"),
        );
    }
    assert!(round_volume(0.005, c).below_min);
}

#[test]
fn dmso_limit_warning_fires_above_the_plate_limit() {
    let pl = plate(50000.0, 0.01);
    let fl = [dmso_fluid(1000.0, 0)];
    let fluids = fluid_lookup(&fl);
    assert!(!has(
        &compute_well(&req(&[(0, 9.0)]), &fluids, &pl, 0.0, None),
        "dmso_limit"
    ));
    assert!(has(
        &compute_well(&req(&[(0, 11.0)]), &fluids, &pl, 0.0, None),
        "dmso_limit"
    ));
}

#[test]
fn guide_p89_row_b_to_max_volume_normalization() {
    // Row B, Fluid 2 = 10 mM DMSO, A = 100 µL; B01 holds the class maximum (100 nL).
    // [well col, requested µM, fluid nL, normalization nL, total nL]
    let rows: [(u32, f64, f64, f64, f64); 5] = [
        (0, 10.0, 100.0, 0.0, 100100.0),
        (2, 0.6309573, 6.4, 93.6, 100100.0),
        (3, 0.1584893, 1.58, 98.4, 100099.98),
        (4, 0.03981072, 0.4, 99.6, 100100.0),
        // B06: the guide figure (older software) shows 100 nL (nearest step); D300e Control 4.0.1 rounds the
        // top-up DOWN (see the D3 run-report test), giving 99.6 nL. We follow 4.0.1.
        (5, 0.01, 0.1, 99.6, 100099.7),
    ];
    let mut pl = plate(100000.0, 0.01);
    for (c, conc, ..) in rows {
        pl.wells.insert(WellKey(1, c), req(&[(2, conc)]));
    }
    let protocol = Protocol {
        fluids: vec![Fluid {
            id: 2,
            by_vol: false,
            concentration: Some(10000.0),
            class_id: Some(0),
            ..Default::default()
        }],
        plates: vec![pl],
        backfills: vec![Backfill {
            class_id: 0,
            kind: "ToMaxVolume".into(),
            wells: rows
                .iter()
                .map(|&(c, ..)| BackfillWell { p: 0, r: 1, c })
                .collect(),
            ..Default::default()
        }],
        ..Default::default()
    };
    let res = &compute_protocol(&protocol)[0].wells;
    for (c, _, vol, norm, total) in rows {
        let r = &res[&WellKey(1, c)];
        close(
            r.fluids[0].volume,
            vol,
            1e-9,
            &format!("B{} fluid volume", c + 1),
        );
        close(
            r.normalization,
            norm,
            1e-9,
            &format!("B{} normalization", c + 1),
        );
        close(r.total_volume, total, 1e-6, &format!("B{} total", c + 1));
    }
    close(
        res[&WellKey(1, 3)].fluids[0].dispensed.unwrap(),
        0.157842189,
        1e-8,
        "B04 dispensed conc",
    );
}

#[test]
fn dmso_limit_normalizing_to_exactly_the_limit_is_not_flagged() {
    let fl = [dmso_fluid(1000.0, 0)];
    let fluids = fluid_lookup(&fl);
    let pl = plate(50000.0, 0.01);
    // 505.2 nL normalization -> 505.2 / 50505.2 = 1.00029 % (rounds to 1.000 %)
    assert!(!has(
        &compute_well(&WellFluids::new(), &fluids, &pl, 505.2, None),
        "dmso_limit"
    ));
    // 0.505 µM -> 25.6 nL + 485 nL normalization would be 1.01 %
    assert!(has(
        &compute_well(&req(&[(0, 10.2)]), &fluids, &pl, 0.0, None),
        "dmso_limit"
    ));
}

#[test]
fn priming_fluids_below_30_nl_are_flagged_scrap_well_values_reach_30_nl() {
    let fluids = vec![
        Fluid {
            id: 0,
            by_vol: false,
            concentration: Some(1000.0),
            class_id: Some(0),
            ..Default::default()
        },
        Fluid {
            id: 1,
            by_vol: false,
            concentration: Some(10000.0),
            class_id: Some(0),
            ..Default::default()
        },
    ];
    let mut pl = plate(50000.0, 0.01);
    pl.wells.insert(WellKey(1, 1), req(&[(0, 0.02), (1, 3.0)]));
    let protocol = Protocol {
        fluids: fluids.clone(),
        plates: vec![pl.clone()],
        ..Default::default()
    };
    let mut issues: Vec<i64> = priming_issues(&protocol, &compute_protocol(&protocol))[0]
        .lacking
        .iter()
        .map(|x| x.fluid_id)
        .collect();
    issues.sort();
    assert_eq!(issues, vec![0, 1]); // 1 nL and 15 nL
    let vals = scrap_well_values(&fluids, &pl, PRIMING_VOLUME);
    let r = compute_well(
        &vals.iter().copied().collect(),
        &fluid_lookup(&fluids),
        &pl,
        0.0,
        None,
    );
    for x in &r.fluids {
        assert!(x.volume >= PRIMING_VOLUME, "{}: {}", x.fluid_id, x.volume);
    }
    // the reference D3 file's scrap wells (A23 Bortezomib 0.6 µM, A24 MEN 6 µM) satisfy the rule
    let d3 = load("2026.08.28 synergy D3.tdd");
    let lack: Vec<_> = priming_issues(&d3, &compute_protocol(&d3))
        .into_iter()
        .flat_map(|x| x.lacking)
        .collect();
    assert!(lack.is_empty(), "{lack:?}");
}

#[test]
fn t05_all_five_normalization_types_reproduce_the_software_totals() {
    let p = load("t05-normalize.tdd");
    let kinds: Vec<&str> = p.backfills.iter().map(|b| b.kind.as_str()).collect();
    assert_eq!(
        kinds,
        [
            "ToMaxVolume",
            "ToVolume",
            "ToAssayVolumePct",
            "ToMaxTotalVolume",
            "ToTotalVolume"
        ]
    );
    let res = &compute_protocol(&p)[0].wells;
    let sum_row = |r: u32| {
        (0..24).fold(0.0, |s, c| {
            s + res
                .get(&WellKey(r, c))
                .map_or(0.0, |w| d300_core::jsnum::or0(Some(w.normalization)))
        }) / 1000.0
    };
    // Normalization panel showed DMSO 11.4 µL after row A, 16.2 after B, 22.3 after C, 29.5 after D+E.
    let (a, b, c, d, e) = (sum_row(0), sum_row(1), sum_row(2), sum_row(3), sum_row(4));
    close(a, 11.4, 0.05, "row A");
    close(a + b, 16.2, 0.05, "rows A-B");
    close(a + b + c, 22.3, 0.05, "rows A-C");
    close(a + b + c + d + e, 29.5, 0.05, "rows A-E");
    assert_eq!(d, 0.0);
    close(e, 7.2, 1e-9, "row E: 300 nL x 24");
}

#[test]
fn t10_fluid_classes_are_known() {
    // ClassIDs confirmed with T10: 0 DMSO, 1-3 aqueous, 4-6 aqueous+glycerol, 12 master mix (by volume only).
    let p = load("t10-classes.tdd");
    for f in &p.fluids {
        let id = f.class_id.unwrap();
        let cls = fluid_class(Some(id));
        assert_eq!(cls.id, id, "fluid {:?}: class {id} unknown", f.name);
    }
    assert!(
        fluid_class(Some(12)).by_volume_only
            && fluid_class(Some(4)).min_volume == 0.012
            && fluid_class(Some(3)).min_volume == 0.011
    );
    assert_eq!(fluid_class(Some(99)).id, 0); // unknown -> DMSO, as JS
}

#[test]
fn synergy_shares_the_dmso_limit_between_its_fluids_t06_t07() {
    let f = dmso_fluid(10000.0, 0);
    let pl = plate(50000.0, 0.01);
    close(valid_range(&f, &pl, 1.0).max, 100.0, 1e-12, "1 fluid");
    close(valid_range(&f, &pl, 2.0).max, 50.0, 1e-12, "2 fluids");
    close(
        valid_range(&f, &pl, 3.0).max,
        33.3333333333,
        1e-9,
        "3 fluids",
    );
    close(valid_range(&f, &pl, 3.0).min, 0.0026, 1e-6, "min unchanged");
}
