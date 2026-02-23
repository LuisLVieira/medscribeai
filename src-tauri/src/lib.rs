mod patient_storage;
mod transcription;

use serde_json::Value;

#[tauri::command]
async fn start_transcription(app: tauri::AppHandle, config: Option<Value>) -> Result<(), String> {
    transcription::start_transcription_command(app, config).await
}

#[tauri::command]
async fn stop_transcription() -> Result<(), String> {
    transcription::stop_transcription_command().await
}

#[tauri::command]
async fn generate_soap_note(app: tauri::AppHandle, transcript: String) -> Result<String, String> {
    transcription::generate_soap_note_command(app, transcript).await
}

#[tauri::command]
async fn get_model_setup_status(
    app: tauri::AppHandle,
) -> Result<transcription::ModelSetupStatusPayload, String> {
    transcription::get_model_setup_status_command(app).await
}

#[tauri::command]
async fn download_required_model(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    transcription::download_required_model_command(app, model_id).await
}

#[tauri::command]
async fn delete_required_model(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    transcription::delete_required_model_command(app, model_id).await
}

#[tauri::command]
async fn load_patients(
    app: tauri::AppHandle,
) -> Result<Vec<patient_storage::StoredPatient>, String> {
    patient_storage::load_patients_command(app).await
}

#[tauri::command]
async fn save_patients(
    app: tauri::AppHandle,
    patients: Vec<patient_storage::StoredPatient>,
) -> Result<(), String> {
    patient_storage::save_patients_command(app, patients).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .with_target(false)
        .without_time()
        .try_init()
        .ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            start_transcription,
            stop_transcription,
            generate_soap_note,
            get_model_setup_status,
            download_required_model,
            delete_required_model,
            load_patients,
            save_patients
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
