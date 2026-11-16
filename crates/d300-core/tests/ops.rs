//! Port of tests/ops.test.js (same cases and tolerances; `close` is relative there).
mod common;
use common::*;
use d300_core::ops::*;
use d300_core::tdd::{parse_tdd, write_tdd, BackfillWell, Fluid, Plate, Protocol, WellKey};
use std::collections::BTreeSet;

fn close(a: f64, b: f64, rel: f64, msg: &str) {
    close_rel(a, b, rel, msg)
}
fn hl(high: f64, low: f64, levels: usize, distribution: Distribution) -> TitrationOptions {
    TitrationOptions {
        mode: TitrationMode::HighLow,
        high: Some(high),
        low: Some(low),
        levels,
        distribution,
        ..Default::default()
    }
}
fn plate_t(ty: &str) -> PlateTemplate {
    PlateTemplate {
        plate_type: Some(ty.into()),
        ..Default::default()
    }
}
fn v(p: &Plate, r: u32, c: u32, f: i64) -> f64 {
    *p.wells
        .get(&WellKey(r, c))
        .unwrap_or_else(|| panic!("no well {r},{c}"))
        .get(&f)
        .unwrap_or_else(|| panic!("no fluid {f} in {r},{c}"))
}

#[test]
fn log_titration_matches_guide_p98_data() {
    let got = titration_levels(&hl(100.0, 0.0013, 6, Distribution::Log)).unwrap();
    for (i, want) in [100.0, 10.53874, 1.11065, 0.117049, 0.012335, 0.0013]
        .iter()
        .enumerate()
    {
        close(got[i], *want, 5e-5, &format!("level {i}"));
    }
}

#[test]
fn dilution_and_fractional_log_titrations() {
    let o = TitrationOptions {
        mode: TitrationMode::High,
        high: Some(8.0),
        levels: 4,
        distribution: Distribution::Dilution,
        factor: Some(2.0),
        ..Default::default()
    };
    assert_eq!(titration_levels(&o).unwrap(), vec![8.0, 4.0, 2.0, 1.0]);
    let o = TitrationOptions {
        mode: TitrationMode::Low,
        low: Some(1.0),
        levels: 3,
        distribution: Distribution::Dilution,
        factor: Some(3.0),
        ..Default::default()
    };
    assert_eq!(titration_levels(&o).unwrap(), vec![9.0, 3.0, 1.0]);
    let o = TitrationOptions {
        mode: TitrationMode::High,
        high: Some(10.0),
        levels: 3,
        distribution: Distribution::HalfLog,
        ..Default::default()
    };
    close(titration_levels(&o).unwrap()[2], 1.0, 1e-12, "half log");
    let o = TitrationOptions {
        mode: TitrationMode::High,
        high: Some(1.0),
        levels: 5,
        distribution: Distribution::Linear,
        increment: Some(0.5),
        ..Default::default()
    };
    assert!(titration_levels(&o).is_err());
}

#[test]
fn fluid_shift_extend_both_guide_examples() {
    let fluid = Fluid {
        concentration: Some(5000.0),
        class_id: Some(0),
        ..Default::default()
    };
    let plate = Plate {
        assay_volume: 200000.0,
        dmso_limit: Some(0.01),
        ..Default::default()
    };
    assert_eq!(
        suggest_shift(&fluid, &plate, 1.0, 0.0001),
        Some(ShiftSuggestion::Shift { factor: 4.0 })
    );
    assert_eq!(
        suggest_shift(&fluid, &plate, 5.0, 0.00001),
        Some(ShiftSuggestion::Extend { factor: 40.0 })
    );
    assert_eq!(suggest_shift(&fluid, &plate, 5.0, 0.01), None);
}

#[test]
fn titration_placement_with_replicates() {
    let mut p = new_plate(&plate_t("Default96")).unwrap();
    let cells: Vec<Cell> = (0..6).map(|c| (0, c)).collect();
    let o = TitrationPlacement {
        replicates: 2,
        pattern: TitrationPattern::RowsTL,
        ..Default::default()
    };
    apply_titration(&mut p, &cells, 0, &[10.0, 1.0, 0.1], &o).unwrap();
    assert_eq!(
        (0..6).map(|c| v(&p, 0, c, 0)).collect::<Vec<_>>(),
        vec![10.0, 10.0, 1.0, 1.0, 0.1, 0.1]
    );
    let o = TitrationPlacement {
        replicates: 2,
        ..Default::default()
    };
    assert!(apply_titration(&mut p, &cells[..5], 0, &[1.0, 2.0], &o).is_err());
}

#[test]
fn synergy_a_x_b_6x6_grid_with_zeros() {
    let plates = build_synergy(&SynergySpec {
        kind: SynergyType::Abc,
        layout: SynergyLayout::Single,
        plate: plate_t("Default96"),
        fluids: vec![
            SynergyFluid {
                fluid_id: 0,
                levels: vec![5.0, 4.0, 3.0, 2.0, 1.0],
                include_zero: true,
                ..Default::default()
            },
            SynergyFluid {
                fluid_id: 1,
                levels: vec![50.0, 40.0, 30.0, 20.0, 10.0],
                include_zero: true,
                ..Default::default()
            },
        ],
        ..Default::default()
    })
    .unwrap();
    assert_eq!(plates.len(), 1);
    let w = &plates[0].wells;
    let entries = |r, c| {
        w[&WellKey(r, c)]
            .iter()
            .map(|(k, v)| (*k, *v))
            .collect::<Vec<_>>()
    };
    assert_eq!(entries(0, 0), vec![(0, 5.0), (1, 50.0)]);
    assert_eq!(entries(4, 0), vec![(0, 1.0), (1, 50.0)]);
    assert_eq!(entries(5, 0), vec![(1, 50.0)]); // A = 0
    assert!(!w.contains_key(&WellKey(5, 5))); // 0 + 0 -> empty well
    assert_eq!(w.len(), 35);
}

#[test]
fn synergy_plate_breaks_guide_examples() {
    let f = |id: i64, n: usize| SynergyFluid {
        fluid_id: id,
        levels: (0..n).map(|i| (n - i) as f64).collect(),
        ..Default::default()
    };
    // 3x4 grid on 384 excluding rows/cols to get 3x3 slots (9 rows, 12 cols).
    let base = SynergySpec {
        kind: SynergyType::Abc,
        layout: SynergyLayout::MultipleBreaks,
        grid_order: Some(Direction::Rows),
        plate: plate_t("Default384"),
        excluded_rows: (9..16).collect::<BTreeSet<_>>(),
        excluded_cols: (12..24).collect::<BTreeSet<_>>(),
        ..Default::default()
    };
    let p1 = build_synergy(&SynergySpec {
        fluids: vec![f(0, 3), f(1, 4), f(2, 5), f(3, 3)],
        ..base.clone()
    })
    .unwrap();
    assert_eq!(p1.len(), 3); // 15 grids at 5 per plate
    let p2 = build_synergy(&SynergySpec {
        fluids: vec![f(0, 3), f(1, 4), f(2, 2), f(3, 4), f(4, 3)],
        ..base
    })
    .unwrap();
    assert_eq!(p2.len(), 3); // 24 grids at 8 per plate
}

#[test]
fn normalization_one_group_per_class_per_well_removing_a_plate_renumbers() {
    let mut pr = Protocol {
        plates: (0..3)
            .map(|_| new_plate(&PlateTemplate::default()).unwrap())
            .collect(),
        ..Default::default()
    };
    let w = |p, r, c| BackfillWell { p, r, c };
    add_normalization(&mut pr, 0, "ToMaxVolume", None, &[w(0, 0, 0), w(2, 0, 0)]);
    add_normalization(&mut pr, 0, "ToAssayVolumePct", Some(0.01), &[w(0, 0, 0)]);
    assert_eq!(pr.backfills.len(), 2);
    assert_eq!(pr.backfills[0].wells, vec![w(2, 0, 0)]);
    remove_plate(&mut pr, 1);
    assert_eq!(pr.backfills[0].wells, vec![w(1, 0, 0)]);
}

#[test]
fn synergy_reproduces_d300e_control_t06() {
    let reference = &load("t06-synergy.tdd").plates[1];
    let lv = |id: i64, order: AxisOrder| SynergyFluid {
        fluid_id: id,
        include_zero: true,
        order,
        levels: synergy_levels(&hl(50.0, 0.05, 6, Distribution::Log), true).unwrap(),
    };
    let plate = PlateTemplate {
        plate_type: Some("Default384".into()),
        assay_volume: Some(50000.0),
        dmso_limit: Some(0.01),
        ..Default::default()
    };
    let mine = build_synergy(&SynergySpec {
        kind: SynergyType::Abc,
        layout: SynergyLayout::Single,
        plate,
        fluids: vec![lv(0, AxisOrder::HighFirst), lv(2, AxisOrder::LowFirst)],
        ..Default::default()
    })
    .unwrap()
    .remove(0);
    assert_eq!(mine.name, "Synergy");
    assert_eq!(mine.wells.len(), reference.wells.len());
    for (k, m) in &reference.wells {
        for (id, val) in m {
            close(
                v(&mine, k.0, k.1, *id),
                *val,
                1e-12,
                &format!("well {k} fluid {id}"),
            );
        }
    }
}

#[test]
fn titration_patterns_reproduce_d300e_control_t04() {
    let reference = &load("t04-titration.tdd").plates[0];
    let mut p = new_plate(&plate_t("Default384")).unwrap();
    let l = |n| titration_levels(&hl(10.0, 0.003, n, Distribution::Log)).unwrap();
    let pl = |replicates, pattern| TitrationPlacement {
        replicates,
        pattern,
        ..Default::default()
    };
    // same order of operations as in D300e: row B, then column 4, then column 6 (later ones replace)
    apply_titration(
        &mut p,
        &(0..24).map(|c| (1, c)).collect::<Vec<_>>(),
        0,
        &l(8),
        &pl(3, TitrationPattern::RowsTL),
    )
    .unwrap();
    apply_titration(
        &mut p,
        &(0..16).map(|r| (r, 3)).collect::<Vec<_>>(),
        0,
        &l(8),
        &pl(2, TitrationPattern::ColsTL),
    )
    .unwrap();
    apply_titration(
        &mut p,
        &(0..16).map(|r| (r, 5)).collect::<Vec<_>>(),
        0,
        &l(8),
        &pl(2, TitrationPattern::ColsBL),
    )
    .unwrap();
    assert_eq!(p.wells.len(), reference.wells.len());
    for (k, m) in &reference.wells {
        close(v(&p, k.0, k.1, 0), m[&0], 1e-12, &format!("well {k}"));
    }
    // the four corners, row-wise from top-right on a 2x3 block: highest at top-right, then leftwards
    let mut q = new_plate(&plate_t("Default96")).unwrap();
    let cells = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2)];
    apply_titration(
        &mut q,
        &cells,
        0,
        &[6.0, 5.0, 4.0, 3.0, 2.0, 1.0],
        &pl(1, TitrationPattern::RowsTR),
    )
    .unwrap();
    let got: Vec<f64> = [(0, 2), (0, 1), (0, 0), (1, 2), (1, 1), (1, 0)]
        .iter()
        .map(|&(r, c)| v(&q, r, c, 0))
        .collect();
    assert_eq!(got, vec![6.0, 5.0, 4.0, 3.0, 2.0, 1.0]);
    assert_eq!(TITRATION_PATTERNS.len(), 8);
}

#[test]
fn randomization_t09_round_trips_and_randomizing_merges_groups() {
    let txt = read_text(&reference_dir().join("t09-randomize.tdd"));
    let mut p = parse_tdd(&txt).unwrap();
    assert_eq!(p.plates[0].randomization.len(), 24);
    // <Well R="1" C="0" ToR="1" ToC="12"/>: design well B13 is dispensed into B1 (direction: probe-28 run report)
    assert_eq!(dispensed_well(&p.plates[0], 1, 12), (1, 0));
    // rewriting from the semantic list (not the raw node) gives the same bytes
    p.plates[0].randomize_raw = None;
    assert_eq!(write_tdd(&p).unwrap(), txt);
    let mut q = new_plate(&PlateTemplate::default()).unwrap();
    let mut seed: f64 = 1.0;
    let mut rng = || {
        seed = (seed * 16807.0) % 2147483647.0;
        seed / 2147483647.0
    };
    randomize_wells(&mut q, &[(0, 0), (0, 1), (0, 2)], &mut rng);
    randomize_wells(&mut q, &[(1, 0)], &mut rng);
    let mut from: Vec<String> = q
        .randomization
        .iter()
        .map(|m| format!("{},{}", m.r, m.c))
        .collect();
    let mut to: Vec<String> = q
        .randomization
        .iter()
        .map(|m| format!("{},{}", m.to_r, m.to_c))
        .collect();
    from.sort();
    to.sort();
    assert_eq!(from, vec!["0,0", "0,1", "0,2", "1,0"]);
    assert_eq!(to, from);
}

#[test]
fn quick_plate_reproduces_d300e_control_t08_and_the_guide_examples() {
    let reference = load("t08-quickplate.tdd").plates;
    let levels = titration_levels(&hl(10.0, 0.003, 8, Distribution::Log)).unwrap();
    let base = QuickPlateSpec {
        fluids: vec![0],
        levels,
        replicates: 2,
        layout: Direction::Rows,
        keep_replicates_together: false,
        plate: plate_t("Default384"),
        ..Default::default()
    };
    for (start, ref_plate) in [
        (QuickStart::Continuous, &reference[1]),
        (QuickStart::NewLine, &reference[2]),
    ] {
        let mine = build_quick_plate(&QuickPlateSpec {
            start,
            ..base.clone()
        })
        .unwrap()
        .remove(0);
        assert_eq!(mine.name, "Quick Plate");
        let mut a: Vec<String> = mine.wells.keys().map(|k| k.to_string()).collect();
        let mut b: Vec<String> = ref_plate.wells.keys().map(|k| k.to_string()).collect();
        a.sort();
        b.sort();
        assert_eq!(a, b, "{start:?}");
        for (k, m) in &ref_plate.wells {
            close(
                v(&mine, k.0, k.1, 0),
                m[&0],
                1e-12,
                &format!("{start:?} {k}"),
            );
        }
    }
    // Guide example 1 (p.58-59): 96-well, 4 fluids, 8 levels, 3 replicates, by columns, not together, no interleave
    let g1 = build_quick_plate(&QuickPlateSpec {
        fluids: vec![0, 1, 2, 3],
        levels: (1..=8).rev().map(f64::from).collect(),
        replicates: 3,
        layout: Direction::Cols,
        keep_replicates_together: false,
        interleave: Interleave::NoInterleave,
        start: QuickStart::Continuous,
        plate: plate_t("Default96"),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(g1.len(), 1);
    for f in 0..4u32 {
        for k in 0..3 {
            for r in 0..8u32 {
                assert_eq!(
                    v(&g1[0], r, f * 3 + k, f as i64),
                    (8 - r) as f64,
                    "ex1 fluid {f} col {} row {r}",
                    f * 3 + k
                );
            }
        }
    }
    // Guide example 2 (p.60-61): 3 x 96-well with perimeter excluded, 6 fluids, 10 levels, 3 replicates,
    // by rows, not together, change fluid after each singlicate -> replicate k on plate k, rows B-G = fluids
    let ten: Vec<f64> = (1..=10).rev().map(f64::from).collect();
    let g2 = build_quick_plate(&QuickPlateSpec {
        fluids: (0..6).collect(),
        levels: ten.clone(),
        replicates: 3,
        layout: Direction::Rows,
        keep_replicates_together: false,
        interleave: Interleave::Singlicate,
        start: QuickStart::Continuous,
        plate: plate_t("Default96"),
        excluded_rows: [0, 7].into(),
        excluded_cols: [0, 11].into(),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(g2.len(), 3);
    for pl in &g2 {
        for f in 0..6u32 {
            for c in 1..=10u32 {
                assert_eq!(v(pl, f + 1, c, f as i64), (11 - c) as f64);
            }
        }
    }
    // Guide example 3 (p.62-63): 384, cols 1-2 excluded, 16 fluids, 10 levels, 2 replicates, by columns, keep
    // replicates together, change fluid after each level replicate -> col 3 = level 1 of fluids 1-8, col 4 = fluids 9-16 ...
    let g3 = build_quick_plate(&QuickPlateSpec {
        fluids: (0..16).collect(),
        levels: ten,
        replicates: 2,
        layout: Direction::Cols,
        keep_replicates_together: true,
        interleave: Interleave::Level,
        start: QuickStart::NewLine,
        plate: plate_t("Default384"),
        excluded_cols: [0, 1].into(),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(g3.len(), 1);
    let p = &g3[0];
    assert_eq!(v(p, 0, 2, 0), 10.0);
    assert_eq!(v(p, 1, 2, 0), 10.0);
    assert_eq!(v(p, 2, 2, 1), 10.0);
    assert_eq!(v(p, 0, 3, 8), 10.0);
    assert_eq!(v(p, 0, 4, 0), 9.0);
    assert_eq!(v(p, 15, 21, 15), 1.0);
    assert!(!p.wells.contains_key(&WellKey(0, 22)));
}

#[test]
fn new_plate_defaults_deionize_true_and_honours_the_template() {
    // New plates in D300e Control 4.0.1 have Deionize=True (T01). (Previously mirrored a JS defect.)
    assert!(new_plate(&PlateTemplate::default()).unwrap().deionize);
    let p = new_plate(&PlateTemplate { deionize: Some(false), ..Default::default() }).unwrap();
    assert!(!p.deionize);
}

#[test]
fn three_fluid_synergy_reproduces_d300e_control_t07() {
    // A×B×C, grids stacked by columns, C low→high
    let proto = load("t07-synergy3.tdd");
    let reference = proto.plates.last().unwrap();
    let ax = |id: i64, n: usize, low: f64, order: AxisOrder| SynergyFluid {
        fluid_id: id,
        include_zero: true,
        order,
        levels: synergy_levels(&hl(10.0, low, n, Distribution::Log), true).unwrap(),
    };
    let plate = PlateTemplate {
        plate_type: Some("Default384".into()),
        assay_volume: Some(50000.0),
        dmso_limit: Some(0.01),
        ..Default::default()
    };
    let mine = build_synergy(&SynergySpec {
        kind: SynergyType::Abc,
        layout: SynergyLayout::Multiple,
        grid_order: Some(Direction::Cols),
        plate,
        fluids: vec![
            ax(0, 4, 0.1, AxisOrder::HighFirst),
            ax(2, 4, 0.1, AxisOrder::LowFirst),
            ax(1, 3, 1.0, AxisOrder::LowFirst),
        ],
        ..Default::default()
    })
    .unwrap()
    .remove(0);
    assert_eq!(mine.wells.len(), reference.wells.len());
    for (k, m) in &reference.wells {
        let got: Vec<i64> = mine.wells[k].keys().copied().collect();
        let want: Vec<i64> = m.keys().copied().collect();
        assert_eq!(got, want, "fluid order in well {k}");
        for (id, val) in m {
            close(
                v(&mine, k.0, k.1, *id),
                *val,
                1e-12,
                &format!("well {k} fluid {id}"),
            );
        }
    }
}

#[test]
fn targeted_titration_reproduces_d300e_control_t11() {
    let reference = load("t11-targeted.tdd");
    let reference = reference.plates.last().unwrap();
    let lv = targeted_levels(&TargetedOptions {
        high: 10.0,
        low: 0.003,
        levels: 16,
        target: 0.5,
        region: 8,
        range: 0.25,
    })
    .unwrap();
    let mut p = new_plate(&plate_t("Default384")).unwrap();
    let cells: Vec<Cell> = (0..16).map(|r| (r, 9)).collect();
    apply_titration(
        &mut p,
        &cells,
        0,
        &lv,
        &TitrationPlacement {
            pattern: TitrationPattern::ColsTL,
            ..Default::default()
        },
    )
    .unwrap();
    for r in 0..16 {
        close(
            v(&p, r, 9, 0),
            v(reference, r, 9, 0),
            1e-12,
            &format!("row {r}"),
        );
    }
}
