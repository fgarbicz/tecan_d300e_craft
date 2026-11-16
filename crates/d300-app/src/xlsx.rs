// .xlsx writer for the readout analysis workbook built by src/analysis.js toWorkbook().
//
// The JS side owns every number and label; this module only lays them out:
//   * a bold header row from `columns` (unless `header: false`), column widths, an optional Excel
//     number format per column (display only: the stored value keeps full precision);
//   * numbers are written as numbers, strings as strings — chosen by the JSON type only, never by
//     looking at the text (a cell line called "123" stays text); null leaves the cell empty;
//   * freeze panes, autofilter over header + data on table sheets, bold rows (titles inside a sheet).
// Kept free of Tauri so it can be tested and driven from examples/xlsx_from_json.rs.

use rust_xlsxwriter::{Format, Workbook as XlsxBook};
use serde::Deserialize;

/// Excel's cell text limit (UTF-16 code units). Longer text is cut with an ellipsis instead of failing.
const MAX_CELL_CHARS: usize = 32_767;

#[derive(Debug, Deserialize)]
pub struct Workbook {
    pub sheets: Vec<Sheet>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sheet {
    pub name: String,
    #[serde(default)]
    pub columns: Vec<Column>,
    #[serde(default)]
    pub rows: Vec<Vec<Cell>>,
    /// [row, col] of the first scrolling cell; [0, 0] or missing = no freeze.
    #[serde(default)]
    pub freeze: Option<[u32; 2]>,
    #[serde(default)]
    pub autofilter: bool,
    /// Indices into `rows` written bold (block titles).
    #[serde(default)]
    pub bold_rows: Vec<usize>,
    /// Write the header row (default true).
    #[serde(default = "yes")]
    pub header: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub struct Column {
    #[serde(default)]
    pub header: String,
    #[serde(default)]
    pub width: Option<f64>,
    /// Excel number format for the data cells of this column, e.g. "0.0".
    #[serde(default)]
    pub format: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Cell {
    Number(f64),
    Text(String),
    Empty(()),
}

fn clip(s: &str) -> String {
    if s.encode_utf16().count() <= MAX_CELL_CHARS {
        return s.to_string();
    }
    let mut out = String::new();
    let mut n = 0;
    for ch in s.chars() {
        n += ch.len_utf16();
        if n > MAX_CELL_CHARS - 1 {
            break;
        }
        out.push(ch);
    }
    out.push('…');
    out
}

fn ctx<T, E: std::fmt::Display>(r: Result<T, E>, what: &str) -> Result<T, String> {
    r.map_err(|e| format!("Excel export failed ({what}): {e}"))
}

/// Build the .xlsx file in memory.
pub fn write_workbook(wb: &Workbook) -> Result<Vec<u8>, String> {
    if wb.sheets.is_empty() {
        return Err("Excel export failed: the workbook has no sheets".into());
    }
    let mut book = XlsxBook::new();
    let bold = Format::new().set_bold();
    for sheet in &wb.sheets {
        let ws = book.add_worksheet();
        ctx(ws.set_name(&sheet.name), &format!("sheet name \"{}\"", sheet.name))?;
        let formats: Vec<Option<Format>> = sheet
            .columns
            .iter()
            .map(|c| c.format.as_ref().filter(|f| !f.is_empty()).map(|f| Format::new().set_num_format(f)))
            .collect();
        for (i, c) in sheet.columns.iter().enumerate() {
            let col = ctx(u16::try_from(i), "too many columns")?;
            if let Some(w) = c.width.filter(|w| w.is_finite() && *w > 0.0) {
                ctx(ws.set_column_width(col, w), "column width")?;
            }
        }
        let mut row0: u32 = 0;
        if sheet.header && !sheet.columns.is_empty() {
            for (i, c) in sheet.columns.iter().enumerate() {
                ctx(ws.write_string_with_format(0, i as u16, clip(&c.header), &bold), "header")?;
            }
            row0 = 1;
        }
        let mut max_cols = sheet.columns.len();
        for (ri, row) in sheet.rows.iter().enumerate() {
            let r = row0 + ctx(u32::try_from(ri), "too many rows")?;
            let is_bold = sheet.bold_rows.contains(&ri);
            max_cols = max_cols.max(row.len());
            for (ci, cell) in row.iter().enumerate() {
                let c = ctx(u16::try_from(ci), "too many columns")?;
                let fmt = if is_bold { Some(&bold) } else { formats.get(ci).and_then(|f| f.as_ref()) };
                match (cell, fmt) {
                    (Cell::Number(x), Some(f)) => ctx(ws.write_number_with_format(r, c, *x, f).map(|_| ()), "number")?,
                    (Cell::Number(x), None) => ctx(ws.write_number(r, c, *x).map(|_| ()), "number")?,
                    (Cell::Text(s), Some(f)) if is_bold => ctx(ws.write_string_with_format(r, c, clip(s), f).map(|_| ()), "text")?,
                    // a column's number format does not apply to text cells in it
                    (Cell::Text(s), _) => ctx(ws.write_string(r, c, clip(s)).map(|_| ()), "text")?,
                    (Cell::Empty(()), _) => {}
                }
            }
        }
        if let Some([fr, fc]) = sheet.freeze {
            if fr > 0 || fc > 0 {
                ctx(ws.set_freeze_panes(fr, ctx(u16::try_from(fc), "freeze column")?), "freeze panes")?;
            }
        }
        if sheet.autofilter && sheet.header && max_cols > 0 {
            let last_row = row0 - 1 + sheet.rows.len() as u32;
            ctx(ws.autofilter(0, 0, last_row, (max_cols - 1) as u16), "autofilter")?;
        }
    }
    ctx(book.save_to_buffer(), "write")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Workbook {
        serde_json::from_str(
            r#"{ "sheets": [
              { "name": "Info", "freeze": [0, 0], "columns": [{ "header": "Item", "width": 16 }, { "header": "Value", "width": 60 }],
                "rows": [["Experiment", "Test"], ["Cell line", "123"]] },
              { "name": "Wells", "freeze": [1, 2], "autofilter": true,
                "columns": [{ "header": "Well", "width": 6 }, { "header": "Viability %", "width": 10, "format": "0.0" }],
                "rows": [["A1", 99.5], ["A2", null], ["A3", -1.25e-7]] },
              { "name": "Synergy (Bliss)", "freeze": [1, 1], "autofilter": true,
                "columns": [{ "header": "Cell line" }, { "header": "Bliss excess", "format": "0.000" }], "rows": [] },
              { "name": "Synergy matrix", "header": false, "boldRows": [0], "columns": [{ "header": "", "width": 20 }],
                "rows": [["Title"], ["x", 1, 2], []] }
            ] }"#,
        )
        .unwrap()
    }

    #[test]
    fn cells_keep_their_json_type() {
        let wb = sample();
        assert!(matches!(wb.sheets[0].rows[1][1], Cell::Text(ref s) if s == "123"));
        assert!(matches!(wb.sheets[1].rows[0][1], Cell::Number(x) if x == 99.5));
        assert!(matches!(wb.sheets[1].rows[1][1], Cell::Empty(())));
        assert!(wb.sheets[0].header && !wb.sheets[3].header);
        assert_eq!(wb.sheets[3].bold_rows, vec![0]);
    }

    #[test]
    fn numbers_parse_exactly() {
        // needs serde_json's float_roundtrip feature: the default parser is 1 ulp off for this value
        let c: Cell = serde_json::from_str("0.059964021587047764").unwrap();
        assert!(matches!(c, Cell::Number(x) if x == 0.059964021587047764_f64));
        let c: Cell = serde_json::from_str("3764.9999999999995").unwrap();
        assert!(matches!(c, Cell::Number(x) if x == 3764.9999999999995_f64));
    }

    #[test]
    fn writes_a_zip_to_disk() {
        let bytes = write_workbook(&sample()).unwrap();
        let dir = std::env::temp_dir().join(format!("d300-xlsx-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sample.xlsx");
        std::fs::write(&path, &bytes).unwrap();
        let back = std::fs::read(&path).unwrap();
        assert!(back.len() > 1000, "suspiciously small file: {} bytes", back.len());
        assert_eq!(&back[..2], b"PK");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn invalid_sheet_names_and_empty_workbooks_are_errors() {
        let mut wb = sample();
        wb.sheets[0].name = "bad/name".into();
        assert!(write_workbook(&wb).unwrap_err().contains("sheet name"));
        assert!(write_workbook(&Workbook { sheets: vec![] }).is_err());
    }

    #[test]
    fn long_text_is_clipped_not_refused() {
        let s = "x".repeat(40_000);
        let c = clip(&s);
        assert_eq!(c.encode_utf16().count(), MAX_CELL_CHARS);
        assert!(c.ends_with('…'));
        assert_eq!(clip("short"), "short");
    }
}
