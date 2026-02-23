use std::cmp::min;
use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hf_hub::api::{sync::ApiBuilder, Progress};
use hf_hub::Cache;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use thiserror::Error;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const TARGET_SAMPLE_RATE: u32 = 16_000;
const MODEL_DIR: &str = "models";
const HF_CACHE_DIR: &str = "hf-cache";
const MEDGEMMA_MARKER_FILE: &str = "medgemma-path.json";
const MODEL_ID_WHISPER_TINY: &str = "whisper_tiny";
const MODEL_ID_MEDGEMMA: &str = "medgemma";
const WHISPER_TINY_FILENAME: &str = "ggml-tiny.en.bin";
const WHISPER_TINY_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin";
const MEDGEMMA_HF_REPO: &str = "unsloth/medgemma-1.5-4b-it-GGUF";
const MEDGEMMA_HF_FILE: &str = "medgemma-1.5-4b-it-Q4_K_M.gguf";
const WHISPER_TINY_REQUIRED_BYTES: u64 = 80 * 1024 * 1024;
const MEDGEMMA_REQUIRED_BYTES: u64 = 3_500 * 1024 * 1024;

#[derive(Debug, Deserialize, Clone)]
pub struct TranscriptionConfig {
    pub vad_sensitivity: Option<u8>,
    pub max_chunk_seconds: Option<f32>,
}

impl Default for TranscriptionConfig {
    fn default() -> Self {
        Self {
            vad_sensitivity: Some(2),
            max_chunk_seconds: Some(14.0),
        }
    }
}

impl TranscriptionConfig {
    pub fn from_value(value: Option<Value>) -> Self {
        match value {
            Some(raw) => {
                let mut parsed =
                    serde_json::from_value::<TranscriptionConfig>(raw).unwrap_or_default();
                if parsed.vad_sensitivity.is_none() {
                    parsed.vad_sensitivity = Some(2);
                }
                if parsed.max_chunk_seconds.is_none() {
                    parsed.max_chunk_seconds = Some(14.0);
                }
                parsed
            }
            None => TranscriptionConfig::default(),
        }
    }

    fn max_chunk_seconds(&self) -> f32 {
        self.max_chunk_seconds.unwrap_or(14.0).clamp(6.0, 20.0)
    }

    fn vad_sensitivity(&self) -> u8 {
        self.vad_sensitivity.unwrap_or(2).clamp(0, 3)
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct TranscriptionSegment {
    pub text: String,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
struct ErrorPayload {
    message: String,
}

#[derive(Debug, Serialize, Clone)]
struct DownloadProgressPayload {
    model_id: String,
    progress: f32,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    status: String,
}

#[derive(Debug, Serialize, Clone)]
struct RequiredModelStatusPayload {
    model_id: String,
    friendly_name: String,
    technical_name: String,
    ready: bool,
    path: Option<String>,
    required_bytes: u64,
    occupied_bytes: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ModelSetupStatusPayload {
    models_root: String,
    models: Vec<RequiredModelStatusPayload>,
    all_ready: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct MedgemmaMarker {
    local_path: String,
}

#[derive(Debug, Error)]
pub enum TranscriptionError {
    #[error("already listening")]
    AlreadyListening,
    #[error("not currently listening")]
    NotListening,
    #[error("audio device unavailable")]
    AudioDeviceUnavailable,
    #[error("failed to start input stream: {0}")]
    AudioStreamStart(String),
    #[error("unsupported sample format")]
    UnsupportedSampleFormat,
    #[error("model download failed: {0}")]
    ModelDownload(String),
    #[error("model path could not be resolved")]
    ModelPath,
    #[error("failed to initialize whisper: {0}")]
    WhisperInit(String),
    #[error("failed to create whisper state: {0}")]
    WhisperState(String),
    #[error("internal error: {0}")]
    Internal(String),
}

struct RuntimeHandle {
    stop_flag: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

struct ManagerState {
    runtime: Option<RuntimeHandle>,
}

pub struct TranscriptionManager {
    state: Mutex<ManagerState>,
}

pub static TRANSCRIPTION_MANAGER: Lazy<TranscriptionManager> = Lazy::new(|| TranscriptionManager {
    state: Mutex::new(ManagerState { runtime: None }),
});

impl TranscriptionManager {
    pub fn start(
        &self,
        app: AppHandle,
        config: TranscriptionConfig,
    ) -> Result<(), TranscriptionError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| TranscriptionError::Internal("manager lock poisoned".to_string()))?;
        if state.runtime.is_some() {
            return Err(TranscriptionError::AlreadyListening);
        }

        let model_path = require_whisper_tiny_model_file(&app)?;
        let stop_flag = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop_flag);
        let app_for_worker = app.clone();
        let worker_config = config.clone();

        let worker = thread::spawn(move || {
            if let Err(err) = run_transcription_loop(
                app_for_worker.clone(),
                model_path,
                worker_config,
                worker_stop,
            ) {
                emit_error(
                    &app_for_worker,
                    &format!("transcription loop exited: {err}"),
                );
            }
        });

        state.runtime = Some(RuntimeHandle {
            stop_flag,
            worker: Some(worker),
        });
        Ok(())
    }

    pub fn stop(&self) -> Result<(), TranscriptionError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| TranscriptionError::Internal("manager lock poisoned".to_string()))?;

        let mut runtime = state
            .runtime
            .take()
            .ok_or(TranscriptionError::NotListening)?;
        runtime.stop_flag.store(true, Ordering::SeqCst);
        if let Some(worker) = runtime.worker.take() {
            let _ = worker.join();
        }
        Ok(())
    }
}

pub async fn start_transcription_command(
    app: AppHandle,
    config: Option<Value>,
) -> Result<(), String> {
    let config = TranscriptionConfig::from_value(config);
    tauri::async_runtime::spawn_blocking(move || TRANSCRIPTION_MANAGER.start(app, config))
        .await
        .map_err(|err| format!("task join error: {err}"))?
        .map_err(|err| err.to_string())
}

pub async fn stop_transcription_command() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| TRANSCRIPTION_MANAGER.stop())
        .await
        .map_err(|err| format!("task join error: {err}"))?
        .map_err(|err| err.to_string())
}

pub async fn get_model_setup_status_command(
    app: AppHandle,
) -> Result<ModelSetupStatusPayload, String> {
    tauri::async_runtime::spawn_blocking(move || get_model_setup_status(&app))
        .await
        .map_err(|err| format!("task join error: {err}"))?
        .map_err(|err| err.to_string())
}

pub async fn download_required_model_command(
    app: AppHandle,
    model_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || download_required_model(&app, &model_id))
        .await
        .map_err(|err| format!("task join error: {err}"))?
        .map_err(|err| err.to_string())
}

pub async fn delete_required_model_command(app: AppHandle, model_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_required_model(&app, &model_id))
        .await
        .map_err(|err| format!("task join error: {err}"))?
        .map_err(|err| err.to_string())
}

pub async fn generate_soap_note_command(
    app: AppHandle,
    transcript: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || generate_soap_note(&app, &transcript))
        .await
        .map_err(|err| format!("task join error: {err}"))?
}

fn generate_soap_note(app: &AppHandle, transcript: &str) -> Result<String, String> {
    let cleaned_transcript = transcript.trim();
    if cleaned_transcript.is_empty() {
        return Err("cannot generate SOAP note from an empty transcript".to_string());
    }

    let sidecar = resolve_sidecar_path(app)?;
    let model = resolve_llm_model_path(app)?;

    let prompt = format!(
        "You are a medical scribe.\n\
Generate a SOAP note from this doctor-patient conversation.\n\
Keep it concise, medically accurate, and organized with these exact section headers:\n\
Subjective\n\
Objective\n\
Assessment\n\
Plan\n\
Do not add extra sections.\n\
Return only the SOAP note text with no preamble, no explanation, and no thinking process.\n\n\
Conversation:\n\
{cleaned_transcript}\n"
    );

    let output = Command::new(&sidecar)
        .arg("-m")
        .arg(&model)
        .arg("-p")
        .arg(prompt)
        .arg("-st")
        .arg("-n")
        .arg("768")
        .arg("-ngl")
        .arg("0")
        .arg("--temp")
        .arg("0.2")
        .arg("--reasoning-budget")
        .arg("0")
        .arg("--no-show-timings")
        .arg("--no-display-prompt")
        .arg("--simple-io")
        .output()
        .map_err(|err| format!("failed to run llama-cli sidecar: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("llama-cli failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let soap_text = extract_soap_text(&stdout);

    if soap_text.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "llama-cli returned no output{}",
            if stderr.trim().is_empty() {
                "".to_string()
            } else {
                format!(" (stderr: {})", stderr.trim())
            }
        ));
    }

    Ok(soap_text)
}

fn resolve_sidecar_path(_app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::current_dir() {
        candidates.push(p.join("src-tauri").join("binaries").join("llama-cli"));
        candidates.push(p.join("binaries").join("llama-cli"));
    }

    for path in candidates {
        if path.exists() {
            return Ok(path);
        }
    }

    Err("could not locate llama-cli sidecar binary".to_string())
}

fn resolve_llm_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let path = read_medgemma_marker_path(app).map_err(|_| {
        "could not locate MedGemma GGUF model in app data; download it from setup screen."
            .to_string()
    })?;
    if path.exists() {
        Ok(path)
    } else {
        Err(
            "MedGemma model marker exists but file is missing; re-download in setup screen."
                .to_string(),
        )
    }
}

fn extract_soap_text(raw: &str) -> String {
    let cleaned = remove_terminal_control_chars(raw);
    let mut collected: Vec<String> = Vec::new();
    let mut capturing = false;

    for line in cleaned.lines() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("exiting...") {
            break;
        }
        if let Some(header) = soap_header_name(trimmed) {
            capturing = true;
            collected.push(format!("{header}:"));
            continue;
        }
        if !capturing {
            continue;
        }
        if trimmed.starts_with("[ Prompt:")
            || trimmed.starts_with('>')
            || trimmed.contains("llama_memory_breakdown_print:")
        {
            continue;
        }
        collected.push(trimmed.to_string());
    }

    let result = collected
        .join("\n")
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if !result.is_empty() {
        return result;
    }

    // Fallback: return non-empty lines with obvious CLI scaffolding removed.
    cleaned
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| {
            !line.starts_with("Loading model")
                && !line.starts_with("available commands:")
                && !line.starts_with("/exit")
                && !line.starts_with("/regen")
                && !line.starts_with("/clear")
                && !line.starts_with("/read")
                && !line.starts_with("build")
                && !line.starts_with("model")
                && !line.starts_with("modalities")
                && !line.starts_with('>')
                && !line.eq_ignore_ascii_case("Exiting...")
                && !line.starts_with("[ Prompt:")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn remove_terminal_control_chars(input: &str) -> String {
    input
        .chars()
        .filter(|ch| *ch == '\n' || *ch == '\t' || !ch.is_control())
        .collect()
}

fn soap_header_name(line: &str) -> Option<&'static str> {
    let normalized = line
        .trim()
        .trim_start_matches(|c: char| !c.is_ascii_alphabetic())
        .trim_end_matches(|c: char| !c.is_ascii_alphabetic())
        .to_ascii_lowercase();

    match normalized.as_str() {
        "subjective" => Some("Subjective"),
        "objective" => Some("Objective"),
        "assessment" => Some("Assessment"),
        "plan" => Some("Plan"),
        _ => None,
    }
}

fn get_model_setup_status(app: &AppHandle) -> Result<ModelSetupStatusPayload, TranscriptionError> {
    let models_root = models_root(app)?;
    fs::create_dir_all(&models_root).map_err(|err| {
        TranscriptionError::ModelDownload(format!("cannot create model dir: {err}"))
    })?;

    let whisper_path = whisper_tiny_path(app)?;
    let whisper_ready = whisper_path.exists();
    let whisper_occupied = file_size_if_exists(&whisper_path);

    let medgemma_path = read_medgemma_marker_path(app).ok();
    let medgemma_ready = medgemma_path.as_ref().is_some_and(|path| path.exists());
    let medgemma_occupied = medgemma_path
        .as_ref()
        .map_or(0, |path| file_size_if_exists(path));

    let payload = ModelSetupStatusPayload {
        models_root: models_root.to_string_lossy().to_string(),
        models: vec![
            RequiredModelStatusPayload {
                model_id: MODEL_ID_WHISPER_TINY.to_string(),
                friendly_name: "Transcription engine".to_string(),
                technical_name: "Whisper Tiny".to_string(),
                ready: whisper_ready,
                path: whisper_ready.then(|| whisper_path.to_string_lossy().to_string()),
                required_bytes: WHISPER_TINY_REQUIRED_BYTES,
                occupied_bytes: whisper_occupied,
            },
            RequiredModelStatusPayload {
                model_id: MODEL_ID_MEDGEMMA.to_string(),
                friendly_name: "Summarization engine".to_string(),
                technical_name: "MedGemma 1.5".to_string(),
                ready: medgemma_ready,
                path: medgemma_path
                    .filter(|path| path.exists())
                    .map(|path| path.to_string_lossy().to_string()),
                required_bytes: MEDGEMMA_REQUIRED_BYTES,
                occupied_bytes: medgemma_occupied,
            },
        ],
        all_ready: whisper_ready && medgemma_ready,
    };

    Ok(payload)
}

fn download_required_model(app: &AppHandle, model_id: &str) -> Result<(), TranscriptionError> {
    match model_id {
        MODEL_ID_WHISPER_TINY => {
            let path = whisper_tiny_path(app)?;
            if path.exists() {
                emit_model_progress(app, MODEL_ID_WHISPER_TINY, 1.0, 0, None, "completed");
                return Ok(());
            }
            download_whisper_tiny_model(app, &path)
        }
        MODEL_ID_MEDGEMMA => {
            if let Ok(path) = read_medgemma_marker_path(app) {
                if path.exists() {
                    emit_model_progress(app, MODEL_ID_MEDGEMMA, 1.0, 0, None, "completed");
                    return Ok(());
                }
            }
            download_medgemma_model(app)
        }
        _ => Err(TranscriptionError::ModelDownload(format!(
            "unknown model id: {model_id}"
        ))),
    }
}

fn delete_required_model(app: &AppHandle, model_id: &str) -> Result<(), TranscriptionError> {
    match model_id {
        MODEL_ID_WHISPER_TINY => {
            let path = whisper_tiny_path(app)?;
            if path.exists() {
                fs::remove_file(path).map_err(|err| {
                    TranscriptionError::ModelDownload(format!("delete failed: {err}"))
                })?;
            }
            Ok(())
        }
        MODEL_ID_MEDGEMMA => {
            if let Ok(path) = read_medgemma_marker_path(app) {
                if path.exists() {
                    fs::remove_file(path).map_err(|err| {
                        TranscriptionError::ModelDownload(format!("delete failed: {err}"))
                    })?;
                }
            }

            if let Ok(marker) = medgemma_marker_path(app) {
                if marker.exists() {
                    fs::remove_file(marker).map_err(|err| {
                        TranscriptionError::ModelDownload(format!("marker delete failed: {err}"))
                    })?;
                }
            }

            let cache_root = medgemma_cache_root(app)?;
            if cache_root.exists() {
                fs::remove_dir_all(cache_root).map_err(|err| {
                    TranscriptionError::ModelDownload(format!("cache delete failed: {err}"))
                })?;
            }
            Ok(())
        }
        _ => Err(TranscriptionError::ModelDownload(format!(
            "unknown model id: {model_id}"
        ))),
    }
}

fn require_whisper_tiny_model_file(app: &AppHandle) -> Result<PathBuf, TranscriptionError> {
    let model_path = whisper_tiny_path(app)?;
    if model_path.exists() {
        return Ok(model_path);
    }
    Err(TranscriptionError::ModelDownload(
        "Whisper tiny model not downloaded. Please download it from setup screen.".to_string(),
    ))
}

fn download_whisper_tiny_model(
    app: &AppHandle,
    model_path: &Path,
) -> Result<(), TranscriptionError> {
    if let Some(parent) = model_path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            TranscriptionError::ModelDownload(format!("cannot create model dir: {err}"))
        })?;
    }

    emit_model_progress(app, MODEL_ID_WHISPER_TINY, 0.0, 0, None, "downloading");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|err| TranscriptionError::ModelDownload(err.to_string()))?;

    let mut response = client
        .get(WHISPER_TINY_URL)
        .send()
        .and_then(|res| res.error_for_status())
        .map_err(|err| TranscriptionError::ModelDownload(err.to_string()))?;

    let total = response.content_length();
    let tmp_path = model_path.with_extension("bin.part");
    let mut file = File::create(&tmp_path).map_err(|err| {
        TranscriptionError::ModelDownload(format!("cannot create tmp file: {err}"))
    })?;

    let mut downloaded = 0_u64;
    let mut buffer = [0_u8; 1024 * 64];

    loop {
        let n = response
            .read(&mut buffer)
            .map_err(|err| TranscriptionError::ModelDownload(err.to_string()))?;
        if n == 0 {
            break;
        }
        file.write_all(&buffer[..n])
            .map_err(|err| TranscriptionError::ModelDownload(err.to_string()))?;
        downloaded += n as u64;

        let progress = total
            .map(|len| {
                if len > 0 {
                    downloaded as f32 / len as f32
                } else {
                    0.0
                }
            })
            .unwrap_or(0.0);
        emit_model_progress(
            app,
            MODEL_ID_WHISPER_TINY,
            progress,
            downloaded,
            total,
            "downloading",
        );
    }

    fs::rename(&tmp_path, model_path)
        .map_err(|err| TranscriptionError::ModelDownload(format!("rename failed: {err}")))?;
    emit_model_progress(
        app,
        MODEL_ID_WHISPER_TINY,
        1.0,
        downloaded,
        total,
        "completed",
    );

    Ok(())
}

fn download_medgemma_model(app: &AppHandle) -> Result<(), TranscriptionError> {
    let cache_root = medgemma_cache_root(app)?;
    fs::create_dir_all(&cache_root).map_err(|err| {
        TranscriptionError::ModelDownload(format!("cannot create hf cache dir: {err}"))
    })?;

    emit_model_progress(app, MODEL_ID_MEDGEMMA, 0.0, 0, None, "downloading");

    let cache = Cache::new(cache_root);
    let api = ApiBuilder::from_cache(cache)
        .with_progress(false)
        .build()
        .map_err(|err| TranscriptionError::ModelDownload(err.to_string()))?;
    let repo = api.model(MEDGEMMA_HF_REPO.to_string());
    let progress = TauriDownloadProgress::new(app.clone(), MODEL_ID_MEDGEMMA.to_string());
    let model_path = repo
        .download_with_progress(MEDGEMMA_HF_FILE, progress)
        .map_err(|err| TranscriptionError::ModelDownload(err.to_string()))?;

    write_medgemma_marker_path(app, &model_path)?;
    emit_model_progress(app, MODEL_ID_MEDGEMMA, 1.0, 0, None, "completed");
    Ok(())
}

fn models_root(app: &AppHandle) -> Result<PathBuf, TranscriptionError> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join(MODEL_DIR))
        .map_err(|_| TranscriptionError::ModelPath)
}

fn whisper_tiny_path(app: &AppHandle) -> Result<PathBuf, TranscriptionError> {
    Ok(models_root(app)?.join(WHISPER_TINY_FILENAME))
}

fn medgemma_cache_root(app: &AppHandle) -> Result<PathBuf, TranscriptionError> {
    Ok(models_root(app)?.join(HF_CACHE_DIR))
}

fn medgemma_marker_path(app: &AppHandle) -> Result<PathBuf, TranscriptionError> {
    Ok(models_root(app)?.join(MEDGEMMA_MARKER_FILE))
}

fn write_medgemma_marker_path(
    app: &AppHandle,
    model_path: &Path,
) -> Result<(), TranscriptionError> {
    let marker_path = medgemma_marker_path(app)?;
    let marker = MedgemmaMarker {
        local_path: model_path.to_string_lossy().to_string(),
    };
    let content = serde_json::to_string_pretty(&marker)
        .map_err(|err| TranscriptionError::ModelDownload(err.to_string()))?;
    fs::write(marker_path, content)
        .map_err(|err| TranscriptionError::ModelDownload(format!("cannot write marker: {err}")))
}

fn read_medgemma_marker_path(app: &AppHandle) -> Result<PathBuf, TranscriptionError> {
    let marker_path = medgemma_marker_path(app)?;
    let raw = fs::read_to_string(&marker_path).map_err(|_| TranscriptionError::ModelPath)?;
    let marker: MedgemmaMarker = serde_json::from_str(&raw)
        .map_err(|err| TranscriptionError::ModelDownload(err.to_string()))?;
    Ok(PathBuf::from(marker.local_path))
}

fn file_size_if_exists(path: &Path) -> u64 {
    fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

fn emit_model_progress(
    app: &AppHandle,
    model_id: &str,
    progress: f32,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    status: &str,
) {
    let payload = DownloadProgressPayload {
        model_id: model_id.to_string(),
        progress,
        downloaded_bytes,
        total_bytes,
        status: status.to_string(),
    };
    let _ = app.emit("model-download-progress", payload);
}

struct TauriDownloadProgress {
    app: AppHandle,
    model_id: String,
    total: usize,
    downloaded: usize,
}

impl TauriDownloadProgress {
    fn new(app: AppHandle, model_id: String) -> Self {
        Self {
            app,
            model_id,
            total: 0,
            downloaded: 0,
        }
    }
}

impl Progress for TauriDownloadProgress {
    fn init(&mut self, size: usize, _filename: &str) {
        self.total = size;
        self.downloaded = 0;
        emit_model_progress(
            &self.app,
            &self.model_id,
            0.0,
            0,
            Some(size as u64),
            "downloading",
        );
    }

    fn update(&mut self, size: usize) {
        self.downloaded += size;
        let progress = if self.total > 0 {
            self.downloaded as f32 / self.total as f32
        } else {
            0.0
        };
        emit_model_progress(
            &self.app,
            &self.model_id,
            progress,
            self.downloaded as u64,
            Some(self.total as u64),
            "downloading",
        );
    }

    fn finish(&mut self) {
        emit_model_progress(
            &self.app,
            &self.model_id,
            1.0,
            self.downloaded as u64,
            Some(self.total as u64),
            "completed",
        );
    }
}

fn run_transcription_loop(
    app: AppHandle,
    model_path: PathBuf,
    config: TranscriptionConfig,
    stop_flag: Arc<AtomicBool>,
) -> Result<(), TranscriptionError> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or(TranscriptionError::AudioDeviceUnavailable)?;

    let stream_config = device
        .default_input_config()
        .map_err(|err| TranscriptionError::AudioStreamStart(err.to_string()))?;

    let channels = stream_config.channels() as usize;
    let input_rate = stream_config.sample_rate().0;

    let (tx, rx) = mpsc::channel::<Vec<f32>>();

    let err_app = app.clone();
    let stream = match stream_config.sample_format() {
        cpal::SampleFormat::F32 => build_input_stream_f32(
            &device,
            &stream_config.into(),
            channels,
            tx.clone(),
            err_app,
        )?,
        cpal::SampleFormat::I16 => build_input_stream_i16(
            &device,
            &stream_config.into(),
            channels,
            tx.clone(),
            app.clone(),
        )?,
        cpal::SampleFormat::U16 => {
            build_input_stream_u16(&device, &stream_config.into(), channels, tx, app.clone())?
        }
        _ => return Err(TranscriptionError::UnsupportedSampleFormat),
    };

    stream
        .play()
        .map_err(|err| TranscriptionError::AudioStreamStart(err.to_string()))?;

    let model_str = model_path
        .to_str()
        .ok_or_else(|| TranscriptionError::ModelPath)?;

    let whisper_params = WhisperContextParameters::default();
    let context = WhisperContext::new_with_params(model_str, whisper_params)
        .map_err(|err| TranscriptionError::WhisperInit(err.to_string()))?;
    let mut state = context
        .create_state()
        .map_err(|err| TranscriptionError::WhisperState(err.to_string()))?;

    let mut chunker = AudioChunker::new(
        config.vad_sensitivity(),
        config.max_chunk_seconds(),
        TARGET_SAMPLE_RATE,
    );

    while !stop_flag.load(Ordering::Relaxed) {
        match rx.recv_timeout(Duration::from_millis(120)) {
            Ok(samples) => {
                let resampled = resample_linear(&samples, input_rate, TARGET_SAMPLE_RATE);

                let segments = chunker.push_samples(&resampled);
                for seg in segments {
                    if stop_flag.load(Ordering::Relaxed) {
                        break;
                    }

                    match transcribe_segment(&mut state, &seg.samples) {
                        Ok(text) => {
                            if text.is_empty() {
                                continue;
                            }
                            let payload = TranscriptionSegment {
                                text,
                                start_ms: Some(samples_to_ms(seg.start_sample, TARGET_SAMPLE_RATE)),
                                end_ms: Some(samples_to_ms(seg.end_sample, TARGET_SAMPLE_RATE)),
                            };
                            let _ = app.emit("transcription-update", payload);
                        }
                        Err(err) => emit_error(&app, &err.to_string()),
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    Ok(())
}

fn build_input_stream_f32(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    tx: mpsc::Sender<Vec<f32>>,
    app: AppHandle,
) -> Result<cpal::Stream, TranscriptionError> {
    device
        .build_input_stream(
            config,
            move |data: &[f32], _| {
                let frame = if channels <= 1 {
                    data.to_vec()
                } else {
                    downmix_to_mono(data, channels)
                };
                let _ = tx.send(frame);
            },
            move |err| {
                emit_error(&app, &format!("audio stream error: {err}"));
            },
            None,
        )
        .map_err(|err| TranscriptionError::AudioStreamStart(err.to_string()))
}

fn build_input_stream_i16(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    tx: mpsc::Sender<Vec<f32>>,
    app: AppHandle,
) -> Result<cpal::Stream, TranscriptionError> {
    device
        .build_input_stream(
            config,
            move |data: &[i16], _| {
                let mut out = Vec::with_capacity(data.len() / channels.max(1));
                if channels <= 1 {
                    for s in data {
                        out.push(*s as f32 / i16::MAX as f32);
                    }
                } else {
                    for frame in data.chunks(channels) {
                        let mut sum = 0.0f32;
                        for s in frame {
                            sum += *s as f32 / i16::MAX as f32;
                        }
                        out.push(sum / channels as f32);
                    }
                }
                let _ = tx.send(out);
            },
            move |err| {
                emit_error(&app, &format!("audio stream error: {err}"));
            },
            None,
        )
        .map_err(|err| TranscriptionError::AudioStreamStart(err.to_string()))
}

fn build_input_stream_u16(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    tx: mpsc::Sender<Vec<f32>>,
    app: AppHandle,
) -> Result<cpal::Stream, TranscriptionError> {
    device
        .build_input_stream(
            config,
            move |data: &[u16], _| {
                let mut out = Vec::with_capacity(data.len() / channels.max(1));
                if channels <= 1 {
                    for s in data {
                        out.push((*s as f32 / u16::MAX as f32) * 2.0 - 1.0);
                    }
                } else {
                    for frame in data.chunks(channels) {
                        let mut sum = 0.0f32;
                        for s in frame {
                            sum += (*s as f32 / u16::MAX as f32) * 2.0 - 1.0;
                        }
                        out.push(sum / channels as f32);
                    }
                }
                let _ = tx.send(out);
            },
            move |err| {
                emit_error(&app, &format!("audio stream error: {err}"));
            },
            None,
        )
        .map_err(|err| TranscriptionError::AudioStreamStart(err.to_string()))
}

fn transcribe_segment(
    state: &mut whisper_rs::WhisperState,
    audio: &[f32],
) -> Result<String, TranscriptionError> {
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_n_threads(optimal_threads());
    params.set_no_context(true);

    state
        .full(params, audio)
        .map_err(|err| TranscriptionError::WhisperState(err.to_string()))?;

    let n_segments = state
        .full_n_segments()
        .map_err(|err| TranscriptionError::WhisperState(err.to_string()))?;

    let mut out = String::new();
    for i in 0..n_segments {
        let segment = state
            .full_get_segment_text(i)
            .map_err(|err| TranscriptionError::WhisperState(err.to_string()))?;
        let trimmed = segment.trim();
        if !trimmed.is_empty() {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(trimmed);
        }
    }

    Ok(out)
}

fn optimal_threads() -> i32 {
    let available = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    min(4, available) as i32
}

fn emit_error(app: &AppHandle, message: &str) {
    let _ = app.emit(
        "transcription-error",
        ErrorPayload {
            message: message.to_string(),
        },
    );
}

fn downmix_to_mono(input: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return input.to_vec();
    }
    let mut out = Vec::with_capacity(input.len() / channels);
    for frame in input.chunks(channels) {
        let mut sum = 0.0f32;
        for sample in frame {
            sum += *sample;
        }
        out.push(sum / channels as f32);
    }
    out
}

fn resample_linear(input: &[f32], input_rate: u32, output_rate: u32) -> Vec<f32> {
    if input.is_empty() || input_rate == output_rate {
        return input.to_vec();
    }

    let ratio = input_rate as f32 / output_rate as f32;
    let output_len = ((input.len() as f32) / ratio).max(1.0) as usize;
    let mut out = Vec::with_capacity(output_len);

    for i in 0..output_len {
        let src_pos = i as f32 * ratio;
        let idx = src_pos.floor() as usize;
        let frac = src_pos - idx as f32;

        if idx + 1 < input.len() {
            let sample = input[idx] * (1.0 - frac) + input[idx + 1] * frac;
            out.push(sample);
        } else if idx < input.len() {
            out.push(input[idx]);
        }
    }

    out
}

fn samples_to_ms(samples: usize, sample_rate: u32) -> u64 {
    ((samples as f64 / sample_rate as f64) * 1000.0) as u64
}

struct SegmentCandidate {
    samples: Vec<f32>,
    start_sample: usize,
    end_sample: usize,
}

struct AudioChunker {
    frame_size: usize,
    max_chunk_samples: usize,
    min_chunk_samples: usize,
    silence_hangover_frames: usize,
    threshold: f32,
    overlap_samples: usize,
    pending: Vec<f32>,
    pre_roll: VecDeque<f32>,
    active_chunk: Vec<f32>,
    active_start_sample: usize,
    in_speech: bool,
    silence_frames: usize,
    total_samples_seen: usize,
    carry_overlap: Vec<f32>,
}

impl AudioChunker {
    fn new(vad_sensitivity: u8, max_chunk_seconds: f32, sample_rate: u32) -> Self {
        let frame_size = (sample_rate as f32 * 0.03) as usize;
        let max_chunk_samples = (sample_rate as f32 * max_chunk_seconds) as usize;
        let min_chunk_samples = (sample_rate as f32 * 1.2) as usize;
        let overlap_samples = (sample_rate as f32 * 0.3) as usize;
        let threshold = match vad_sensitivity {
            0 => 0.020,
            1 => 0.015,
            2 => 0.010,
            _ => 0.006,
        };

        Self {
            frame_size,
            max_chunk_samples,
            min_chunk_samples,
            silence_hangover_frames: 18,
            threshold,
            overlap_samples,
            pending: Vec::new(),
            pre_roll: VecDeque::with_capacity((sample_rate as f32 * 0.35) as usize),
            active_chunk: Vec::new(),
            active_start_sample: 0,
            in_speech: false,
            silence_frames: 0,
            total_samples_seen: 0,
            carry_overlap: Vec::new(),
        }
    }

    fn push_samples(&mut self, samples: &[f32]) -> Vec<SegmentCandidate> {
        let mut output = Vec::new();
        self.pending.extend_from_slice(samples);

        while self.pending.len() >= self.frame_size {
            let frame: Vec<f32> = self.pending.drain(..self.frame_size).collect();
            self.total_samples_seen += frame.len();
            self.push_pre_roll(&frame);

            let is_speech = frame_rms(&frame) >= self.threshold;

            if is_speech {
                if !self.in_speech {
                    self.in_speech = true;
                    self.silence_frames = 0;
                    self.active_start_sample =
                        self.total_samples_seen.saturating_sub(self.pre_roll.len());
                    self.active_chunk.clear();
                    if !self.carry_overlap.is_empty() {
                        self.active_chunk.extend_from_slice(&self.carry_overlap);
                    }
                    self.active_chunk.extend(self.pre_roll.iter().copied());
                }
                self.active_chunk.extend_from_slice(&frame);
                self.silence_frames = 0;
            } else if self.in_speech {
                self.active_chunk.extend_from_slice(&frame);
                self.silence_frames += 1;
            }

            if self.in_speech {
                let reached_max = self.active_chunk.len() >= self.max_chunk_samples;
                let reached_silence = self.silence_frames >= self.silence_hangover_frames;
                if reached_max || reached_silence {
                    if let Some(segment) = self.finalize_active() {
                        output.push(segment);
                    }
                }
            }
        }

        output
    }

    fn push_pre_roll(&mut self, frame: &[f32]) {
        let max_pre_roll = self.pre_roll.capacity().max(1);
        for sample in frame {
            if self.pre_roll.len() >= max_pre_roll {
                self.pre_roll.pop_front();
            }
            self.pre_roll.push_back(*sample);
        }
    }

    fn finalize_active(&mut self) -> Option<SegmentCandidate> {
        self.in_speech = false;
        self.silence_frames = 0;

        if self.active_chunk.len() < self.min_chunk_samples {
            self.active_chunk.clear();
            return None;
        }

        let start = self.active_start_sample;
        let end = self.total_samples_seen;
        let mut samples = Vec::new();
        std::mem::swap(&mut samples, &mut self.active_chunk);

        if samples.len() > self.overlap_samples {
            self.carry_overlap = samples[samples.len() - self.overlap_samples..].to_vec();
        } else {
            self.carry_overlap = samples.clone();
        }

        Some(SegmentCandidate {
            samples,
            start_sample: start,
            end_sample: end,
        })
    }
}

fn frame_rms(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return 0.0;
    }
    let mut sum = 0.0f32;
    for s in frame {
        sum += s * s;
    }
    (sum / frame.len() as f32).sqrt()
}
