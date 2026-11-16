//! Dispense-volume engine: requested concentrations -> per-well dispense volumes,
//! rounded to the dispenser's droplet increments, dispensed concentrations, DMSO %,
//! normalization (backfill) volumes and warnings. Port of src/dispense.js.
//!
//! Rules come from the vendor user guide (docs/spec_from_user_guide.md §6-§8):
//!   V_total = A + ΣV_i + ΣV_vol + N        (A = plate "additional volume" = <AssayVolume>)
//!   V_i     = C_i · V_total / S_i          (solved exactly, then rounded per fluid class)
//!   C_disp  = S_i · V_i,rounded / V_total,rounded
//! Verified against the guide's p.89 report example (tests/dispense.rs) and a real D300e Control
//! run report (tests/run_report.rs). Items marked UNVERIFIED must be confirmed against D300e Control
//! (docs/vm_test_plan.md).
//!
//! Arithmetic follows the JS expression order exactly, so results are bit-identical to the JS engine
//! (tests/differential.rs).

use crate::error::{Error, Result};
use crate::jsnum::{js_max, js_min, js_pow, js_round, or0, to_precision_number, truthy};
use crate::tdd::{Fluid, Plate, Protocol, WellFluids, WellKey};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::borrow::Borrow;
use std::collections::HashMap;

pub use crate::tdd::split_key;

// ---------- units ----------
/// Factors to the protocol base units: µM for molarity, ng/mL for mass, nL for volume.
pub const MOLARITY_UNITS: [(&str, f64); 5] = [
    ("M", 1e6),
    ("mM", 1e3),
    ("µM", 1.0),
    ("nM", 1e-3),
    ("pM", 1e-6),
];
pub const MASS_UNITS: [(&str, f64); 4] = [
    ("mg_mL", 1e6),
    ("µg_mL", 1e3),
    ("ng_mL", 1.0),
    ("pg_mL", 1e-3),
];
pub const VOLUME_UNITS: [(&str, f64); 3] = [("µL", 1e3), ("nL", 1.0), ("pL", 1e-3)];

/// "ng_mL" -> "ng/mL" (first underscore only, as JS `replace`).
pub fn unit_label(u: &str) -> String {
    u.replacen('_', "/", 1)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UnitKind {
    Molarity,
    Mass,
    Volume,
}

fn lookup(table: &[(&str, f64)], u: &str) -> Option<f64> {
    table.iter().find(|(k, _)| *k == u).map(|(_, v)| *v)
}

pub fn unit_kind(u: &str) -> Result<UnitKind> {
    if lookup(&MOLARITY_UNITS, u).is_some() {
        Ok(UnitKind::Molarity)
    } else if lookup(&MASS_UNITS, u).is_some() {
        Ok(UnitKind::Mass)
    } else if lookup(&VOLUME_UNITS, u).is_some() {
        Ok(UnitKind::Volume)
    } else {
        Err(Error::new(format!("Unknown unit \"{u}\"")))
    }
}

fn unit_factor(u: &str) -> f64 {
    // JS: undefined factor for an unknown unit -> NaN arithmetic
    lookup(&MOLARITY_UNITS, u)
        .or_else(|| lookup(&MASS_UNITS, u))
        .or_else(|| lookup(&VOLUME_UNITS, u))
        .unwrap_or(f64::NAN)
}

/// UNVERIFIED (docs/format_notes.md): <Concentration> is stored in the protocol base unit
/// (µM / ng/mL) and <ConcentrationUnit> is only the display unit. NaN when the fluid has none.
/// (Status copied from the JS comment; docs/format_notes.md has since recorded this as CONFIRMED by T01.)
pub fn stock_in_base(fluid: &Fluid) -> f64 {
    fluid.concentration.unwrap_or(f64::NAN)
}
pub fn to_display(value_in_base: f64, unit: &str) -> f64 {
    value_in_base / unit_factor(unit)
}
pub fn from_display(value: f64, unit: &str) -> f64 {
    value * unit_factor(unit)
}

// ---------- fluid classes ----------
/// Increments from the guide, Appendix E (p.109-110), standard-volume cassettes; volumes in nL.
/// `bands`: (upper bound, increment), the last band unbounded.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FluidClass {
    pub id: i64,
    pub key: &'static str,
    pub group: &'static str,
    pub label: &'static str,
    pub short: &'static str,
    pub is_dmso: bool,
    pub min_volume: f64,
    pub bands: &'static [(f64, f64)],
    /// Master-mix classes are dispensed by volume only.
    pub by_volume_only: bool,
}

const DMSO_BANDS: &[(f64, f64)] = &[(0.017, 0.013), (3.6, 0.02), (f64::INFINITY, 0.4)];
const AQ_BANDS: &[(f64, f64)] = &[(3.6, 0.011), (f64::INFINITY, 0.56)];
const AQG_BANDS: &[(f64, f64)] = &[(3.6, 0.012), (f64::INFINITY, 0.6)];

const fn aq(id: i64, key: &'static str, label: &'static str, short: &'static str) -> FluidClass {
    FluidClass {
        id,
        key,
        group: "Aqueous",
        label,
        short,
        is_dmso: false,
        min_volume: 0.011,
        bands: AQ_BANDS,
        by_volume_only: false,
    }
}
const fn aqg(id: i64, key: &'static str, label: &'static str, short: &'static str) -> FluidClass {
    FluidClass {
        id,
        key,
        group: "Aqueous",
        label,
        short,
        is_dmso: false,
        min_volume: 0.012,
        bands: AQG_BANDS,
        by_volume_only: false,
    }
}

/// ClassID -> class CONFIRMED with fixtures/reference/t10-classes.tdd (one fluid per class, saved by D300e
/// Control 4.0.1). Master-mix classes (group "Master Mix") are dispensed by volume; only ID 12 is known.
pub const FLUID_CLASSES: [FluidClass; 8] = [
    FluidClass {
        id: 0,
        key: "dmso",
        group: "DMSO",
        label: "DMSO",
        short: "DMSO",
        is_dmso: true,
        min_volume: 0.013,
        bands: DMSO_BANDS,
        by_volume_only: false,
    },
    aq(1, "aq_tween20", "Aqueous+Tween 20", "a+Tw"),
    aq(2, "aq_brij35", "Aqueous+Brij 35", "a+B"),
    aq(3, "aq_tritonx100", "Aqueous+Triton X100", "a+TX"),
    aqg(4, "aq_tween20_gly", "Aqueous+Tween 20+glycerol", "a+Tw+g"),
    aqg(5, "aq_brij35_gly", "Aqueous+Brij 35+glycerol", "a+B+g"),
    aqg(
        6,
        "aq_tritonx100_gly",
        "Aqueous+Triton X100+glycerol",
        "a+TX+g",
    ),
    // UNVERIFIED increments
    FluidClass {
        id: 12,
        key: "mm_brilliant2_sybr",
        group: "Master Mix",
        label: "Brilliant II SYBR Green qRT-PCR 1-Step Master Mix",
        short: "B2SG",
        is_dmso: false,
        min_volume: 0.012,
        bands: AQG_BANDS,
        by_volume_only: true,
    },
];
pub const MAX_VOLUME_PER_FLUID_PER_WELL: f64 = 10000.0; // nL (10 µL), p.109-110
pub const MIN_NORMALIZATION_VOLUME: f64 = 1.0; // nL, p.109-110 ("normalization and bulk dispense")

/// `FLUID_CLASSES[classId] || FLUID_CLASSES[0]`
pub fn fluid_class(class_id: Option<i64>) -> &'static FluidClass {
    class_id
        .and_then(|id| FLUID_CLASSES.iter().find(|c| c.id == id))
        .unwrap_or(&FLUID_CLASSES[0])
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rounded {
    pub volume: f64,
    pub below_min: bool,
}

/// Round a requested volume (nL) to the nearest dispensable volume for a fluid class.
/// Returns 0 for requests below half the minimum droplet (with a warning flag).
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn round_volume(v: f64, cls: &FluidClass) -> Rounded {
    if v <= 0.0 {
        return Rounded {
            volume: 0.0,
            below_min: false,
        };
    }
    if v < cls.min_volume {
        // UNVERIFIED: whether sub-minimum requests round up to one drop or are dropped.
        return Rounded {
            volume: if v >= cls.min_volume / 2.0 {
                cls.min_volume
            } else {
                0.0
            },
            below_min: true,
        };
    }
    let mut lower = 0.0;
    for &(upper, inc) in cls.bands {
        if v <= upper || upper == f64::INFINITY {
            // Nearest multiple of the band's increment (UNVERIFIED: tie and band-edge handling).
            // Nearest multiple, ties to even (.NET Math.Round default). Confirmed on the D3 run report:
            // 1.01 nL → 1.00 nL (50.5 × 20 pL → 50). (was: Math.round, ties up)
            // .NET Math.Round on v / inc in doubles (no tie tolerance): probe-26 A1, probe-25 L13
            let mut r = round_half_even_strict(v / inc) * inc;
            if r < lower {
                r = lower;
            }
            return Rounded {
                volume: clean_float(r),
                below_min: false,
            };
        }
        lower = upper;
    }
    Rounded {
        volume: v,
        below_min: false,
    }
}

/// `Number(x.toPrecision(12))`
fn clean_float(x: f64) -> f64 {
    to_precision_number(x, 12)
}

/// Rounding of a normalization top-up to the 400 pL grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NormRounding {
    Floor,
    Nearest,
}

/// Normalization (backfill) volume as D300e Control 4.0.1 computes it. Derived from the run report of the
/// D3 protocol (fixtures/reference/reports/), which it reproduces for all 536 normalized wells:
///  - nothing is added when target − ROUNDED current volume < 1 nL (minimum normalization dispense);
///  - otherwise N = target − EXACT current volume (exact volumes to 0.1 pL), floored to the 400 pL grid
///    (also below 3.6 nL), and never less than 1 nL.
///
/// (The guide's older p.89 example rounded to the nearest step: 99.9 → 100 nL.)
/// `_cls` is unused, as in the JS (kept for signature parity).
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn normalization_volume(
    target: f64,
    current_rounded: f64,
    current_exact: f64,
    _cls: &FluidClass,
    grid: f64,
    mode: NormRounding,
) -> f64 {
    if !(target - current_rounded >= MIN_NORMALIZATION_VOLUME - 1e-9) {
        return 0.0;
    }
    let gap = target - js_round(current_exact * 1e4) / 1e4;
    let n = (match mode {
        NormRounding::Nearest => round_half_even(gap / grid),
        NormRounding::Floor => (gap / grid + 1e-9).floor(),
    }) * grid;
    clean_float(js_max(MIN_NORMALIZATION_VOLUME, n))
}

/// Largest dispensable volume ≤ v on the class's increment grid.
pub fn floor_volume(v: f64, cls: &FluidClass) -> f64 {
    if v < cls.min_volume {
        return 0.0;
    }
    let mut lower = 0.0;
    for &(upper, inc) in cls.bands {
        if v <= upper || upper == f64::INFINITY {
            return clean_float(js_max(lower, (v / inc + 1e-9).floor() * inc));
        }
        lower = upper;
    }
    v
}

/// Relative tolerances of D300e Control 4.0.1 (fitted on simulated runs, see src/dispense.js).
pub const SIZING_TOLERANCE: f64 = 1e-3;
pub const DMSO_LIMIT_TOLERANCE: f64 = 1e-3;

/// Well total used to size the fluids: fixed-point iteration T_n = fixed + k·T_(n−1) from T_0 = fixed, stopping
/// (from the second step) once |T_n − T_(n−1)| / T_n < 0.1 %; returns T_(n−1), the total V_n was sized with.
pub fn iterated_total(fixed: f64, k: f64) -> f64 {
    let mut prev = fixed;
    for n in 1..=100 {
        let next = fixed + k * prev;
        // check from the first step (probe-22l E14, probe-26 g3); see iteratedTotal in src/dispense.js
        let _ = n;
        if (next - prev).abs() / next < SIZING_TOLERANCE {
            return prev;
        }
        prev = next;
    }
    prev
}


/// Nearest integer, ties (within 1e-9) to even.
pub fn round_half_even(q: f64) -> f64 {
    let f = q.floor();
    let d = q - f;
    if (d - 0.5).abs() < 1e-9 {
        return if f % 2.0 == 0.0 { f } else { f + 1.0 };
    }
    js_round(q)
}

// ---------- per-well computation ----------

/// Fluid ID -> fluid (`new Map(protocol.fluids.map((f) => [f.id, f]))`: a later duplicate ID wins).
pub type FluidLookup<'a> = HashMap<i64, &'a Fluid>;

pub fn fluid_lookup(fluids: &[Fluid]) -> FluidLookup<'_> {
    fluids.iter().map(|f| (f.id, f)).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DispenseMode {
    /// ByVol fluid: the request is a volume (nL)
    Vol,
    /// concentration request
    Conc,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispenseItem {
    pub fluid_id: i64,
    pub mode: DispenseMode,
    pub requested: f64,
    pub exact_volume: f64,
    pub volume: f64,
    pub class_id: Option<i64>,
    /// Stock concentration (base units); None for ByVol fluids.
    #[serde(rename = "S")]
    pub s: Option<f64>,
    /// Dispensed concentration S·V/V_total; None for ByVol fluids.
    pub dispensed: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "code",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Warning {
    UnknownFluid {
        fluid_id: i64,
    },
    NoStock {
        fluid_id: i64,
    },
    AboveStock {
        fluid_id: i64,
    },
    NoSolution,
    BelowMinVolume {
        fluid_id: i64,
        requested_volume: f64,
    },
    AboveMaxVolume {
        fluid_id: i64,
        volume: f64,
    },
    DmsoLimit {
        dmso_fraction: f64,
        limit: f64,
    },
}

impl Warning {
    pub fn code(&self) -> &'static str {
        match self {
            Warning::UnknownFluid { .. } => "unknown_fluid",
            Warning::NoStock { .. } => "no_stock",
            Warning::AboveStock { .. } => "above_stock",
            Warning::NoSolution => "no_solution",
            Warning::BelowMinVolume { .. } => "below_min_volume",
            Warning::AboveMaxVolume { .. } => "above_max_volume",
            Warning::DmsoLimit { .. } => "dmso_limit",
        }
    }
}

/// Volume per fluid class, in order of first appearance (JS Map keyed by classId, which may be undefined).
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct ClassVolumes(pub Vec<(Option<i64>, f64)>);

impl ClassVolumes {
    pub fn get(&self, class_id: Option<i64>) -> Option<f64> {
        self.0.iter().find(|(k, _)| *k == class_id).map(|(_, v)| *v)
    }
    fn add(&mut self, class_id: Option<i64>, v: f64) {
        // m.set(id, (m.get(id) || 0) + v)
        let base = or0(self.get(class_id));
        match self.0.iter_mut().find(|(k, _)| *k == class_id) {
            Some(e) => e.1 = base + v,
            None => self.0.push((class_id, base + v)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WellResult {
    pub fluids: Vec<DispenseItem>,
    /// NaN when there is no solution (Σ C_i/S_i ≥ 1).
    pub total_volume: f64,
    pub dmso_fraction: f64,
    pub warnings: Vec<Warning>,
    pub normalization: f64,
    /// None when there is no solution (JS: undefined).
    pub class_volumes: Option<ClassVolumes>,
    pub exact_class_volumes: Option<ClassVolumes>,
    /// Set by compute_protocol for wells in a normalization group: target − exact current volume.
    pub normalization_requested: Option<f64>,
}

struct Item<'a> {
    id: i64,
    f: &'a Fluid,
    mode: DispenseMode,
    req: f64,
    s: Option<f64>,
}

/// Compute one well.
///  - `requests`: fluidId -> requested value (base conc units, or nL for ByVol fluids)
///  - `plate`: assay_volume = additional volume A, dmso_limit fraction
///  - `normalization`: extra DMSO-class volume (nL) from backfill, already rounded
///  - `sizing_total`: for wells in a normalization group, D300e Control sizes every fluid with a fixed
///    well volume = additional volume + the group's target (C·sizingTotal/S, not iterated); see
///    compute_protocol(). Otherwise (None) volumes solve C = S·V/V_total iteratively (guide Appendix D).
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn compute_well(
    requests: &WellFluids,
    fluids: &FluidLookup,
    plate: &Plate,
    normalization: f64,
    sizing_total: Option<f64>,
) -> WellResult {
    let a = plate.assay_volume;
    let mut warnings = vec![];
    let mut k = 0.0; // Σ C_i / S_i over concentration-mode fluids
                     // Fluid volumes are sized with the normalization volume included in the well total (D3 run report,
                     // plate 9: Kynurenin 50 µM → 126.4 nL with 378.4 nL normalization; 125.2 nL without).
    let mut fixed = a + normalization; // volume-mode fluids add fixed volumes
    let mut items: Vec<Item> = vec![];
    for (&id, &req) in requests {
        if req == 0.0 || req.is_nan() {
            continue; // if (!req)
        }
        let Some(&f) = fluids.get(&id) else {
            warnings.push(Warning::UnknownFluid { fluid_id: id });
            continue;
        };
        if f.by_vol {
            fixed += req;
            items.push(Item {
                id,
                f,
                mode: DispenseMode::Vol,
                req,
                s: None,
            });
        } else {
            let s = stock_in_base(f);
            if !(s > 0.0) {
                warnings.push(Warning::NoStock { fluid_id: id });
                continue;
            }
            if req >= s {
                warnings.push(Warning::AboveStock { fluid_id: id });
            }
            k += req / s;
            items.push(Item {
                id,
                f,
                mode: DispenseMode::Conc,
                req,
                s: Some(s),
            });
        }
    }
    if k >= 1.0 {
        warnings.push(Warning::NoSolution);
        return WellResult {
            fluids: vec![],
            total_volume: f64::NAN,
            dmso_fraction: f64::NAN,
            warnings,
            normalization,
            class_volumes: None,
            exact_class_volumes: None,
            normalization_requested: None,
        };
    }
    // D300e Control iterates V_i = C_i·T/S_i, T = fixed + ΣV_i from V = 0 and stops once the total changes by
    // < 0.1 % (from the second step on); see iterated_total and src/dispense.js computeWell.
    // (was: a fixed three steps, fixed·(1 + k + k²); before that the exact solution fixed / (1 − k).)
    let v_total_exact = iterated_total(fixed, k);
    let mut out: Vec<DispenseItem> = vec![];
    for it in &items {
        let cls = fluid_class(it.f.class_id);
        let exact = match (it.mode, sizing_total) {
            (DispenseMode::Vol, _) => it.req,
            (DispenseMode::Conc, Some(st)) => (it.req * st) / it.s.unwrap(),
            (DispenseMode::Conc, None) => (it.req * v_total_exact) / it.s.unwrap(),
        };
        let Rounded { volume, below_min } = round_volume(exact, cls);
        if below_min {
            warnings.push(Warning::BelowMinVolume {
                fluid_id: it.id,
                requested_volume: exact,
            });
        }
        if volume > MAX_VOLUME_PER_FLUID_PER_WELL {
            warnings.push(Warning::AboveMaxVolume {
                fluid_id: it.id,
                volume,
            });
        }
        out.push(DispenseItem {
            fluid_id: it.id,
            mode: it.mode,
            requested: it.req,
            exact_volume: exact,
            volume,
            class_id: it.f.class_id,
            s: it.s,
            dispensed: None,
        });
    }
    let total_volume = clean_float(a + normalization + out.iter().fold(0.0, |s, x| s + x.volume));
    let mut dmso_vol = normalization; // normalization fluid is DMSO class here (UNVERIFIED for non-DMSO classes)
    for x in &mut out {
        if x.mode == DispenseMode::Conc {
            x.dispensed = Some((x.s.unwrap() * x.volume) / total_volume);
        }
        if fluid_class(x.class_id).is_dmso {
            dmso_vol += x.volume;
        }
    }
    let dmso_fraction = if total_volume > 0.0 {
        dmso_vol / total_volume
    } else {
        0.0
    };
    // DMSO limit as D300e Control flags it: unrounded (sized) volumes, 0.1 % relative tolerance
    // (probe-12/14/15/16; see src/dispense.js computeWell). (was: rounded fraction at 3 decimals of %.)
    let mut exact_dmso = normalization;
    let mut exact_total = a + normalization;
    for x in &out {
        exact_total += x.exact_volume;
        if fluid_class(x.class_id).is_dmso {
            exact_dmso += x.exact_volume;
        }
    }
    let exact_fraction = if exact_total > 0.0 { exact_dmso / exact_total } else { 0.0 };
    if let Some(limit) = plate.dmso_limit {
        if exact_fraction > limit * (1.0 + DMSO_LIMIT_TOLERANCE) {
            warnings.push(Warning::DmsoLimit {
                dmso_fraction,
                limit,
            });
        }
    }
    let class_volumes = class_volumes(&out, |x| x.volume);
    let exact_class_volumes = class_volumes_exact(&out);
    WellResult {
        fluids: out,
        total_volume,
        dmso_fraction,
        warnings,
        normalization,
        class_volumes: Some(class_volumes),
        exact_class_volumes: Some(exact_class_volumes),
        normalization_requested: None,
    }
}

fn class_volumes(out: &[DispenseItem], field: impl Fn(&DispenseItem) -> f64) -> ClassVolumes {
    let mut m = ClassVolumes::default();
    for x in out {
        m.add(x.class_id, field(x));
    }
    m
}
fn class_volumes_exact(out: &[DispenseItem]) -> ClassVolumes {
    class_volumes(out, |x| x.exact_volume)
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct ValidRange {
    pub min: f64,
    pub max: f64,
}

/// Valid concentration range for a fluid on a plate (guide p.23/25: one-drop minimum to DMSO limit).
/// `shared_by`: number of fluids sharing the DMSO limit (JS default 1) — the Synergy wizard divides it
/// evenly (confirmed: 10 mM, 1 %: 1 fluid 100 µM, 2 fluids 50 µM (T06), 3 fluids 33.3 µM (T07)).
pub fn valid_range(fluid: &Fluid, plate: &Plate, shared_by: f64) -> ValidRange {
    let cls = fluid_class(fluid.class_id);
    let s = stock_in_base(fluid);
    let a = plate.assay_volume;
    let min = (s * cls.min_volume) / (a + cls.min_volume);
    let max = if cls.is_dmso && truthy(plate.dmso_limit) {
        (s * plate.dmso_limit.unwrap()) / shared_by
    } else {
        s * MAX_VOLUME_PER_FLUID_PER_WELL / (a + MAX_VOLUME_PER_FLUID_PER_WELL)
    };
    ValidRange { min, max }
}

// ---------- whole protocol ----------

/// Results of one plate: design well -> result, in the plate's well order; wells that only a
/// normalization group touches are appended at the end (JS Map semantics).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlateResult {
    /// Index of the plate in `protocol.plates` (the JS result holds the plate object itself).
    pub plate_index: usize,
    pub wells: IndexMap<WellKey, WellResult>,
}

/// Compute every well of every plate, including normalization (backfill) blocks.
/// Normalization semantics (guide p.32-34, INFERRED mapping to XML):
///   ToMaxVolume      : class volume topped up to the highest class volume in the group
///   ToVolume         : class volume topped up to Param nL
///   ToAssayVolumePct : class volume brought to Param × total well volume (total includes N)
///   ToMaxTotalVolume : total well volume topped up to the highest total in the group
///   ToTotalVolume    : total well volume topped up to Param nL
///   (group scope = the whole block across its plates: UNVERIFIED)
///   Volumes < 1 nL are not normalized (minimum normalization dispense 1 nL).
pub fn compute_protocol(protocol: &Protocol) -> Vec<PlateResult> {
    let fluids = fluid_lookup(&protocol.fluids);
    let mut result: Vec<PlateResult> = protocol
        .plates
        .iter()
        .enumerate()
        .map(|(i, plate)| PlateResult {
            plate_index: i,
            wells: plate
                .wells
                .iter()
                .map(|(k, req)| (*k, compute_well(req, &fluids, plate, 0.0, None)))
                .collect(),
        })
        .collect();
    let empty_req = WellFluids::new();
    struct Base<'a> {
        p: usize,
        key: WellKey,
        plate: &'a Plate,
        req: &'a WellFluids,
        class_vol: f64,
        total_vol: f64,
        /// Unrounded class / all-fluid volumes, before any well of the group is normalized.
        exact_class_vol: f64,
        exact_all: f64,
    }
    impl TopUpWell for Base<'_> {
        fn exact(&self, class_only: bool) -> f64 {
            if class_only { self.exact_class_vol } else { self.exact_all }
        }
        fn req(&self) -> &WellFluids {
            self.req
        }
    }
    for b in &protocol.backfills {
        let cls = fluid_class(Some(b.class_id));
        let mut base: Vec<Base> = b
            .wells
            .iter()
            .filter(|w| (w.p as usize) < result.len())
            .map(|w| {
                let p = w.p as usize;
                let plate = &protocol.plates[p];
                let key = WellKey(w.r, w.c);
                let computed;
                let r = match result[p].wells.get(&key) {
                    Some(r) => r,
                    None => {
                        computed = compute_well(&empty_req, &fluids, plate, 0.0, None);
                        &computed
                    }
                };
                let class_vol = or0(r
                    .class_volumes
                    .as_ref()
                    .and_then(|m| m.get(Some(b.class_id))));
                let exact_class_vol = or0(r
                    .exact_class_volumes
                    .as_ref()
                    .and_then(|m| m.get(Some(b.class_id))));
                let exact_all = r.fluids.iter().fold(0.0, |s, f| s + f.exact_volume);
                Base {
                    p,
                    key,
                    plate,
                    req: plate.wells.get(&key).unwrap_or(&empty_req),
                    class_vol,
                    total_vol: 0.0,
                    exact_class_vol,
                    exact_all,
                }
            })
            .collect();
        // Type names confirmed in fixtures/reference/t05-normalize.tdd (one row per UI option).
        // "Total" volume = additional volume + every dispensed fluid (all classes), before normalization.
        for x in &mut base {
            x.total_vol = match result[x.p].wells.get(&x.key) {
                Some(r) if r.total_volume.is_finite() => r.total_volume,
                _ => x.plate.assay_volume,
            };
        }
        let max_class = base.iter().fold(0.0, |m, x| js_max(m, x.class_vol));
        let max_total = base.iter().fold(0.0, |m, x| js_max(m, x.total_vol));
        for x in &base {
            // Target of the group, and the fixed well volume used to size the fluids of a normalized well.
            // Derived from the D3 run report (fixtures/reference/reports/): ToMaxVolume plates 1-2 and
            // ToAssayVolumePct plates 7-9 reproduce every dispensed volume with sizing = A + class target.
            let a = x.plate.assay_volume;
            let param = b.param.unwrap_or(f64::NAN); // JS: undefined -> NaN arithmetic
            let (target, sizing, total_based) = match b.kind.as_str() {
                "ToMaxVolume" => (max_class, None, false), // iterative sizing incl. N (plates 1-2: 1628/1628)
                "ToVolume" => (param, Some(a + param), false), // UNVERIFIED sizing
                // Fluids are sized with a fixed well volume A·(1+p); the class target is p × that volume, and the
                // top-up rounds to nearest (ties to even). Fitted on the D3 report, plate 9 (308 normalized wells).
                "ToAssayVolumePct" => {
                    let sizing = a * (1.0 + param);
                    (param * sizing, Some(sizing), false)
                }
                "ToMaxTotalVolume" => (max_total, Some(max_total), true), // UNVERIFIED sizing
                "ToTotalVolume" => (param, Some(param), true),            // UNVERIFIED sizing
                _ => continue, // unknown type: leave unnormalized
            };
            if b.kind != "ToAssayVolumePct" {
                let (n, t, total_sizing) = iterated_top_up(x, &base, b, a, total_based, target, &fluids, cls);
                // fluids of a normalized well are sized with the group's final target total
                let sz = match b.kind.as_str() {
                    "ToMaxVolume" => Some(a + t),
                    "ToMaxTotalVolume" => total_sizing.or(Some(t)),
                    _ => total_sizing.or(sizing),
                };
                let mut r = compute_well(x.req, &fluids, x.plate, n, sz);
                r.normalization_requested = Some(n);
                result[x.p].wells.insert(x.key, r);
                continue;
            }
            if b.kind == "ToAssayVolumePct" {
                let (n, sz) = pct_top_up(x.req, &fluids, b, a, b.param.unwrap_or(f64::NAN), cls);
                let mut r = compute_well(x.req, &fluids, x.plate, n, sz);
                r.normalization_requested = Some(n);
                result[x.p].wells.insert(x.key, r);
                continue;
            }
            // (unused: every type has its own model now; the earlier one-step rules, kept for reference)
            let r0 = compute_well(x.req, &fluids, x.plate, 0.0, sizing);
            let cr = or0(r0
                .class_volumes
                .as_ref()
                .and_then(|m| m.get(Some(b.class_id))));
            let ce = or0(r0
                .exact_class_volumes
                .as_ref()
                .and_then(|m| m.get(Some(b.class_id))));
            let cur_rounded = if total_based { r0.total_volume } else { cr };
            let cur_exact = if total_based {
                r0.total_volume - cr + ce
            } else {
                ce
            };
            // Rounding of the top-up: floor for ToMaxVolume (plates 1-2), nearest for % of total (plate 9).
            let mode = if b.kind == "ToAssayVolumePct" {
                NormRounding::Nearest
            } else {
                NormRounding::Floor
            };
            let n = normalization_volume(target, cur_rounded, cur_exact, cls, 0.4, mode);
            let mut r = compute_well(x.req, &fluids, x.plate, n, sizing);
            r.normalization_requested = Some(target - cur_exact);
            result[x.p].wells.insert(x.key, r);
        }
    }
    result
}

/// Top-up of the "to volume / to highest / to total" types as D300e Control 4.0.1 computes it; a port of
/// iteratedTopUp in src/dispense.js (see there for the rules and their evidence).
/// Returns (rounded top-up, final target used for sizing).
#[allow(clippy::too_many_arguments)]
fn iterated_top_up<B: TopUpWell>(
    x: &B,
    base: &[B],
    b: &crate::tdd::Backfill,
    a: f64,
    total_based: bool,
    fixed_target: f64,
    fluids: &FluidLookup,
    cls: &FluidClass,
) -> (f64, f64, Option<f64>) {
    let conc = |req: &WellFluids, class_only: bool| -> Vec<(f64, f64)> {
        let mut out = vec![];
        for (id, &c) in req {
            let Some(f) = fluids.get(id) else { continue };
            if f.by_vol || c == 0.0 || c.is_nan() {
                continue;
            }
            if class_only && f.class_id != Some(b.class_id) {
                continue;
            }
            out.push((c, stock_in_base(f)));
        }
        out
    };
    let vol = |cs: &[(f64, f64)], t: f64| cs.iter().fold(0.0, |v, &(c, s)| v + (c * t) / s);
    if b.kind == "ToTotalVolume" {
        let (n, t, sz) = total_top_up(&conc(x.req(), false), &vol, a, fixed_target - a, cls);
        return (n, t, Some(sz));
    }
    let highest = b.kind == "ToMaxVolume" || b.kind == "ToMaxTotalVolume";
    let mut t_c: Vec<(f64, f64)> = vec![];
    let mut tv = 0.0;
    if highest {
        let mut best = f64::NEG_INFINITY;
        let mut best_y: Option<&B> = None;
        for y in base {
            let v = y.exact(!total_based);
            if v > best {
                best = v;
                best_y = Some(y);
            }
        }
        if let Some(y) = best_y {
            t_c = conc(y.req(), !total_based);
        }
        let mut prev = a;
        for _ in 1..=100 {
            let next = a + vol(&t_c, prev);
            if (next - prev).abs() / next < SIZING_TOLERANCE {
                break;
            }
            prev = next;
        }
        tv = vol(&t_c, prev);
    }
    let c_c = conc(x.req(), !total_based);
    let c_all = conc(x.req(), false);
    if b.kind == "ToMaxTotalVolume" {
        let (n, t, sz) = max_total_top_up(&t_c, &c_all, &vol, a, tv, cls);
        return (n, t, Some(sz));
    }
    let mut v = vol(&c_c, a);
    let mut v_all = vol(&c_all, a);
    let (mut n_prev, mut v_prev): (Option<f64>, f64) = (None, 0.0);
    let (mut n, mut t) = (0.0, 0.0);
    if total_based {
        let t0 = if highest { a + tv } else { fixed_target };
        n_prev = Some(t0 - a);
        v_prev = 0.0;
    }
    for _ in 0..100 {
        t = if highest {
            if total_based { a + tv } else { tv }
        } else {
            fixed_target
        };
        n = if total_based { t - (a + v) } else { t - v };
        if let Some(np) = n_prev {
            if (v - v_prev).abs() / js_max(n.abs(), 1e-12) < SIZING_TOLERANCE {
                n = np;
                break;
            }
        }
        n_prev = Some(n);
        v_prev = v;
        let tot = a + n + v_all;
        v = vol(&c_c, tot);
        v_all = vol(&c_all, tot);
        if highest {
            tv = vol(&t_c, a + tv);
        }
    }
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    if !(n >= MIN_NORMALIZATION_VOLUME - 1e-9) {
        return (0.0, t, None);
    }
    let mut lower = 0.0;
    for &(upper, inc) in cls.bands {
        if n <= upper || upper == f64::INFINITY {
            let q = round_half_even_strict(n / inc);
            return (clean_float(js_max(js_max(MIN_NORMALIZATION_VOLUME, lower), q * inc)), t, None);
        }
        lower = upper;
    }
    (n, t, None)
}

/// "% of assay volume": port of pctTopUp in src/dispense.js (D3 plate 9 + probe-25, 1076/1076).
/// Returns (top-up, sizing total for the fluids; None = sized like an unnormalized well).
fn pct_top_up(req: &WellFluids, fluids: &FluidLookup, b: &crate::tdd::Backfill, a: f64, p: f64, cls: &FluidClass) -> (f64, Option<f64>) {
    let (mut c_c, mut c_all): (Vec<(f64, f64)>, Vec<(f64, f64)>) = (vec![], vec![]);
    for (id, &c) in req {
        let Some(f) = fluids.get(id) else { continue };
        if f.by_vol || c == 0.0 || c.is_nan() {
            continue;
        }
        c_all.push((c, stock_in_base(f)));
        if f.class_id == Some(b.class_id) {
            c_c.push((c, stock_in_base(f)));
        }
    }
    let vol = |cs: &[(f64, f64)], t: f64| cs.iter().fold(0.0, |v, &(c, s)| v + (c * t) / s);
    let (mut ts, mut vs, mut ns): (Vec<f64>, Vec<f64>, Vec<f64>) = (vec![], vec![], vec![]);
    let mut t = a + a * p; // the float order D300e uses (probe-25 L13)
    for i in 0..6 {
        let v = vol(&c_c, t);
        let n = p * t - if i > 0 { vs[i - 1] } else { v };
        ts.push(t);
        vs.push(v);
        ns.push(n);
        t = a + n + vol(&c_all, t);
    }
    let mut j = 4;
    for k in 1..=4 {
        if (vs[k] - vs[k - 1]).abs() / js_max(ns[k].abs(), 1e-12) < SIZING_TOLERANCE {
            j = k;
            break;
        }
    }
    let n = ns[j - 1];
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    if !(n >= MIN_NORMALIZATION_VOLUME - 1e-9) {
        return (0.0, None);
    }
    let mut lower = 0.0;
    for &(upper, inc) in cls.bands {
        if n <= upper || upper == f64::INFINITY {
            return (clean_float(js_max(js_max(MIN_NORMALIZATION_VOLUME, lower), round_half_even_strict(n / inc) * inc)), Some(ts[0]));
        }
        lower = upper;
    }
    (n, Some(ts[0]))
}

/// "To highest total volume": maxTotalTopUp in src/dispense.js (probe-23 plate 2, probe-20).
/// Returns (top-up, target total, sizing total for the fluids).
fn max_total_top_up(
    ct: &[(f64, f64)],
    c_all: &[(f64, f64)],
    vol: &dyn Fn(&[(f64, f64)], f64) -> f64,
    a: f64,
    s: f64,
    cls: &FluidClass,
) -> (f64, f64, f64) {
    let tt0 = vol(ct, a);
    let tt1 = a + s + tt0;
    let tt2 = a + (s - tt0) + vol(ct, tt1);
    let g = vol(ct, if (tt2 - tt1).abs() / tt2 >= SIZING_TOLERANCE { tt2 } else { tt1 });
    let x0 = vol(c_all, a);
    let t1 = a + g + x0;
    let t2 = a + (g - x0) + vol(c_all, t1);
    let x1 = vol(c_all, a + 2.0 * g);
    let x2 = vol(c_all, t2);
    let small = |d: f64, n: f64| d.abs() / js_max(n.abs(), 1e-12) < SIZING_TOLERANCE;
    let (x, used2) = if small(x1 - x0, g - x0) {
        (x0, false)
    } else if small(x2 - x1, g - x1) {
        (x1, false)
    } else {
        (x2, x2 != x1)
    };
    let n = g - x;
    let sizing = if used2 { t2 } else { t1 };
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    if !(n >= MIN_NORMALIZATION_VOLUME - 1e-9) {
        return (0.0, a + g, sizing);
    }
    let mut lower = 0.0;
    for &(upper, inc) in cls.bands {
        if n <= upper || upper == f64::INFINITY {
            return (clean_float(js_max(js_max(MIN_NORMALIZATION_VOLUME, lower), round_half_even_strict(n / inc) * inc)), a + g, sizing);
        }
        lower = upper;
    }
    (n, a + g, sizing)
}

/// "To total volume": the lagged iteration of totalTopUp in src/dispense.js (probe-23 plate 1).
/// Returns (top-up, target total, sizing total for the fluids).
fn total_top_up(cs: &[(f64, f64)], vol: &dyn Fn(&[(f64, f64)], f64) -> f64, a: f64, gap: f64, cls: &FluidClass) -> (f64, f64, f64) {
    let (mut ts, mut vs, mut ns) = (vec![], vec![], vec![]);
    let (mut vp, mut np) = (0.0, 0.0);
    for _ in 0..4 {
        let t = a + np + vp;
        let v = vol(cs, t);
        let n = gap - vp;
        ts.push(t);
        vs.push(v);
        ns.push(n);
        vp = v;
        np = n;
    }
    let mut i = 3;
    for k in 0..4 {
        let prev = if k > 0 { vs[k - 1] } else { 0.0 };
        if (vs[k] - prev).abs() / js_max(f64::abs(ns[k]), 1e-12) < SIZING_TOLERANCE {
            i = k;
            break;
        }
    }
    // fluid sizing: T₁ unless the well total still moves by ≥ 0.1 % between steps 1 and 2 (src/dispense.js; probe-27b)
    let j = if (ts[2] - ts[1]).abs() / ts[2] >= SIZING_TOLERANCE { 2 } else { 1 };
    let n = ns[i];
    let sizing = ts[j];
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    if !(n >= MIN_NORMALIZATION_VOLUME - 1e-9) {
        return (0.0, a + gap, sizing);
    }
    let mut lower = 0.0;
    for &(upper, inc) in cls.bands {
        if n <= upper || upper == f64::INFINITY {
            return (clean_float(js_max(js_max(MIN_NORMALIZATION_VOLUME, lower), round_half_even_strict(n / inc) * inc)), a + gap, sizing);
        }
        lower = upper;
    }
    (n, a + gap, sizing)
}

/// .NET Math.Round(double): nearest, exact binary ties to even, no tolerance.
fn round_half_even_strict(q: f64) -> f64 {
    let f = q.floor();
    let d = q - f;
    if d == 0.5 {
        return if f % 2.0 == 0.0 { f } else { f + 1.0 };
    }
    if d < 0.5 { f } else { f + 1.0 }
}

trait TopUpWell {
    fn exact(&self, class_only: bool) -> f64;
    fn req(&self) -> &WellFluids;
}

/// Unused in the JS as well (an earlier fixed-point model of % normalization, superseded by the
/// report-derived rule in compute_protocol). Kept for reference.
#[allow(dead_code)]
fn solve_pct_normalization(
    req: &WellFluids,
    plate: &Plate,
    p: f64,
    fluids: &FluidLookup,
    class_id: i64,
) -> f64 {
    // Find N >= 0 with classVol(N) + N = p · V_total(N); fixed-point iteration (guide: "iteratively").
    let mut n = 0.0;
    for _ in 0..50 {
        let r = compute_well(req, fluids, plate, n, None);
        if !r.total_volume.is_finite() {
            return 0.0;
        }
        let cv = or0(r.class_volumes.as_ref().and_then(|m| m.get(Some(class_id))));
        // exact (unrounded) update: N = (p·(V_total − N) − cv) / (1 − p)
        let next = js_max(0.0, (p * (r.total_volume - n) - cv) / (1.0 - p));
        if (next - n).abs() < 1e-9 {
            return next;
        }
        n = next;
    }
    n
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FluidTotal {
    pub volume: f64,
    pub wells: u32,
    /// Infinity when the fluid is never dispensed.
    pub min_volume: f64,
}

/// Totals per fluid across the protocol (for the run summary / cassette loading).
pub fn fluid_totals(computed: &[PlateResult]) -> IndexMap<i64, FluidTotal> {
    let mut totals: IndexMap<i64, FluidTotal> = IndexMap::new();
    for pr in computed {
        for r in pr.wells.values() {
            for x in &r.fluids {
                let t = totals.entry(x.fluid_id).or_insert(FluidTotal {
                    volume: 0.0,
                    wells: 0,
                    min_volume: f64::INFINITY,
                });
                t.volume += x.volume;
                t.wells += (x.volume > 0.0) as u32;
                if x.volume > 0.0 {
                    t.min_volume = js_min(t.min_volume, x.volume);
                }
            }
        }
    }
    totals
}

// ---------- priming / scrap well (guide Appendix F, p.113) ----------
// "it is recommended that the first plate using a fluid includes a well with volume of 30 nL or
// greater ... Since plate dispense order can vary, it is recommended that all plates follow this
// recommendation. ... consider dedicating one 'scrap' well on each plate to a larger dispense volume.
// This same well can be used for all fluids on the plate."
pub const PRIMING_VOLUME: f64 = 30.0; // nL

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lacking {
    pub fluid_id: i64,
    pub max_volume: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PrimingIssue {
    pub plate: usize,
    pub lacking: Vec<Lacking>,
}

/// For each plate, the fluids used on it whose largest dispense is < 30 nL.
/// (`_protocol` is unused, as in the JS.)
pub fn priming_issues(_protocol: &Protocol, computed: &[PlateResult]) -> Vec<PrimingIssue> {
    computed
        .iter()
        .enumerate()
        .map(|(p, pr)| {
            let mut max_vol: IndexMap<i64, f64> = IndexMap::new();
            for r in pr.wells.values() {
                for x in &r.fluids {
                    let v = js_max(or0(max_vol.get(&x.fluid_id).copied()), x.volume);
                    max_vol.insert(x.fluid_id, v);
                }
            }
            let lacking = max_vol
                .into_iter()
                .filter(|&(_, v)| v > 0.0 && v < PRIMING_VOLUME - 1e-9)
                .map(|(fluid_id, max_volume)| Lacking {
                    fluid_id,
                    max_volume,
                })
                .collect();
            PrimingIssue { plate: p, lacking }
        })
        .collect()
}

/// Concentrations (protocol units) that give ≥ 30 nL of each listed fluid when all share one well.
/// Rounded UP to 3 significant digits so the values are readable, as in hand-made protocols.
/// (`volume` defaults to PRIMING_VOLUME in the JS.)
pub fn scrap_well_values<F: Borrow<Fluid>>(
    fluids: &[F],
    plate: &Plate,
    volume: f64,
) -> Vec<(i64, f64)> {
    let total = plate.assay_volume + volume * fluids.len() as f64;
    fluids
        .iter()
        .map(|f| {
            let f: &Fluid = f.borrow();
            if f.by_vol {
                return (f.id, volume);
            }
            let exact = (stock_in_base(f) * volume) / total;
            let mag = js_pow(10.0, exact.log10().floor() - 2.0);
            (f.id, (exact / mag - 1e-9).ceil() * mag)
        })
        .collect()
}
