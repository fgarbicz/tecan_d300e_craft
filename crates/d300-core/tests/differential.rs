//! Differential tests against the JS engine, run with node as a subprocess (skipped, with a message,
//! only when node is not installed).
//!  A. `node tools/compare/engine_dump.mjs <file>` for every reference .tdd: every row and field equal
//!     (volumes exact, concentrations within 1e-12 relative), in the same order.
//!  B. A fuller dump of every computed well (all WellResult fields, warnings, class volumes) as IEEE bit
//!     patterns: bit-identical.
//!  C. JS number primitives (String(x), toExponential, toFixed, toPrecision, Math.round, Number(text),
//!     formatNumber) on generated values including exact binary ties: identical.
//!  D. Design operations (titration levels, synergy, scrap-well values, TSV export): identical.
mod common;
use common::*;
use d300_core::dispense::{
    compute_protocol, scrap_well_values, DispenseMode, Warning, PRIMING_VOLUME,
};
use d300_core::jsnum::{
    js_round, to_exponential, to_fixed, to_js_string, to_number, to_precision_number,
};
use d300_core::ops::*;
use d300_core::tdd::format_number;
use serde_json::{json, Value};
use std::io::Write;

fn bits(x: f64) -> Value {
    Value::String(format!("{:x}", x.to_bits()))
}
fn obits(x: Option<f64>) -> Value {
    x.map_or(Value::Null, bits)
}
fn from_bits(v: &Value) -> f64 {
    f64::from_bits(u64::from_str_radix(v.as_str().unwrap(), 16).unwrap())
}

/// JS helper prepended to every node script: B(x) = IEEE bits of a number as hex (null for undefined/null).
const JS_BITS: &str = r#"
const __f = new Float64Array(1), __u = new BigUint64Array(__f.buffer);
const B = (x) => { if (x === undefined || x === null) return null; __f[0] = x; return __u[0].toString(16); };
const NB = (x) => { __u[0] = BigInt('0x' + x); return __f[0]; };
const files = JSON.parse(process.env.D300_FILES || '[]');
"#;

fn node_script(body: &str, files: &[String], extra_env: &[(&str, String)]) -> Option<Value> {
    let mut env = vec![("D300_FILES", serde_json::to_string(files).unwrap())];
    env.extend(extra_env.iter().cloned());
    let out = node_eval(&format!("{JS_BITS}\n{body}"), &env)?;
    Some(serde_json::from_str(&out).expect("node output is JSON"))
}

fn first_diff(a: &Value, b: &Value, path: &str) -> Option<String> {
    match (a, b) {
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                return Some(format!(
                    "{path}: length {} (rust) vs {} (js)",
                    x.len(),
                    y.len()
                ));
            }
            x.iter()
                .zip(y)
                .enumerate()
                .find_map(|(i, (p, q))| first_diff(p, q, &format!("{path}[{i}]")))
        }
        _ if a == b => None,
        _ => Some(format!("{path}: {a} (rust) vs {b} (js)")),
    }
}

fn assert_same(rust: &Value, js: &Value, what: &str) {
    if let Some(d) = first_diff(rust, js, what) {
        panic!("Rust and JS differ: {d}");
    }
}

fn file_list() -> Vec<String> {
    reference_tdd_files().iter().map(|p| rel(p)).collect()
}

// ---------- A ----------

#[test]
fn a_engine_dump_matches_node_for_every_reference_file() {
    let mut checked = 0;
    for name in file_list() {
        let path = reference_dir().join(&name);
        let Some(out) = run_node(
            &["tools/compare/engine_dump.mjs", path.to_str().unwrap()],
            None,
        ) else {
            return;
        };
        let js: Vec<Value> = serde_json::from_str(&out).unwrap();
        let mine = engine_dump(&load(&name));
        assert_eq!(mine.len(), js.len(), "{name}: row count");
        for (i, (m, j)) in mine.iter().zip(&js).enumerate() {
            let ctx = format!("{name} row {i} ({j})");
            assert_eq!(m.plate as u64, j["plate"].as_u64().unwrap(), "{ctx}");
            assert_eq!(m.well, j["well"].as_str().unwrap(), "{ctx}");
            match m.fluid {
                DumpFluid::Norm => assert_eq!(j["fluid"], "norm", "{ctx}"),
                DumpFluid::Fluid(f) => assert_eq!(Some(f), j["fluid"].as_i64(), "{ctx}"),
            }
            // JSON.stringify writes NaN/±Infinity as null
            let eq = |a: f64, b: &Value| {
                if b.is_null() {
                    !a.is_finite()
                } else {
                    a == jnum(b)
                }
            };
            assert!(eq(m.volume, &j["volume"]), "{ctx}: volume {}", m.volume);
            assert!(eq(m.total, &j["total"]), "{ctx}: total {}", m.total);
            assert!(eq(m.norm, &j["norm"]), "{ctx}: norm {}", m.norm);
            match (m.conc, j["conc"].is_null()) {
                (None, true) => {}
                (Some(c), false) => {
                    let jc = jnum(&j["conc"]);
                    assert!((c - jc).abs() <= 1e-12 * jc.abs(), "{ctx}: conc {c}");
                }
                (c, _) => panic!("{ctx}: conc {c:?}"),
            }
            checked += 1;
        }
    }
    assert!(checked > 6000, "only {checked} rows compared");
}

// ---------- B ----------

#[test]
fn b_every_computed_well_is_bit_identical_to_js() {
    let files = file_list();
    let js = r#"
const { readFileSync } = await import('node:fs');
const { parseTdd } = await import('./src/tdd.js');
const { computeProtocol } = await import('./src/dispense.js');
const W = (w) => Object.entries(w).map(([k, v]) => [k, typeof v === 'number' ? B(v) : v]);
const CV = (m) => (m ? [...m.entries()].map(([k, v]) => [k === undefined ? null : B(k), B(v)]) : null);
const out = files.map((f) => computeProtocol(parseTdd(readFileSync('fixtures/reference/' + f, 'utf8'))).map(({ wells }) =>
  [...wells].map(([k, r]) => [k, B(r.totalVolume), B(r.dmsoFraction), B(r.normalization), B(r.normalizationRequested),
    r.warnings.map(W),
    r.fluids.map((x) => [B(x.fluidId), x.mode, B(x.requested), B(x.exactVolume), B(x.volume), x.classId === undefined ? null : B(x.classId), B(x.S), B(x.dispensed)]),
    CV(r.classVolumes), CV(r.exactClassVolumes)])));
process.stdout.write(JSON.stringify(out));
"#;
    let Some(js_out) = node_script(js, &files, &[]) else {
        return;
    };
    let warn = |w: &Warning| -> Value {
        let c = json!(["code", w.code()]);
        match w {
            Warning::UnknownFluid { fluid_id }
            | Warning::NoStock { fluid_id }
            | Warning::AboveStock { fluid_id } => {
                json!([c, ["fluidId", bits(*fluid_id as f64)]])
            }
            Warning::NoSolution => json!([c]),
            Warning::BelowMinVolume {
                fluid_id,
                requested_volume,
            } => {
                json!([
                    c,
                    ["fluidId", bits(*fluid_id as f64)],
                    ["requestedVolume", bits(*requested_volume)]
                ])
            }
            Warning::AboveMaxVolume { fluid_id, volume } => json!([
                c,
                ["fluidId", bits(*fluid_id as f64)],
                ["volume", bits(*volume)]
            ]),
            Warning::DmsoLimit {
                dmso_fraction,
                limit,
            } => json!([
                c,
                ["dmsoFraction", bits(*dmso_fraction)],
                ["limit", bits(*limit)]
            ]),
        }
    };
    let cv = |m: &Option<d300_core::dispense::ClassVolumes>| -> Value {
        m.as_ref().map_or(Value::Null, |m| {
            Value::Array(
                m.0.iter()
                    .map(|(k, v)| json!([k.map_or(Value::Null, |k| bits(k as f64)), bits(*v)]))
                    .collect(),
            )
        })
    };
    let mut wells = 0;
    let rust: Vec<Value> = files
        .iter()
        .map(|f| {
            Value::Array(
                compute_protocol(&load(f))
                    .iter()
                    .map(|pr| {
                        Value::Array(
                            pr.wells
                                .iter()
                                .map(|(k, r)| {
                                    wells += 1;
                                    json!([
                                        k.to_string(),
                                        bits(r.total_volume),
                                        bits(r.dmso_fraction),
                                        bits(r.normalization),
                                        obits(r.normalization_requested),
                                        r.warnings.iter().map(warn).collect::<Vec<_>>(),
                                        r.fluids
                                            .iter()
                                            .map(|x| json!([
                                                bits(x.fluid_id as f64),
                                                if x.mode == DispenseMode::Vol {
                                                    "vol"
                                                } else {
                                                    "conc"
                                                },
                                                bits(x.requested),
                                                bits(x.exact_volume),
                                                bits(x.volume),
                                                x.class_id.map_or(Value::Null, |c| bits(c as f64)),
                                                obits(x.s),
                                                obits(x.dispensed)
                                            ]))
                                            .collect::<Vec<_>>(),
                                        cv(&r.class_volumes),
                                        cv(&r.exact_class_volumes)
                                    ])
                                })
                                .collect(),
                        )
                    })
                    .collect(),
            )
        })
        .collect();
    assert_same(&Value::Array(rust), &js_out, "wells");
    assert!(wells > 3000, "only {wells} wells compared");
}

// ---------- C ----------

#[test]
fn c_js_number_primitives_are_identical() {
    let js = r#"
const { formatNumber } = await import('./src/tdd.js');
let s = 0x9E3779B97F4A7C15n; const M = (1n << 64n) - 1n;
const next = () => { s ^= (s << 13n) & M; s ^= s >> 7n; s ^= (s << 17n) & M; return s; };
const xs = [0, -0, 0.5, 1.5, 2.5, -2.5, -0.5, 0.49999999999999994, 1e21, 1e-7, 1e-6, 9.9999999999995, 9.99999999999999,
  0.125, 2 ** -20, 1e-5, 33.33333333333, 1 / 3, 50000, 4503599627370497, -1e-300, 5e-324, 1.7976931348623157e308, 123456789012345680000];
for (let i = 0; i < 3000; i++) { // random doubles with exponents 2^-70 .. 2^70
  const b = next(); const e = BigInt(1023 - 70 + Number(b % 141n)); const m = next() & ((1n << 52n) - 1n);
  __u[0] = ((b & 1n) << 63n) | (e << 52n) | m; xs.push(__f[0]);
}
for (let i = 0; i < 2000; i++) xs.push(Number(`${next() % 1000000000000000n}e-${Number(next() % 21n)}`)); // decimal-looking
for (let i = 0; i < 2000; i++) xs.push(Number(next() % 1048575n | 1n) / 2 ** Number(next() % 60n)); // exact binary: ties
const rows = xs.map((x, i) => {
  const f = i % 21; let fmt; try { fmt = formatNumber(x); } catch (e) { fmt = 'ERR ' + e.message; }
  return [B(x), String(x), x.toExponential(12), x.toExponential(i % 17), x.toFixed(f), B(Number(x.toPrecision(12))), fmt, B(Math.round(x))];
});
const strs = ['', ' ', '  1E-05 \n', '0x10', '0X1f', '0o17', '0b101', '-0x10', '0x', '5.', '.5', '5.e3', '.', '+.5', '-.5e-3', '1e', '1e+',
  'inf', 'nan', 'Infinity', '-Infinity', '+Infinity', 'infinity', '1_0', '12abc', ' 12 ', '﻿7', '\u00857', '1e400', '-0',
  '0x1fffffffffffff1', '0.1', '33.33333333333', '1E-05', '000123', '1.2.3', '--1', '+-1', '0b', '0o8', '9007199254740993'];
const up = (x) => { __f[0] = x; __u[0] += 1n; return __f[0]; }, down = (x) => { __f[0] = x; __u[0] -= 1n; return __f[0]; };
const p10 = []; for (let k = -15; k <= 15; k++) { const x = Number(`1e${k}`); p10.push(x, up(x), down(x), up(up(x)), down(down(x))); }
const floors = p10.map((x) => [B(x), B(Math.floor(Math.log10(x)))]);
const logs = xs.filter((x) => x > 0).map((x) => [B(x), B(Math.log10(x))]);
process.stdout.write(JSON.stringify({ rows, nums: strs.map((t) => [t, B(Number(t))]), floors, logs }));
"#;
    let Some(out) = node_script(js, &[], &[]) else {
        return;
    };
    let rows = out["rows"].as_array().unwrap();
    assert!(rows.len() > 7000);
    for (i, r) in rows.iter().enumerate() {
        let x = from_bits(&r[0]);
        let f = i % 21;
        let fmt = match format_number(x) {
            Ok(s) => s,
            Err(e) => format!("ERR {e}"),
        };
        let mine = json!([
            r[0].clone(),
            to_js_string(x),
            to_exponential(x, 12),
            to_exponential(x, i % 17),
            to_fixed(x, f),
            bits(to_precision_number(x, 12)),
            fmt,
            bits(js_round(x))
        ]);
        assert_same(&mine, r, &format!("value {x:e} (#{i})"));
    }
    // floor(log10(x)) is what scrap_well_values uses: exact agreement at and next to powers of ten
    for f in out["floors"].as_array().unwrap() {
        let x = from_bits(&f[0]);
        assert_eq!(bits(x.log10().floor()), f[1], "floor(log10({x:e}))");
    }
    // raw log10 is NOT bit-identical (system log10 vs V8's); informational count only
    let logs = out["logs"].as_array().unwrap();
    let diff = logs
        .iter()
        .filter(|l| bits(from_bits(&l[0]).log10()) != l[1])
        .count();
    let _ = writeln!(std::io::stderr(), "log10: {diff} of {} values differ from V8 in the last bit (not used except via floor/round)", logs.len());
    for n in out["nums"].as_array().unwrap() {
        let t = n[0].as_str().unwrap();
        assert_eq!(bits(to_number(t)), n[1], "Number({t:?})");
    }
}

// ---------- D ----------

fn titration_cases() -> Vec<TitrationOptions> {
    use Distribution::*;
    let mut v = vec![];
    let pairs = [
        (100.0, 0.0013),
        (10.0, 0.003),
        (50.0, 0.05),
        (20.0, 0.02),
        (1.0, 0.5),
        (3.7, 0.00011),
        (5.0, 5.0),
        (1.0, 0.0),
    ];
    for mode in [
        TitrationMode::HighLow,
        TitrationMode::High,
        TitrationMode::Low,
    ] {
        for dist in [Log, Linear, HalfLog, ThirdLog, QuarterLog, Dilution] {
            for levels in [0usize, 1, 2, 3, 5, 6, 8, 12, 24] {
                for &(high, low) in &pairs {
                    for (factor, increment) in [
                        (None, None),
                        (Some(3.0), Some(0.4)),
                        (Some(1.0), Some(0.01)),
                    ] {
                        v.push(TitrationOptions {
                            mode,
                            high: Some(high),
                            low: Some(low),
                            levels,
                            distribution: dist,
                            factor,
                            increment,
                        });
                    }
                }
            }
        }
    }
    v
}

#[test]
fn d_design_operations_are_identical() {
    let cases = titration_cases();
    let files = file_list();
    let mut targeted = vec![];
    // target at the geometric mean of high and low with an odd number of tail levels: the split
    // rest·spanHi/(spanHi+spanLo) is k + 0.5 up to rounding, so Math.round depends on log10's last bits
    for (high, low, target) in [
        (10.0, 0.001, 0.1),
        (100.0, 0.01, 1.0),
        (1.0, 0.0001, 0.01),
        (1000.0, 0.1, 10.0),
        (20.0, 0.002, 0.2),
        (50.0, 0.005, 0.5),
    ] {
        for levels in [7usize, 9, 11, 13, 15, 17, 21] {
            for region in [2usize, 4, 6] {
                for range in [0.25, 0.5, 0.1, 1.0 / 3.0] {
                    targeted.push(TargetedOptions {
                        high,
                        low,
                        levels,
                        target,
                        region,
                        range,
                    });
                }
            }
        }
    }
    for (high, low) in [(10.0, 0.003), (100.0, 0.001), (50.0, 0.5), (1.0, 0.9)] {
        for levels in [3usize, 4, 8, 12, 16, 24] {
            for target in [0.5, 1.0, 0.01, 7.0] {
                for region in [1usize, 2, 4, 8, 14] {
                    for range in [0.25, 0.5, 0.1, 1.0] {
                        targeted.push(TargetedOptions {
                            high,
                            low,
                            levels,
                            target,
                            region,
                            range,
                        });
                    }
                }
            }
        }
    }
    let js = r#"
const { readFileSync } = await import('node:fs');
const { parseTdd } = await import('./src/tdd.js');
const { titrationLevels, synergyLevels, buildSynergy, plateToTsv } = await import('./src/ops.js');
const { scrapWellValues } = await import('./src/dispense.js');
const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === null) delete o[k]; return o; };
const tryLv = (f) => { try { return f().map(B); } catch (e) { return 'ERR ' + e.message; } };
const cases = JSON.parse(process.env.D300_TITRATIONS).map(clean);
const titr = cases.map((o) => tryLv(() => titrationLevels(o)));
const syn = cases.map((o) => tryLv(() => synergyLevels({ ...o, includeZero: true })));
const { targetedLevels } = await import('./src/ops.js');
const targeted = JSON.parse(process.env.D300_TARGETED).map((o) => tryLv(() => targetedLevels(o)));
const scrap = files.map((f) => { const p = parseTdd(readFileSync('fixtures/reference/' + f, 'utf8'));
  return p.plates.map((pl) => scrapWellValues(p.fluids, pl).map(([id, v]) => [id, B(v)])); });
const scrap10 = [1, 10, 100, 1000, 10000, 100000, 3, 30].flatMap((S) => [[29970, 1], [29940, 2], [50000, 1]].map(([A, n]) =>
  scrapWellValues(Array.from({ length: n }, (_, id) => ({ id, byVol: false, concentration: S, classId: 0 })), { assayVolume: A }).map(([id, v]) => [id, B(v)])));
const tsv = files.map((f) => { const p = parseTdd(readFileSync('fixtures/reference/' + f, 'utf8'));
  return p.plates.flatMap((pl) => p.fluids.map((fl) => plateToTsv(pl, fl))); });
const lv = synergyLevels({ mode: 'highLow', high: 50, low: 0.05, levels: 6, distribution: 'log', includeZero: true });
const syns = ['single', 'multiple', 'multipleBreaks', 'noEmpty'].flatMap((layout) => ['rows', 'cols', undefined].map((gridOrder) =>
  buildSynergy({ type: 'ABC', layout, gridOrder, plate: { plateType: 'Default384', assayVolume: 50000 },
    fluids: [{ fluidId: 0, levels: lv, includeZero: true }, { fluidId: 1, levels: lv.slice(0, 3), includeZero: false, order: 'lowFirst' },
      { fluidId: 2, levels: [3, 2, 1], includeZero: true }] })
  .map((p) => [p.name, [...p.wells].map(([k, m]) => [k, [...m].map(([id, v]) => [id, B(v)])])])));
process.stdout.write(JSON.stringify({ titr, syn, targeted, scrap, scrap10, tsv, syns }));
"#;
    let env = [
        ("D300_TITRATIONS", serde_json::to_string(&cases).unwrap()),
        ("D300_TARGETED", serde_json::to_string(&targeted).unwrap()),
    ];
    let Some(out) = node_script(js, &files, &env) else {
        return;
    };
    let lvls = |r: d300_core::Result<Vec<f64>>| match r {
        Ok(v) => Value::Array(v.into_iter().map(bits).collect()),
        Err(e) => Value::String(format!("ERR {e}")),
    };
    let titr: Vec<Value> = cases.iter().map(|o| lvls(titration_levels(o))).collect();
    let syn: Vec<Value> = cases
        .iter()
        .map(|o| lvls(synergy_levels(o, true)))
        .collect();
    let n_ok = titr.iter().filter(|v| v.is_array()).count();
    assert!(n_ok > 1000, "only {n_ok} successful titrations");
    assert_same(&Value::Array(titr), &out["titr"], "titrationLevels");
    assert_same(&Value::Array(syn), &out["syn"], "synergyLevels");
    let tl: Vec<Value> = targeted.iter().map(|o| lvls(targeted_levels(o))).collect();
    assert!(
        tl.iter().filter(|v| v.is_array()).count() > 300,
        "too few successful targeted titrations"
    );
    assert_same(&Value::Array(tl), &out["targeted"], "targetedLevels");

    let protos: Vec<_> = files.iter().map(|f| load(f)).collect();
    let scrap: Vec<Value> = protos
        .iter()
        .map(|p| {
            json!(p
                .plates
                .iter()
                .map(|pl| scrap_well_values(&p.fluids, pl, PRIMING_VOLUME)
                    .into_iter()
                    .map(|(id, v)| json!([id, bits(v)]))
                    .collect::<Vec<_>>())
                .collect::<Vec<_>>())
        })
        .collect();
    assert_same(&Value::Array(scrap), &out["scrap"], "scrapWellValues");
    // exact = S·30/(A + 30n) lands on powers of ten (0.001 … 100): the floor(log10) boundary
    let mut scrap10 = vec![];
    for s in [1.0, 10.0, 100.0, 1000.0, 10000.0, 100000.0, 3.0, 30.0] {
        for (a, n) in [(29970.0, 1), (29940.0, 2), (50000.0, 1)] {
            let fl: Vec<d300_core::tdd::Fluid> = (0..n)
                .map(|id| d300_core::tdd::Fluid {
                    id,
                    concentration: Some(s),
                    class_id: Some(0),
                    ..Default::default()
                })
                .collect();
            let pl = d300_core::tdd::Plate {
                assay_volume: a,
                ..Default::default()
            };
            scrap10.push(json!(scrap_well_values(&fl, &pl, PRIMING_VOLUME)
                .into_iter()
                .map(|(id, v)| json!([id, bits(v)]))
                .collect::<Vec<_>>()));
        }
    }
    assert_same(
        &Value::Array(scrap10),
        &out["scrap10"],
        "scrapWellValues at powers of ten",
    );
    let tsv: Vec<Value> = protos
        .iter()
        .map(|p| {
            json!(p
                .plates
                .iter()
                .flat_map(|pl| p.fluids.iter().map(|fl| plate_to_tsv(pl, fl)))
                .collect::<Vec<_>>())
        })
        .collect();
    assert_same(&Value::Array(tsv), &out["tsv"], "plateToTsv");

    let lv = synergy_levels(
        &TitrationOptions {
            mode: TitrationMode::HighLow,
            high: Some(50.0),
            low: Some(0.05),
            levels: 6,
            distribution: Distribution::Log,
            ..Default::default()
        },
        true,
    )
    .unwrap();
    let mut syns = vec![];
    for layout in [
        SynergyLayout::Single,
        SynergyLayout::Multiple,
        SynergyLayout::MultipleBreaks,
        SynergyLayout::NoEmpty,
    ] {
        for grid_order in [Some(Direction::Rows), Some(Direction::Cols), None] {
            let plates = build_synergy(&SynergySpec {
                kind: SynergyType::Abc,
                layout,
                grid_order,
                plate: PlateTemplate {
                    plate_type: Some("Default384".into()),
                    assay_volume: Some(50000.0),
                    ..Default::default()
                },
                fluids: vec![
                    SynergyFluid {
                        fluid_id: 0,
                        levels: lv.clone(),
                        include_zero: true,
                        ..Default::default()
                    },
                    SynergyFluid {
                        fluid_id: 1,
                        levels: lv[..3].to_vec(),
                        include_zero: false,
                        order: AxisOrder::LowFirst,
                    },
                    SynergyFluid {
                        fluid_id: 2,
                        levels: vec![3.0, 2.0, 1.0],
                        include_zero: true,
                        ..Default::default()
                    },
                ],
                ..Default::default()
            })
            .unwrap();
            syns.push(json!(plates
                .iter()
                .map(|p| json!([
                    p.name,
                    p.wells
                        .iter()
                        .map(|(k, m)| json!([
                            k.to_string(),
                            m.iter()
                                .map(|(id, v)| json!([id, bits(*v)]))
                                .collect::<Vec<_>>()
                        ]))
                        .collect::<Vec<_>>()
                ]))
                .collect::<Vec<_>>()));
        }
    }
    assert_same(&Value::Array(syns), &out["syns"], "buildSynergy");
}
