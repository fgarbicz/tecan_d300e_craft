//! Shared test helpers. Paths are derived from CARGO_MANIFEST_DIR (no absolute paths).
#![allow(dead_code)]

use d300_core::dispense::{compute_protocol, PlateResult};
use d300_core::tdd::{parse_tdd, well_name, Protocol};
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

pub fn reference_dir() -> PathBuf {
    repo_root().join("fixtures").join("reference")
}

/// Read a file as node's `buf.toString('utf8')` does (invalid sequences become U+FFFD).
pub fn read_text(p: &Path) -> String {
    String::from_utf8_lossy(
        &std::fs::read(p).unwrap_or_else(|e| panic!("read {}: {e}", p.display())),
    )
    .into_owned()
}

/// Every .tdd under fixtures/reference (top level, tecan_examples/, roundtrip/, ...), sorted.
/// Asserts that the known reference files are all found, so a broken path cannot pass vacuously.
pub fn reference_tdd_files() -> Vec<PathBuf> {
    fn walk(d: &Path, out: &mut Vec<PathBuf>) {
        for e in std::fs::read_dir(d).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "tdd") {
                out.push(p);
            }
        }
    }
    let mut out = vec![];
    walk(&reference_dir(), &mut out);
    out.sort();
    let names: Vec<String> = out.iter().map(|p| rel(p)).collect();
    for must in [
        "2026.08.28 synergy D3.tdd",
        "t01-setvalue-units.tdd",
        "t04-titration.tdd",
        "t05-normalize.tdd",
        "t06-synergy.tdd",
        "t07-synergy3.tdd",
        "t08-quickplate.tdd",
        "t09-randomize.tdd",
        "t10-classes.tdd",
        "t11-targeted.tdd",
        "tecan_examples/Example Protocol.tdd",
        "tecan_examples/384 Four Corners Protocol.tdd",
        "tecan_examples/1536 Four Corners Protocol.tdd",
        "roundtrip/mac-made-1.tdd",
        "roundtrip/mac-made-1-resaved.tdd",
    ] {
        assert!(
            names.iter().any(|n| n == must),
            "reference file {must} not found (found {names:?})"
        );
    }
    out
}

/// Path relative to fixtures/reference, with '/' separators.
pub fn rel(p: &Path) -> String {
    p.strip_prefix(reference_dir())
        .unwrap()
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

pub fn load(rel_path: &str) -> Protocol {
    parse_tdd(&read_text(&reference_dir().join(rel_path)))
        .unwrap_or_else(|e| panic!("parse {rel_path}: {e}"))
}

pub fn close(a: f64, b: f64, tol: f64, msg: &str) {
    assert!((a - b).abs() <= tol, "{msg}: {a} vs {b}");
}

pub fn close_rel(a: f64, b: f64, rel: f64, msg: &str) {
    assert!((a - b).abs() <= rel * b.abs(), "{msg}: {a} vs {b}");
}

// ---------- engine dump (Rust twin of tools/compare/engine_dump.mjs) ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DumpFluid {
    /// report fluid number = fluid ID + 1
    Fluid(i64),
    Norm,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DumpRow {
    pub plate: usize, // 1-based
    pub well: String,
    pub fluid: DumpFluid,
    pub volume: f64,
    pub conc: Option<f64>,
    pub total: f64,
    pub norm: f64,
}

pub fn engine_dump_of(computed: &[PlateResult]) -> Vec<DumpRow> {
    let mut out = vec![];
    for (pi, pr) in computed.iter().enumerate() {
        for (k, w) in &pr.wells {
            let well = well_name(k.0, k.1);
            for x in &w.fluids {
                out.push(DumpRow {
                    plate: pi + 1,
                    well: well.clone(),
                    fluid: DumpFluid::Fluid(x.fluid_id + 1),
                    volume: x.volume,
                    conc: x.dispensed,
                    total: w.total_volume,
                    norm: w.normalization,
                });
            }
            if w.normalization != 0.0 && !w.normalization.is_nan() {
                out.push(DumpRow {
                    plate: pi + 1,
                    well: well.clone(),
                    fluid: DumpFluid::Norm,
                    volume: w.normalization,
                    conc: None,
                    total: w.total_volume,
                    norm: w.normalization,
                });
            }
        }
    }
    out
}

pub fn engine_dump(p: &Protocol) -> Vec<DumpRow> {
    engine_dump_of(&compute_protocol(p))
}

// ---------- node ----------

/// Run node with `args` in the repo root. Ok(None) only when node is not installed (spawn NotFound);
/// a non-zero exit is a test failure.
pub fn run_node(args: &[&str], stdin: Option<&str>) -> Option<String> {
    use std::io::Write;
    let mut cmd = Command::new("node");
    cmd.args(args)
        .current_dir(repo_root())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if stdin.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("SKIPPED: `node` is not installed, so the differential test against the JS engine cannot run");
            return None;
        }
        Err(e) => panic!("spawn node: {e}"),
    };
    if let Some(s) = stdin {
        child.stdin.take().unwrap().write_all(s.as_bytes()).unwrap();
    }
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "node {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    Some(String::from_utf8(out.stdout).unwrap())
}

/// Evaluate an ES-module script with node (imports like './src/tdd.js' resolve from the repo root).
pub fn node_eval(script: &str) -> Option<String> {
    run_node(&["--input-type=module", "-"], Some(script))
}

/// JSON number (or null for a non-finite JS value) as f64.
pub fn jnum(v: &serde_json::Value) -> f64 {
    if v.is_null() {
        f64::NAN
    } else {
        v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"))
    }
}

/// Bitwise-equal, treating NaN as equal to NaN and JSON's lost sign of zero as equal.
pub fn same(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || a == b
}
