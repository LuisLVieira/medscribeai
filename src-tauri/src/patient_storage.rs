use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const PATIENTS_FILE: &str = "patients.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredPatient {
    pub id: String,
    pub name: String,
    pub soap: String,
}

pub async fn load_patients_command(app: AppHandle) -> Result<Vec<StoredPatient>, String> {
    tauri::async_runtime::spawn_blocking(move || load_patients(&app))
        .await
        .map_err(|err| format!("task join error: {err}"))?
}

pub async fn save_patients_command(
    app: AppHandle,
    patients: Vec<StoredPatient>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_patients(&app, &patients))
        .await
        .map_err(|err| format!("task join error: {err}"))?
}

fn patients_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("cannot resolve app local data dir: {err}"))?;
    fs::create_dir_all(&dir).map_err(|err| format!("cannot create app local data dir: {err}"))?;
    Ok(dir.join(PATIENTS_FILE))
}

fn load_patients(app: &AppHandle) -> Result<Vec<StoredPatient>, String> {
    let path = patients_file_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("cannot read patients file {}: {err}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }

    serde_json::from_str(&raw)
        .map_err(|err| format!("invalid patients json at {}: {err}", path.display()))
}

fn save_patients(app: &AppHandle, patients: &[StoredPatient]) -> Result<(), String> {
    let path = patients_file_path(app)?;
    let content = serde_json::to_string_pretty(patients)
        .map_err(|err| format!("cannot serialize patients: {err}"))?;
    let tmp_path = path.with_extension("json.part");
    fs::write(&tmp_path, content).map_err(|err| {
        format!(
            "cannot write temporary patients file {}: {err}",
            tmp_path.display()
        )
    })?;
    fs::rename(&tmp_path, &path).map_err(|err| {
        format!(
            "cannot move temporary patients file into place {}: {err}",
            path.display()
        )
    })?;
    Ok(())
}
