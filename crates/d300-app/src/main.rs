// Tecan D300 Craft — desktop shell.
//
// The interface (web-dist/app) runs the design operations; everything that touches files goes
// through these Rust commands, which use the d300-core engine:
//   * open_tdd  — native Open dialog, reads the file and checks it parses as a D300e protocol;
//   * save_tdd  — CROSS-CHECK before writing: the Rust engine re-parses the text produced by the
//                 interface and must re-write it byte-identically, otherwise nothing is written.
//                 Both engines are tested to be identical, so a failure here means a regression
//                 and must never reach the dispenser;
//   * save_sidecar — the experiment file "<name>.craft.json" next to the .tdd (cell lines, PBS border, roles,
//                 readouts); open_tdd returns it when it exists. The .tdd itself never carries this data;
//   * save_text — CSV export;
//   * save_xlsx — Excel export of a readout analysis (workbook model from src/analysis.js, see xlsx.rs).
// Files are written atomically (temporary file + rename) so a failed save never truncates a protocol.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod xlsx;

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};

#[derive(Serialize)]
struct Opened {
    path: String,
    name: String,
    text: String,
    /// Contents of the experiment file next to the protocol, if there is one.
    sidecar: Option<String>,
}

/// "<dir>/<stem>.craft.json" for "<dir>/<stem>.tdd".
fn sidecar_path(tdd: &Path) -> PathBuf {
    let stem = tdd.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    tdd.with_file_name(format!("{stem}.craft.json"))
}

fn to_path(fp: FilePath) -> Result<PathBuf, String> {
    fp.into_path().map_err(|e| format!("Unsupported file location: {e}"))
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("Invalid destination folder")?;
    let tmp = dir.join(format!(".{}.d300tmp", file_name(path)));
    std::fs::write(&tmp, bytes).map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Could not replace {}: {e}", path.display())
    })
}

/// The Rust engine must reproduce the interface's output exactly before anything is written.
fn cross_check(text: &str) -> Result<(), String> {
    let protocol = d300_core::tdd::parse_tdd(text).map_err(|e| format!("Protocol check failed (parse): {e}"))?;
    let again = d300_core::tdd::write_tdd(&protocol).map_err(|e| format!("Protocol check failed (write): {e}"))?;
    if again != text {
        let at = again.bytes().zip(text.bytes()).position(|(a, b)| a != b).unwrap_or(again.len().min(text.len()));
        return Err(format!(
            "Protocol check failed: the Rust engine writes this protocol differently (first difference at byte {at}). \
             Nothing was saved. Please report this file."
        ));
    }
    Ok(())
}

#[tauri::command]
async fn open_tdd(app: AppHandle) -> Result<Option<Opened>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("D300e protocol", &["tdd"])
        .blocking_pick_file();
    let Some(fp) = picked else { return Ok(None) };
    let path = to_path(fp)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let text = String::from_utf8(bytes).map_err(|_| format!("{} is not a UTF-8 text file", file_name(&path)))?;
    d300_core::tdd::parse_tdd(&text).map_err(|e| format!("{} is not a valid D300e protocol: {e}", file_name(&path)))?;
    // A missing or unreadable experiment file is not an error: the protocol opens without annotations.
    let sidecar = std::fs::read_to_string(sidecar_path(&path)).ok();
    Ok(Some(Opened { name: file_name(&path), path: path.to_string_lossy().into_owned(), text, sidecar }))
}

#[tauri::command]
async fn save_tdd(app: AppHandle, path: Option<String>, suggested: String, text: String) -> Result<Option<Opened>, String> {
    cross_check(&text)?;
    let path = match path {
        Some(p) => PathBuf::from(p),
        None => {
            let picked = app
                .dialog()
                .file()
                .add_filter("D300e protocol", &["tdd"])
                .set_file_name(&suggested)
                .blocking_save_file();
            let Some(fp) = picked else { return Ok(None) };
            let mut p = to_path(fp)?;
            if p.extension().map(|e| e != "tdd").unwrap_or(true) {
                p.set_extension("tdd");
            }
            p
        }
    };
    write_atomic(&path, text.as_bytes())?;
    Ok(Some(Opened { name: file_name(&path), path: path.to_string_lossy().into_owned(), text: String::new(), sidecar: None }))
}

/// Write the experiment file next to a protocol that was just saved. The text must be a JSON object.
fn write_sidecar(tdd_path: &Path, text: &str) -> Result<PathBuf, String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("Experiment file is not valid JSON: {e}"))?;
    if !v.is_object() {
        return Err("Experiment file must be a JSON object".into());
    }
    let p = sidecar_path(tdd_path);
    write_atomic(&p, text.as_bytes())?;
    Ok(p)
}

#[tauri::command]
async fn save_sidecar(tdd_path: String, text: String) -> Result<String, String> {
    write_sidecar(Path::new(&tdd_path), &text).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn save_text(app: AppHandle, suggested: String, text: String, extension: String) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter(extension.to_uppercase(), &[extension.as_str()])
        .set_file_name(&suggested)
        .blocking_save_file();
    let Some(fp) = picked else { return Ok(None) };
    let path = to_path(fp)?;
    write_atomic(&path, text.as_bytes())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Write built workbook bytes atomically: what save_xlsx does after the dialog (tests use the same path).
fn write_xlsx(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_atomic(path, bytes)
}

#[tauri::command]
async fn save_xlsx(app: AppHandle, suggested: String, workbook: xlsx::Workbook) -> Result<Option<String>, String> {
    // Build first: a workbook the writer rejects must fail before the user picks a file.
    let bytes = xlsx::write_workbook(&workbook)?;
    let picked = app
        .dialog()
        .file()
        .add_filter("Excel workbook", &["xlsx"])
        .set_file_name(&suggested)
        .blocking_save_file();
    let Some(fp) = picked else { return Ok(None) };
    let mut path = to_path(fp)?;
    if path.extension().map(|e| !e.eq_ignore_ascii_case("xlsx")).unwrap_or(true) {
        path.set_extension("xlsx");
    }
    write_xlsx(&path, &bytes)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_tdd, save_tdd, save_sidecar, save_text, save_xlsx])
        .run(tauri::generate_context!())
        .expect("error while running Tecan D300 Craft");
}

#[cfg(test)]
mod tests {
    use super::{cross_check, sidecar_path, write_sidecar, write_xlsx, xlsx};
    use std::path::{Path, PathBuf};

    #[test]
    fn sidecar_sits_next_to_the_protocol_and_must_be_a_json_object() {
        assert_eq!(sidecar_path(Path::new("/a/b/run 1.tdd")), PathBuf::from("/a/b/run 1.craft.json"));
        let dir = std::env::temp_dir().join(format!("d300craft-sidecar-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tdd = dir.join("exp.tdd");
        let p = write_sidecar(&tdd, "{\"version\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{\"version\":1}");
        assert!(write_sidecar(&tdd, "[1]").is_err());
        assert!(write_sidecar(&tdd, "not json").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn write_xlsx_writes_an_xlsx_file() {
        let wb: xlsx::Workbook = serde_json::from_str(
            r#"{ "sheets": [{ "name": "Wells", "freeze": [1, 0], "autofilter": true,
                  "columns": [{ "header": "Well", "width": 6 }, { "header": "Signal", "width": 10 }],
                  "rows": [["A1", 12345], ["A2", null]] }] }"#,
        )
        .unwrap();
        let dir = std::env::temp_dir().join(format!("d300-save-xlsx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.xlsx");
        write_xlsx(&path, &xlsx::write_workbook(&wb).unwrap()).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..2], b"PK");
        assert!(!dir.join(".out.xlsx.d300tmp").exists(), "temporary file left behind");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Writes a workbook JSON (from tools/xlsx_roundtrip.mjs) to .xlsx for the openpyxl read-back check.
    /// Runs only when D300_XLSX_JSON and D300_XLSX_OUT are set (tools/xlsx_roundtrip.sh sets them).
    #[test]
    fn xlsx_from_json_env() {
        let (Ok(src), Ok(out)) = (std::env::var("D300_XLSX_JSON"), std::env::var("D300_XLSX_OUT")) else { return };
        let wb: xlsx::Workbook = serde_json::from_str(&std::fs::read_to_string(src).unwrap()).unwrap();
        write_xlsx(std::path::Path::new(&out), &xlsx::write_workbook(&wb).unwrap()).unwrap();
    }

    fn reference_files() -> Vec<PathBuf> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/reference");
        let mut out = vec![];
        for dir in [root.clone(), root.join("tecan_examples"), root.join("roundtrip")] {
            for e in std::fs::read_dir(dir).unwrap() {
                let p = e.unwrap().path();
                if p.extension().map(|x| x == "tdd").unwrap_or(false) {
                    out.push(p);
                }
            }
        }
        out
    }

    #[test]
    fn cross_check_accepts_every_reference_protocol() {
        let files = reference_files();
        assert!(files.len() >= 15, "expected the reference set, found {}", files.len());
        for p in files {
            let text = std::fs::read_to_string(&p).unwrap();
            cross_check(&text).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
        }
    }

    #[test]
    fn cross_check_rejects_text_the_engine_would_write_differently() {
        // positive control: a file the engine canonicalises differently must be refused
        let p = reference_files().into_iter().find(|p| p.ends_with("t01-setvalue-units.tdd")).unwrap();
        let text = std::fs::read_to_string(p).unwrap();
        let altered = text.replacen("<Fluid ID=\"0\">1</Fluid>", "<Fluid ID=\"0\">1.0</Fluid>", 1);
        assert_ne!(altered, text, "test setup: replacement must apply");
        assert!(cross_check(&altered).is_err());
        assert!(cross_check("not xml").is_err());
    }
}
