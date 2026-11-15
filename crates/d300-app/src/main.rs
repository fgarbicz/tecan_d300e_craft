// D300 Designer — desktop shell.
//
// The interface (web-dist/app) runs the design operations; everything that touches files goes
// through these Rust commands, which use the d300-core engine:
//   * open_tdd  — native Open dialog, reads the file and checks it parses as a D300e protocol;
//   * save_tdd  — CROSS-CHECK before writing: the Rust engine re-parses the text produced by the
//                 interface and must re-write it byte-identically, otherwise nothing is written.
//                 Both engines are tested to be identical, so a failure here means a regression
//                 and must never reach the dispenser;
//   * save_text — CSV export.
// Files are written atomically (temporary file + rename) so a failed save never truncates a protocol.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};

#[derive(Serialize)]
struct Opened {
    path: String,
    name: String,
    text: String,
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
    Ok(Some(Opened { name: file_name(&path), path: path.to_string_lossy().into_owned(), text }))
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
    Ok(Some(Opened { name: file_name(&path), path: path.to_string_lossy().into_owned(), text: String::new() }))
}

#[tauri::command]
async fn save_text(app: AppHandle, suggested: String, text: String, extension: String) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter(&extension.to_uppercase(), &[extension.as_str()])
        .set_file_name(&suggested)
        .blocking_save_file();
    let Some(fp) = picked else { return Ok(None) };
    let path = to_path(fp)?;
    write_atomic(&path, text.as_bytes())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_tdd, save_tdd, save_text])
        .run(tauri::generate_context!())
        .expect("error while running D300 Designer");
}

#[cfg(test)]
mod tests {
    use super::cross_check;
    use std::path::PathBuf;

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
