//! Design operations (pure-ish: they mutate the protocol passed in; the UI snapshots for undo).
//! Semantics from the user guide; see docs/spec_from_user_guide.md (§ numbers below). Port of src/ops.js.

use crate::dispense::valid_range;
use crate::error::{Error, Result};
use crate::jsnum::{js_max, js_min, js_pow, js_round, to_js_string, truthy};
use crate::tdd::{Backfill, BackfillWell, Fluid, Plate, Protocol, RandomMap, WellFluids, WellKey};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};

pub use crate::tdd::{split_key, well_key};

/// A selected well (row, col).
pub type Cell = (u32, u32);

// ---------- plate types ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PlateTypeInfo {
    pub name: &'static str,
    pub rows: u32,
    pub cols: u32,
    pub label: &'static str,
}

/// Plate-type strings confirmed in protocol files: Default48, Default96, Default384, Default1536.
pub const PLATE_TYPES: [PlateTypeInfo; 4] = [
    PlateTypeInfo {
        name: "Default48",
        rows: 6,
        cols: 8,
        label: "48-well",
    },
    PlateTypeInfo {
        name: "Default96",
        rows: 8,
        cols: 12,
        label: "96-well",
    },
    PlateTypeInfo {
        name: "Default384",
        rows: 16,
        cols: 24,
        label: "384-well",
    },
    PlateTypeInfo {
        name: "Default1536",
        rows: 32,
        cols: 48,
        label: "1536-well",
    },
];

pub fn plate_type(name: &str) -> Option<&'static PlateTypeInfo> {
    PLATE_TYPES.iter().find(|t| t.name == name)
}

/// Fields of `newPlate(template)`; None = use the default.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlateTemplate {
    pub plate_type: Option<String>,
    pub rows: Option<u32>,
    pub cols: Option<u32>,
    pub name: Option<String>,
    pub assay_volume: Option<f64>,
    pub dmso_limit: Option<f64>,
    pub dont_shake: Option<bool>,
    pub deionize: Option<bool>,
    pub prompt_plate_load: Option<bool>,
}

/// `newPlate(template)`. Errors for an unknown plate type without rows/cols (JS would write "undefined").
pub fn new_plate(template: &PlateTemplate) -> Result<Plate> {
    let ty = template
        .plate_type
        .clone()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Default384".into());
    let (rows, cols) = match plate_type(&ty) {
        Some(t) => (t.rows, t.cols),
        None => match (template.rows, template.cols) {
            (Some(r), Some(c)) => (r, c),
            _ => {
                return Err(Error::new(format!(
                    "Unknown plate type {ty} and no rows/cols given"
                )))
            }
        },
    };
    Ok(Plate {
        plate_type: Some(ty),
        rows,
        cols,
        name: template.name.clone().unwrap_or_default(),
        assay_volume: template.assay_volume.unwrap_or(50000.0),
        dmso_limit: Some(template.dmso_limit.unwrap_or(0.01)),
        dont_shake: template.dont_shake.unwrap_or(true), // new 384-well plates default to DontShake=True (T01)
        // MIRRORS A JS BUG (src/ops.js newPlate): `deionize: template.deionize ?? true,` sits inside the
        // `//` comment of the line above, so JS new plates have deionize undefined, written
        // <Deionize>False</Deionize>, although D300e Control's default is True (docs/format_notes.md).
        // template.deionize is ignored for the same reason. Change both together once the JS is fixed.
        deionize: false,
        prompt_plate_load: template.prompt_plate_load.unwrap_or(true),
        ..Plate::default()
    })
}

// ---------- fluids ----------

/// Fields of `addFluid(protocol, fields)`; None / "" = use the default.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FluidFields {
    pub name: Option<String>,
    pub by_vol: bool,
    pub concentration: Option<f64>,
    pub concentration_unit: Option<String>,
    pub max_volume: Option<f64>,
    pub max_volume_unit: Option<String>,
    pub class_id: Option<i64>,
    pub color: Option<i64>,
}

fn non_empty(s: &Option<String>) -> Option<String> {
    s.clone().filter(|x| !x.is_empty()) // JS `x || default`
}

pub fn add_fluid<'a>(protocol: &'a mut Protocol, fields: &FluidFields) -> &'a mut Fluid {
    let id = protocol.fluids.iter().fold(-1, |m, f| m.max(f.id)) + 1;
    let f = Fluid {
        id,
        name: Some(non_empty(&fields.name).unwrap_or_else(|| format!("Fluid {}", id + 1))),
        by_vol: fields.by_vol,
        concentration: Some(fields.concentration.unwrap_or(10000.0)),
        concentration_unit: Some(
            non_empty(&fields.concentration_unit).unwrap_or_else(|| "mM".into()),
        ),
        max_volume: Some(fields.max_volume.unwrap_or(1000.0)),
        max_volume_unit: Some(non_empty(&fields.max_volume_unit).unwrap_or_else(|| "nL".into())),
        class_id: Some(fields.class_id.unwrap_or(0)),
        color: fields.color,
        ..Fluid::default()
    };
    protocol.fluids.push(f);
    protocol.fluids.last_mut().unwrap()
}

/// Remove a fluid and every well value that uses it.
pub fn remove_fluid(protocol: &mut Protocol, id: i64) {
    protocol.fluids.retain(|f| f.id != id);
    for p in &mut protocol.plates {
        p.wells.retain(|_, m| {
            m.shift_remove(&id);
            !m.is_empty()
        });
    }
}

// ---------- well values ----------

/// Set one value; 0 (or NaN) removes the fluid from the well, and an emptied well is removed.
pub fn set_well(plate: &mut Plate, r: u32, c: u32, fluid_id: i64, value: f64) {
    let k = WellKey(r, c);
    if value == 0.0 || value.is_nan() {
        if let Some(m) = plate.wells.get_mut(&k) {
            m.shift_remove(&fluid_id);
            if m.is_empty() {
                plate.wells.shift_remove(&k);
            }
        }
        return;
    }
    plate.wells.entry(k).or_default().insert(fluid_id, value);
}

/// Wells in `cells` that already hold `fluid_id` (guide §3.1: ask Replace/Cancel).
pub fn conflicts(plate: &Plate, cells: &[Cell], fluid_id: i64) -> Vec<Cell> {
    cells
        .iter()
        .copied()
        .filter(|&(r, c)| {
            plate
                .wells
                .get(&WellKey(r, c))
                .is_some_and(|m| m.contains_key(&fluid_id))
        })
        .collect()
}

pub fn set_value(plate: &mut Plate, cells: &[Cell], fluid_id: i64, value: f64) {
    for &(r, c) in cells {
        set_well(plate, r, c, fluid_id, value);
    }
}

/// Clear the cells: all fluids (None) or one fluid.
pub fn clear_wells(plate: &mut Plate, cells: &[Cell], fluid_id: Option<i64>) {
    for &(r, c) in cells {
        match fluid_id {
            None => {
                plate.wells.shift_remove(&WellKey(r, c));
            }
            Some(id) => set_well(plate, r, c, id, 0.0),
        }
    }
}

// ---------- titration levels (§3.4) ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum TitrationMode {
    #[default]
    #[serde(rename = "highLow")]
    HighLow,
    #[serde(rename = "high")]
    High,
    #[serde(rename = "low")]
    Low,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Distribution {
    #[default]
    Log,
    Linear,
    HalfLog,
    ThirdLog,
    QuarterLog,
    Dilution,
}

/// `titrationLevels(o)` options. `factor` is for 'dilution' (e.g. 2 for 1:2), `increment` for 'linear'
/// in high/low modes. None behaves like JS undefined (fails the range checks).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TitrationOptions {
    pub mode: TitrationMode,
    pub high: Option<f64>,
    pub low: Option<f64>,
    pub levels: usize,
    pub distribution: Distribution,
    pub factor: Option<f64>,
    pub increment: Option<f64>,
}

/// Returns levels ordered high -> low.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn titration_levels(o: &TitrationOptions) -> Result<Vec<f64>> {
    let n = o.levels;
    if n < 1 {
        return Err(Error::new("Number of levels must be at least 1"));
    }
    let high = o.high.unwrap_or(f64::NAN);
    let low = o.low.unwrap_or(f64::NAN);
    let nf = n as f64;
    if o.mode == TitrationMode::HighLow {
        if !(high > low) {
            return Err(Error::new("Highest must be greater than lowest"));
        }
        if n == 1 {
            return Ok(vec![high]);
        }
        if o.distribution == Distribution::Linear {
            return Ok((0..n)
                .map(|i| high - ((high - low) * i as f64) / (nf - 1.0))
                .collect());
        }
        if !(low > 0.0) {
            return Err(Error::new(
                "Logarithmic titration needs a lowest value above 0",
            ));
        }
        let ratio = js_pow(high / low, 1.0 / (nf - 1.0));
        return Ok((0..n)
            .map(|i| {
                if i == n - 1 {
                    low
                } else {
                    high / js_pow(ratio, i as f64)
                }
            })
            .collect());
    }
    let ratio = step_ratio(o)?;
    let start = if o.mode == TitrationMode::High {
        high
    } else {
        low
    };
    if !(start > 0.0) {
        return Err(Error::new("Start value must be above 0"));
    }
    let vals: Vec<f64> = if o.distribution == Distribution::Linear {
        let inc = o.increment.unwrap_or(f64::NAN);
        if !(inc > 0.0) {
            return Err(Error::new("Linear titration needs an increment above 0"));
        }
        let v: Vec<f64> = (0..n)
            .map(|i| {
                if o.mode == TitrationMode::High {
                    start - inc * i as f64
                } else {
                    start + inc * i as f64
                }
            })
            .collect();
        if v.iter().any(|&x| x <= 0.0) {
            return Err(Error::new(
                "Linear titration reaches 0 or below; reduce the increment or the number of levels",
            ));
        }
        v
    } else {
        let ratio = ratio.unwrap();
        (0..n)
            .map(|i| {
                if o.mode == TitrationMode::High {
                    start / js_pow(ratio, i as f64)
                } else {
                    start * js_pow(ratio, i as f64)
                }
            })
            .collect()
    };
    Ok(if o.mode == TitrationMode::High {
        vals
    } else {
        vals.into_iter().rev().collect()
    })
}

#[allow(clippy::neg_cmp_op_on_partial_ord)]
fn step_ratio(o: &TitrationOptions) -> Result<Option<f64>> {
    Ok(match o.distribution {
        Distribution::HalfLog => Some(10f64.sqrt()), // UNVERIFIED: 1/2 Log = 10^(1/2) per step
        Distribution::ThirdLog => Some(10f64.cbrt()),
        Distribution::QuarterLog => Some(js_pow(10.0, 0.25)),
        Distribution::Log => Some(10.0),
        Distribution::Dilution => {
            let f = o.factor.unwrap_or(f64::NAN);
            if !(f > 1.0) {
                return Err(Error::new("Dilution factor must be greater than 1"));
            }
            Some(f)
        }
        Distribution::Linear => None,
    })
}

// ---------- targeted titration (§3.5) ----------

/// `targetedLevels` options: `range` is the half-width of the target region in log10 units.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TargetedOptions {
    pub high: f64,
    pub low: f64,
    pub levels: usize,
    pub target: f64,
    pub region: usize,
    pub range: f64,
}

/// Levels (high→low) for a Targeted Titration, logarithmic distribution. Confirmed with
/// fixtures/reference/t11-targeted.tdd (16 levels, 10 → 0.003 µM, target 0.5 µM, region 8, ±0.25 log):
///  - target region: `region` levels geometric from target·10^range down to target·10^-range (both included);
///  - remaining levels split between the tails in proportion to their log spans (rounded);
///  - high tail: geometric from `high` towards the region top (exclusive); low tail: from below the region
///    bottom down to `low` (inclusive).
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn targeted_levels(o: &TargetedOptions) -> Result<Vec<f64>> {
    let TargetedOptions {
        high,
        low,
        levels,
        target,
        region,
        range,
    } = *o;
    let top = target * js_pow(10.0, range);
    let bottom = target * js_pow(10.0, -range);
    if !(high > top && bottom > low) {
        return Err(Error::new(
            "The target range must lie inside the highest and lowest concentrations",
        ));
    }
    if !(region >= 2 && levels.checked_sub(2).is_some_and(|m| region <= m)) {
        return Err(Error::new(
            "Target region must leave at least one level for each end",
        ));
    }
    let rest = levels - region;
    let span_hi = (high / top).log10();
    let span_lo = (bottom / low).log10();
    let n_hi = js_round((rest as f64 * span_hi) / (span_hi + span_lo)); // UNVERIFIED: tie rounding
    let n_hi = js_min(js_max(n_hi, 1.0), rest as f64 - 1.0);
    let n_lo = rest as f64 - n_hi;
    let mut out = vec![];
    let rh = js_pow(high / top, 1.0 / n_hi);
    for k in 0..n_hi as usize {
        out.push(if k == 0 {
            high
        } else {
            high / js_pow(rh, k as f64)
        });
    }
    let rr = js_pow(top / bottom, 1.0 / (region as f64 - 1.0));
    for k in 0..region {
        out.push(if k == region - 1 {
            bottom
        } else {
            top / js_pow(rr, k as f64)
        });
    }
    let rl = js_pow(bottom / low, 1.0 / n_lo);
    for k in 1..=n_lo as usize {
        out.push(if k as f64 == n_lo {
            low
        } else {
            bottom / js_pow(rl, k as f64)
        });
    }
    Ok(out)
}

// ---------- titration placement (§3.4 titration pattern) ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    #[default]
    Rows,
    Cols,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Corner {
    #[default]
    TL,
    TR,
    BL,
    BR,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum TitrationPattern {
    #[default]
    #[serde(rename = "colsTL")]
    ColsTL,
    #[serde(rename = "colsTR")]
    ColsTR,
    #[serde(rename = "colsBL")]
    ColsBL,
    #[serde(rename = "colsBR")]
    ColsBR,
    #[serde(rename = "rowsTL")]
    RowsTL,
    #[serde(rename = "rowsTR")]
    RowsTR,
    #[serde(rename = "rowsBL")]
    RowsBL,
    #[serde(rename = "rowsBR")]
    RowsBR,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PatternInfo {
    pub pattern: TitrationPattern,
    pub key: &'static str,
    pub direction: Direction,
    pub corner: Corner,
    pub label: &'static str,
}

/// The 8 "Titration pattern" choices of D300e Control: levels flow along rows or down columns, starting at a
/// corner that holds the HIGHEST level. Every row (or column) runs in the same direction (pattern icons show
/// parallel bars, no serpentine; multi-line selections are UNVERIFIED because ranges cannot be selected over
/// Remote Desktop). Replicates of a level occupy consecutive wells along the flow.
/// Confirmed with fixtures/reference/t04-titration.tdd: row-wise from top-left (row B, 3 replicates),
/// column-wise from top-left (column 4) and from bottom (column 6), 2 replicates.
pub const TITRATION_PATTERNS: [PatternInfo; 8] = {
    use Corner::*;
    use Direction::*;
    use TitrationPattern as P;
    [
        PatternInfo {
            pattern: P::ColsTL,
            key: "colsTL",
            direction: Cols,
            corner: TL,
            label: "Down columns, highest top-left",
        },
        PatternInfo {
            pattern: P::ColsTR,
            key: "colsTR",
            direction: Cols,
            corner: TR,
            label: "Down columns, highest top-right",
        },
        PatternInfo {
            pattern: P::ColsBL,
            key: "colsBL",
            direction: Cols,
            corner: BL,
            label: "Up columns, highest bottom-left",
        },
        PatternInfo {
            pattern: P::ColsBR,
            key: "colsBR",
            direction: Cols,
            corner: BR,
            label: "Up columns, highest bottom-right",
        },
        PatternInfo {
            pattern: P::RowsTL,
            key: "rowsTL",
            direction: Rows,
            corner: TL,
            label: "Along rows, highest top-left",
        },
        PatternInfo {
            pattern: P::RowsTR,
            key: "rowsTR",
            direction: Rows,
            corner: TR,
            label: "Along rows, highest top-right",
        },
        PatternInfo {
            pattern: P::RowsBL,
            key: "rowsBL",
            direction: Rows,
            corner: BL,
            label: "Along rows, highest bottom-left",
        },
        PatternInfo {
            pattern: P::RowsBR,
            key: "rowsBR",
            direction: Rows,
            corner: BR,
            label: "Along rows, highest bottom-right",
        },
    ]
};

pub fn pattern_info(p: TitrationPattern) -> &'static PatternInfo {
    TITRATION_PATTERNS.iter().find(|x| x.pattern == p).unwrap()
}

/// Order cells along the flow (stable sort, as JS Array.prototype.sort).
pub fn order_cells(cells: &[Cell], direction: Direction, corner: Corner) -> Vec<Cell> {
    let rs: i64 = if matches!(corner, Corner::BL | Corner::BR) {
        -1
    } else {
        1
    };
    let cs: i64 = if matches!(corner, Corner::TR | Corner::BR) {
        -1
    } else {
        1
    };
    let mut s = cells.to_vec();
    let d = |a: u32, b: u32, sign: i64| (sign * (a as i64 - b as i64)).cmp(&0);
    match direction {
        Direction::Rows => s.sort_by(|a, b| d(a.0, b.0, rs).then(d(a.1, b.1, cs))),
        Direction::Cols => s.sort_by(|a, b| d(a.1, b.1, cs).then(d(a.0, b.0, rs))),
    }
    s
}

/// `applyTitration` options: `pattern` (default colsTL as in the JS); `direction` overrides the pattern's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TitrationPlacement {
    pub replicates: usize,
    pub pattern: TitrationPattern,
    pub direction: Option<Direction>,
    pub high_first: bool,
}

impl Default for TitrationPlacement {
    fn default() -> Self {
        TitrationPlacement {
            replicates: 1,
            pattern: TitrationPattern::ColsTL,
            direction: None,
            high_first: true,
        }
    }
}

pub fn apply_titration(
    plate: &mut Plate,
    cells: &[Cell],
    fluid_id: i64,
    levels: &[f64],
    o: &TitrationPlacement,
) -> Result<()> {
    if o.replicates == 0 || cells.len() % o.replicates != 0 {
        return Err(Error::new(format!(
            "The number of selected wells ({}) must be a multiple of replicates ({})",
            cells.len(),
            o.replicates
        )));
    }
    let n_levels = cells.len() / o.replicates;
    if levels.len() != n_levels {
        return Err(Error::new(format!(
            "Selection gives {n_levels} levels but {} values were supplied",
            levels.len()
        )));
    }
    let pat = pattern_info(o.pattern);
    let ordered = order_cells(cells, o.direction.unwrap_or(pat.direction), pat.corner);
    let lv: Vec<f64> = if o.high_first {
        levels.to_vec()
    } else {
        levels.iter().rev().copied().collect()
    };
    for (i, (r, c)) in ordered.into_iter().enumerate() {
        set_well(plate, r, c, fluid_id, lv[i / o.replicates]);
    }
    Ok(())
}

// ---------- fluid shift / extend (§3.6) ----------
const DILUTIONS: [f64; 35] = [
    2., 3., 4., 5., 6., 7., 8., 9., 10., 20., 30., 40., 50., 60., 70., 80., 90., 100., 200., 300.,
    400., 500., 600., 700., 800., 900., 1000., 2000., 3000., 4000., 5000., 6000., 7000., 8000.,
    9000.,
];

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ShiftSuggestion {
    Impossible,
    Shift { factor: f64 },
    Extend { factor: f64 },
}

/// Suggest a shift (one diluted fluid covers the range) or extension (stock + diluted). INFERRED rule,
/// fits both guide examples. None = the stock covers the range.
pub fn suggest_shift(fluid: &Fluid, plate: &Plate, high: f64, low: f64) -> Option<ShiftSuggestion> {
    let vr = valid_range(fluid, plate, 1.0);
    if low >= vr.min * (1.0 - 1e-9) {
        return None;
    }
    let need = vr.min / low;
    let Some(&d) = DILUTIONS.iter().find(|&&x| x >= need * (1.0 - 1e-9)) else {
        return Some(ShiftSuggestion::Impossible);
    };
    let diluted_max = vr.max / d;
    Some(if high <= diluted_max * (1.0 + 1e-9) {
        ShiftSuggestion::Shift { factor: d }
    } else {
        ShiftSuggestion::Extend { factor: d }
    })
}

/// Saved by D300e Control as <RootFluidID> and <DilutionFactor> right after <Name> (T01, fluid "Fluid 1 - 1:300").
pub fn diluted_fluid<'a>(protocol: &'a mut Protocol, fluid: &Fluid, factor: f64) -> &'a mut Fluid {
    let fields = FluidFields {
        // JS template string: `${fluid.name} - 1:${factor}`
        name: Some(format!(
            "{} - 1:{}",
            fluid.name.as_deref().unwrap_or("undefined"),
            to_js_string(factor)
        )),
        by_vol: fluid.by_vol,
        concentration: Some(fluid.concentration.unwrap_or(f64::NAN) / factor),
        concentration_unit: fluid.concentration_unit.clone(),
        max_volume: fluid.max_volume,
        max_volume_unit: fluid.max_volume_unit.clone(),
        class_id: fluid.class_id,
        color: None,
    };
    let f = add_fluid(protocol, &fields);
    f.root_fluid_id = Some(fluid.root_fluid_id.unwrap_or(fluid.id));
    f.dilution_factor = Some(fluid.dilution_factor.unwrap_or(1.0) * factor);
    f
}

// ---------- synergy (§4.1) ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum SynergyType {
    /// fluids[0] down rows, fluids[1] across columns, fluids[2..] combinations
    #[default]
    #[serde(rename = "ABC")]
    Abc,
    /// fluids[0] primary (rows), each of fluids[1..] crossed separately (columns)
    #[serde(rename = "AxEach")]
    AxEach,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SynergyLayout {
    Single,
    #[default]
    Multiple,
    MultipleBreaks,
    NoEmpty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AxisOrder {
    #[default]
    HighFirst,
    LowFirst,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SynergyFluid {
    pub fluid_id: i64,
    /// high -> low values
    pub levels: Vec<f64>,
    pub include_zero: bool,
    pub order: AxisOrder,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SynergySpec {
    #[serde(rename = "type")]
    pub kind: SynergyType,
    pub fluids: Vec<SynergyFluid>,
    /// template plate fields (plateType, assayVolume, dmsoLimit)
    pub plate: PlateTemplate,
    pub excluded_rows: BTreeSet<u32>,
    pub excluded_cols: BTreeSet<u32>,
    pub layout: SynergyLayout,
    /// None behaves as in the JS when gridOrder is undefined: column-first slots for 'noEmpty',
    /// row-first grid packing otherwise.
    pub grid_order: Option<Direction>,
}

struct Grid {
    row_fluid: i64,
    row_vals: Vec<f64>,
    col_fluid: i64,
    col_vals: Vec<f64>,
    extras: Vec<(i64, f64)>,
}

fn axis(f: &SynergyFluid) -> Vec<f64> {
    let mut v = f.levels.clone();
    // Include "0": 0 is the LAST (lowest) of the requested levels, i.e. N levels = N-1 nonzero + 0.
    // Confirmed with fixtures/reference/t06-synergy.tdd: 6 levels 50→0.05 log = 50, 8.89, 1.58, 0.281, 0.05, 0.
    // Callers pass the nonzero levels (see synergy_levels()).
    if f.include_zero {
        v.push(0.0);
    }
    if f.order == AxisOrder::LowFirst {
        v.reverse();
    }
    v
}

fn put_cell(plate: &mut Plate, g: &Grid, r: u32, c: u32, i: usize, j: usize) {
    set_well(plate, r, c, g.row_fluid, g.row_vals[i]);
    set_well(plate, r, c, g.col_fluid, g.col_vals[j]);
    for &(id, v) in &g.extras {
        set_well(plate, r, c, id, v);
    }
}

/// Build synergy plates. Returns new plates (not yet added to the protocol).
pub fn build_synergy(spec: &SynergySpec) -> Result<Vec<Plate>> {
    let tmpl = new_plate(&spec.plate)?;
    let rows_avail: Vec<u32> = (0..tmpl.rows)
        .filter(|r| !spec.excluded_rows.contains(r))
        .collect();
    let cols_avail: Vec<u32> = (0..tmpl.cols)
        .filter(|c| !spec.excluded_cols.contains(c))
        .collect();
    let Some((a, rest)) = spec.fluids.split_first() else {
        return Err(Error::new("Synergy needs at least two fluids"));
    };
    let mut grids: Vec<Grid> = vec![];
    if spec.kind == SynergyType::AxEach {
        for b in rest {
            grids.push(Grid {
                row_fluid: a.fluid_id,
                row_vals: axis(a),
                col_fluid: b.fluid_id,
                col_vals: axis(b),
                extras: vec![],
            });
        }
    } else {
        let Some((b, others)) = rest.split_first() else {
            return Err(Error::new("Synergy needs at least two fluids"));
        };
        // Combinations of fluids 3+, odometer order with the 3rd fluid varying fastest (INFERRED,
        // consistent with "plate breaks keep titration sequences together").
        let vals: Vec<Vec<f64>> = others.iter().map(axis).collect();
        let total: usize = vals.iter().map(Vec::len).product();
        let mut idx = vec![0usize; others.len()];
        for _ in 0..total {
            let extras = others
                .iter()
                .enumerate()
                .map(|(i, f)| (f.fluid_id, vals[i][idx[i]]))
                .collect();
            grids.push(Grid {
                row_fluid: a.fluid_id,
                row_vals: axis(a),
                col_fluid: b.fluid_id,
                col_vals: axis(b),
                extras,
            });
            for i in 0..idx.len() {
                idx[i] += 1;
                if idx[i] < vals[i].len() {
                    break;
                }
                idx[i] = 0;
            }
        }
    }
    // (JS crashes with a TypeError on these; it would hang on an empty axis.)
    if grids.is_empty() {
        return Err(Error::new(
            "Synergy needs at least two fluids, each with at least one level",
        ));
    }
    let gh = grids[0].row_vals.len();
    let gw = grids[0].col_vals.len();
    if gh == 0 || gw == 0 {
        return Err(Error::new("Synergy axis has no levels"));
    }
    if gh > rows_avail.len() || gw > cols_avail.len() {
        return Err(Error::new(format!(
            "Synergy grid {gh}×{gw} does not fit the {}×{} available wells",
            rows_avail.len(),
            cols_avail.len()
        )));
    }

    let mut plates: Vec<Plate> = vec![];
    // plate named "Synergy" (T06)
    let fresh_tmpl = PlateTemplate {
        name: Some(spec.plate.name.clone().unwrap_or_else(|| "Synergy".into())),
        ..spec.plate.clone()
    };
    let fresh = |plates: &mut Vec<Plate>| -> Result<()> {
        plates.push(new_plate(&fresh_tmpl)?);
        Ok(())
    };

    if spec.layout == SynergyLayout::NoEmpty {
        // Fill all available wells along columns from A1 (or rows), no gaps (§4.1 option 1).
        let slots: Vec<Cell> = if spec.grid_order == Some(Direction::Rows) {
            rows_avail
                .iter()
                .flat_map(|&r| cols_avail.iter().map(move |&c| (r, c)))
                .collect()
        } else {
            cols_avail
                .iter()
                .flat_map(|&c| rows_avail.iter().map(move |&r| (r, c)))
                .collect()
        };
        fresh(&mut plates)?;
        let mut s = 0;
        for g in &grids {
            for i in 0..gh {
                for j in 0..gw {
                    if s == slots.len() {
                        fresh(&mut plates)?;
                        s = 0;
                    }
                    let (r, c) = slots[s];
                    s += 1;
                    put_cell(plates.last_mut().unwrap(), g, r, c, i, j);
                }
            }
        }
        return Ok(plates);
    }

    // grid slots on a plate (packed in available rows/cols)
    let per_col = rows_avail.len() / gh;
    let per_row = cols_avail.len() / gw;
    let capacity = if spec.layout == SynergyLayout::Single {
        1
    } else {
        per_col * per_row
    };
    let mut slot_origins: Vec<(usize, usize)> = vec![];
    if spec.grid_order == Some(Direction::Cols) {
        for x in 0..per_row {
            for y in 0..per_col {
                slot_origins.push((y, x));
            }
        }
    } else {
        for y in 0..per_col {
            for x in 0..per_row {
                slot_origins.push((y, x));
            }
        }
    }

    let mut per_plate = capacity;
    if spec.layout == SynergyLayout::MultipleBreaks && spec.kind != SynergyType::AxEach {
        // INFERRED: largest prefix product of the levels of fluids 3, 4, ... that fits (§4.1, fits both guide examples)
        let counts: Vec<usize> = spec.fluids.iter().skip(2).map(|f| axis(f).len()).collect();
        let mut prod = 1;
        per_plate = 1;
        for n in counts {
            prod *= n;
            if prod <= capacity {
                per_plate = prod;
            } else {
                break;
            }
        }
    }
    for (gi, g) in grids.iter().enumerate() {
        let slot = gi % per_plate;
        if slot == 0 {
            fresh(&mut plates)?;
        }
        let (gy, gx) = slot_origins[slot];
        let plate = plates.last_mut().unwrap();
        for i in 0..gh {
            for j in 0..gw {
                put_cell(
                    plate,
                    g,
                    rows_avail[gy * gh + i],
                    cols_avail[gx * gw + j],
                    i,
                    j,
                );
            }
        }
    }
    Ok(plates)
}

/// Levels for one synergy axis as D300e Control computes them: with Include "0", the N requested
/// levels (`titration.levels`) are N-1 titrated values (high→low) plus 0. Returns the nonzero levels.
pub fn synergy_levels(titration: &TitrationOptions, include_zero: bool) -> Result<Vec<f64>> {
    let n = if include_zero {
        titration.levels as i64 - 1
    } else {
        titration.levels as i64
    };
    if n < 1 {
        return Err(Error::new(
            "Synergy needs at least 2 levels when \"0\" is included",
        ));
    }
    titration_levels(&TitrationOptions {
        levels: n as usize,
        ..titration.clone()
    })
}

// ---------- Quick Plate (§4.2) ----------

/// How fluids are interleaved in a Quick Plate (JS `interleave`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Interleave {
    #[default]
    #[serde(rename = "none")]
    NoInterleave,
    /// keep together: change fluid after each level replicate
    Level,
    /// not together: change fluid after each singlicate
    Singlicate,
    Well,
}

/// Where a new series starts (example-layout options 1 and 3, confirmed with T08).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QuickStart {
    #[default]
    Continuous,
    NewLine,
}

/// `buildQuickPlate(spec)`: fluids (IDs), levels (high→low), replicates (0 = 1 as JS `|| 1`),
/// order, layout (`Cols` = by columns, otherwise by rows), keepReplicatesTogether, interleave, start.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QuickPlateSpec {
    pub fluids: Vec<i64>,
    pub levels: Vec<f64>,
    pub replicates: usize,
    pub order: AxisOrder,
    pub layout: Direction,
    pub keep_replicates_together: bool,
    pub interleave: Interleave,
    pub start: QuickStart,
    pub plate: PlateTemplate,
    pub excluded_rows: BTreeSet<u32>,
    pub excluded_cols: BTreeSet<u32>,
}

/// Build Quick Plate plates: the same titration for several fluids.
/// Confirmed with fixtures/reference/t08-quickplate.tdd (1 fluid, by rows, replicates not together:
/// option 1 = series end to end along the row, option 3 = each series on a new row; plates named
/// "Quick Plate"). Interleave modes follow the guide text and its three worked examples (tests).
pub fn build_quick_plate(spec: &QuickPlateSpec) -> Result<Vec<Plate>> {
    let fl = &spec.fluids;
    let rep = if spec.replicates == 0 {
        1
    } else {
        spec.replicates
    };
    let lv: Vec<f64> = if spec.order == AxisOrder::LowFirst {
        spec.levels.iter().rev().copied().collect()
    } else {
        spec.levels.clone()
    };
    let n = lv.len();
    // (fluid, level index, unit) in placement order; a new unit may start a new line. The JS unit is a
    // string such as `${r}:${f}`; within one mode a (tag, a, b) tuple compares the same way.
    let mut items: Vec<(i64, usize, (u8, i64, i64))> = vec![];
    if !spec.keep_replicates_together {
        match spec.interleave {
            Interleave::Singlicate => {
                for r in 0..rep {
                    for &f in fl {
                        for l in 0..n {
                            items.push((f, l, (0, r as i64, f)));
                        }
                    }
                }
            }
            Interleave::Well => {
                for r in 0..rep {
                    for l in 0..n {
                        for &f in fl {
                            items.push((f, l, (1, r as i64, l as i64)));
                        }
                    }
                }
            }
            _ => {
                for &f in fl {
                    for r in 0..rep {
                        for l in 0..n {
                            items.push((f, l, (2, f, r as i64)));
                        }
                    }
                }
            }
        }
    } else {
        match spec.interleave {
            Interleave::Level => {
                for l in 0..n {
                    for &f in fl {
                        for _ in 0..rep {
                            items.push((f, l, (3, l as i64, 0)));
                        }
                    }
                }
            }
            Interleave::Well => {
                for l in 0..n {
                    for r in 0..rep {
                        for &f in fl {
                            items.push((f, l, (4, l as i64, r as i64)));
                        }
                    }
                }
            }
            _ => {
                for &f in fl {
                    for l in 0..n {
                        for _ in 0..rep {
                            items.push((f, l, (5, f, 0)));
                        }
                    }
                }
            }
        }
    }
    let tmpl = new_plate(&spec.plate)?;
    let rows: Vec<u32> = (0..tmpl.rows)
        .filter(|r| !spec.excluded_rows.contains(r))
        .collect();
    let cols: Vec<u32> = (0..tmpl.cols)
        .filter(|c| !spec.excluded_cols.contains(c))
        .collect();
    let by_rows = spec.layout != Direction::Cols;
    let (line_len, n_lines) = if by_rows {
        (cols.len(), rows.len())
    } else {
        (rows.len(), cols.len())
    };
    if line_len == 0 || n_lines == 0 {
        return Err(Error::new("No wells available on the plate"));
    }
    let fresh_tmpl = PlateTemplate {
        name: Some(
            spec.plate
                .name
                .clone()
                .unwrap_or_else(|| "Quick Plate".into()),
        ),
        ..spec.plate.clone()
    };
    let mut plates = vec![new_plate(&fresh_tmpl)?];
    let (mut line, mut pos) = (0usize, 0usize);
    let mut last_unit = None;
    for &(f, l, unit) in &items {
        if spec.start == QuickStart::NewLine && last_unit.is_some_and(|u| u != unit) && pos > 0 {
            line += 1;
            pos = 0;
        }
        if pos == line_len {
            line += 1;
            pos = 0;
        }
        if line == n_lines {
            plates.push(new_plate(&fresh_tmpl)?);
            line = 0;
            pos = 0;
        }
        let (r, c) = if by_rows {
            (rows[line], cols[pos])
        } else {
            (rows[pos], cols[line])
        };
        set_well(plates.last_mut().unwrap(), r, c, f, lv[l]);
        pos += 1;
        last_unit = Some(unit);
    }
    Ok(plates)
}

// ---------- randomization (§3.8; storage confirmed with T09) ----------

/// Randomize wells on a plate. "Randomization is a per plate feature"; adding wells re-randomizes them
/// together with the plate's existing randomized wells as one group. `rng()` returns [0,1)
/// (JS default Math.random; inject one for reproducibility).
pub fn randomize_wells<'a>(
    plate: &'a mut Plate,
    cells: &[Cell],
    rng: &mut dyn FnMut() -> f64,
) -> &'a [RandomMap] {
    let mut keys: IndexMap<WellKey, Cell> = plate
        .randomization
        .iter()
        .map(|m| (WellKey(m.r, m.c), (m.r, m.c)))
        .collect();
    for &(r, c) in cells {
        keys.insert(WellKey(r, c), (r, c));
    }
    let mut from: Vec<Cell> = keys.into_values().collect();
    from.sort(); // (r, c); keys are unique, so stability does not matter
    let mut to = from.clone();
    for i in (1..to.len()).rev() {
        let j = (rng() * (i + 1) as f64).floor() as usize; // Fisher-Yates
        to.swap(i, j);
    }
    plate.randomization = from
        .iter()
        .zip(&to)
        .map(|(&(r, c), &(tr, tc))| RandomMap {
            r,
            c,
            to_r: tr,
            to_c: tc,
        })
        .collect();
    &plate.randomization
}

pub fn remove_randomization(plate: &mut Plate) {
    plate.randomization.clear();
}

/// Dispensed (randomized) position of a design well.
pub fn dispensed_well(plate: &Plate, r: u32, c: u32) -> Cell {
    plate
        .randomization
        .iter()
        .find(|m| m.r == r && m.c == c)
        .map_or((r, c), |m| (m.to_r, m.to_c))
}

// ---------- normalization (§3.7 / §5) ----------
/// XML type names confirmed with fixtures/reference/t05-normalize.tdd.
pub const NORMALIZE_TYPES: [(&str, &str); 5] = [
    ("ToMaxVolume", "Fluid class: to highest class volume"),
    ("ToVolume", "Fluid class: to specified volume (nL)"),
    ("ToAssayVolumePct", "Fluid class: to % of total volume"),
    ("ToMaxTotalVolume", "Total volume: to highest total volume"),
    (
        "ToTotalVolume",
        "Total volume: to specified total volume (nL)",
    ),
];
pub const NORMALIZE_PARAM: [(&str, &str); 3] = [
    ("ToVolume", "nL"),
    ("ToAssayVolumePct", "%"),
    ("ToTotalVolume", "nL"),
];

/// Add a normalization group. "only one group for each fluid class" per well: the well is removed from
/// other groups of that class. Empty groups (of any class) are dropped.
pub fn add_normalization<'a>(
    protocol: &'a mut Protocol,
    class_id: i64,
    kind: &str,
    param: Option<f64>,
    wells: &[BackfillWell],
) -> &'a mut Backfill {
    let keys: HashSet<BackfillWell> = wells.iter().copied().collect();
    for b in protocol
        .backfills
        .iter_mut()
        .filter(|b| b.class_id == class_id)
    {
        b.wells.retain(|w| !keys.contains(w));
    }
    protocol.backfills.retain(|b| !b.wells.is_empty());
    protocol.backfills.push(Backfill {
        class_id,
        kind: kind.to_string(),
        param,
        param_text: None,
        wells: wells.to_vec(),
    });
    protocol.backfills.last_mut().unwrap()
}

pub fn remove_normalization(protocol: &mut Protocol, wells: &[BackfillWell]) {
    let keys: HashSet<BackfillWell> = wells.iter().copied().collect();
    for b in &mut protocol.backfills {
        b.wells.retain(|w| !keys.contains(w));
    }
    protocol.backfills.retain(|b| !b.wells.is_empty());
}

// ---------- plates ----------

pub fn remove_plate(protocol: &mut Protocol, index: usize) {
    if index < protocol.plates.len() {
        protocol.plates.remove(index); // JS splice: no-op when out of range
    }
    for b in &mut protocol.backfills {
        b.wells.retain(|w| w.p as usize != index);
        for w in &mut b.wells {
            if w.p as usize > index {
                w.p -= 1;
            }
        }
    }
    protocol.backfills.retain(|b| !b.wells.is_empty());
}

/// Append a copy of a plate (wells, layout and randomization included — guide: includes randomization),
/// adding the copy's wells to the source's normalization groups. Returns the new plate's index.
pub fn replicate_plate(protocol: &mut Protocol, index: usize) -> Result<usize> {
    let copy = protocol
        .plates
        .get(index)
        .cloned()
        .ok_or_else(|| Error::new(format!("No plate {index}")))?;
    protocol.plates.push(copy);
    let ni = (protocol.plates.len() - 1) as u32;
    for b in &mut protocol.backfills {
        let add: Vec<BackfillWell> = b
            .wells
            .iter()
            .filter(|w| w.p as usize == index)
            .map(|w| BackfillWell { p: ni, ..*w })
            .collect();
        b.wells.extend(add);
    }
    Ok(ni as usize)
}

pub fn clear_plate(protocol: &mut Protocol, index: usize) -> Result<()> {
    protocol
        .plates
        .get_mut(index)
        .ok_or_else(|| Error::new(format!("No plate {index}")))?
        .wells
        .clear();
    let wells: Vec<BackfillWell> = protocol
        .backfills
        .iter()
        .flat_map(|b| b.wells.iter().filter(|w| w.p as usize == index).copied())
        .collect();
    remove_normalization(protocol, &wells);
    Ok(())
}

// ---------- copy / paste (§3.9) ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClipItem {
    pub dr: u32,
    pub dc: u32,
    pub fluids: WellFluids,
}

pub fn copy_wells(plate: &Plate, cells: &[Cell]) -> Vec<ClipItem> {
    let r0 = cells.iter().map(|x| x.0).min().unwrap_or(0);
    let c0 = cells.iter().map(|x| x.1).min().unwrap_or(0);
    cells
        .iter()
        .map(|&(r, c)| ClipItem {
            dr: r - r0,
            dc: c - c0,
            fluids: plate.wells.get(&WellKey(r, c)).cloned().unwrap_or_default(),
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PasteResult {
    pub truncated: usize,
}

pub fn paste_wells(plate: &mut Plate, clip: &[ClipItem], r0: u32, c0: u32) -> PasteResult {
    let mut truncated = 0;
    for item in clip {
        let (r, c) = (r0 as u64 + item.dr as u64, c0 as u64 + item.dc as u64);
        if r >= plate.rows as u64 || c >= plate.cols as u64 {
            truncated += 1;
            continue;
        }
        let k = WellKey(r as u32, c as u32);
        if !item.fluids.is_empty() {
            plate.wells.insert(k, item.fluids.clone());
        } else {
            plate.wells.shift_remove(&k); // overwrite without warning
        }
    }
    PasteResult { truncated }
}

/// Tab-separated grid for Excel (one block per fluid), guide Appendix B style (UNVERIFIED exact format).
pub fn plate_to_tsv(plate: &Plate, fluid: &Fluid) -> String {
    let mut lines = vec![];
    let mut head = vec![String::new()];
    head.extend((0..plate.cols).map(|c| (c + 1).to_string()));
    lines.push(head.join("\t"));
    for r in 0..plate.rows {
        let mut row = vec![char::from_u32(65 + (r % 26)).unwrap().to_string()];
        for c in 0..plate.cols {
            let v = plate
                .wells
                .get(&WellKey(r, c))
                .and_then(|m| m.get(&fluid.id))
                .copied();
            row.push(if truthy(v) {
                to_js_string(v.unwrap())
            } else {
                String::new()
            });
        }
        lines.push(row.join("\t"));
    }
    lines.join("\n")
}
