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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .with_target(false)
        .without_time()
        .try_init()
        .ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            start_transcription,
            stop_transcription,
            generate_soap_note
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
