use std::cmp::min;
use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use thiserror::Error;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const TARGET_SAMPLE_RATE: u32 = 16_000;
const MODEL_DIR: &str = "models";

#[derive(Debug, Deserialize, Clone)]
pub struct TranscriptionConfig {
    pub model: Option<String>,
    pub vad_sensitivity: Option<u8>,
    pub max_chunk_seconds: Option<f32>,
}

impl Default for TranscriptionConfig {
    fn default() -> Self {
        Self {
            model: Some("tiny.en".to_string()),
            vad_sensitivity: Some(2),
            max_chunk_seconds: Some(14.0),
        }
    }
}

impl TranscriptionConfig {
    pub fn from_value(value: Option<Value>) -> Self {
        match value {
            Some(raw) => {
                let mut parsed = serde_json::from_value::<TranscriptionConfig>(raw).unwrap_or_default();
                if parsed.model.is_none() {
                    parsed.model = Some("tiny.en".to_string());
                }
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

    fn normalized_model(&self) -> &'static str {
        match self.model.as_deref() {
            Some("base") | Some("base.en") => "base.en",
            _ => "tiny.en",
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
    model: String,
    progress: f32,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
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
    pub fn start(&self, app: AppHandle, config: TranscriptionConfig) -> Result<(), TranscriptionError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| TranscriptionError::Internal("manager lock poisoned".to_string()))?;
        if state.runtime.is_some() {
            return Err(TranscriptionError::AlreadyListening);
        }

        let model_path = ensure_model_file(&app, config.normalized_model())?;
        let stop_flag = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop_flag);
        let app_for_worker = app.clone();
        let worker_config = config.clone();

        let worker = thread::spawn(move || {
            if let Err(err) = run_transcription_loop(app_for_worker.clone(), model_path, worker_config, worker_stop) {
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

        let mut runtime = state.runtime.take().ok_or(TranscriptionError::NotListening)?;
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

fn ensure_model_file(app: &AppHandle, model_key: &str) -> Result<PathBuf, TranscriptionError> {
    let base_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|_| TranscriptionError::ModelPath)?;
    let model_dir = base_dir.join(MODEL_DIR);
    fs::create_dir_all(&model_dir)
        .map_err(|err| TranscriptionError::ModelDownload(format!("cannot create model dir: {err}")))?;

    let (filename, url) = match model_key {
        "base.en" => (
            "ggml-base.en.bin",
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
        ),
        _ => (
            "ggml-tiny.en.bin",
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
        ),
    };

    let model_path = model_dir.join(filename);
    if model_path.exists() {
        return Ok(model_path);
    }

    download_model(app, &model_path, url, model_key)?;
    Ok(model_path)
}

fn download_model(
    app: &AppHandle,
    model_path: &Path,
    url: &str,
    model_key: &str,
) -> Result<(), TranscriptionError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|err| TranscriptionError::ModelDownload(err.to_string()))?;

    let mut response = client
        .get(url)
        .send()
        .and_then(|res| res.error_for_status())
        .map_err(|err| TranscriptionError::ModelDownload(err.to_string()))?;

    let total = response.content_length();
    let tmp_path = model_path.with_extension("bin.part");
    let mut file = File::create(&tmp_path)
        .map_err(|err| TranscriptionError::ModelDownload(format!("cannot create tmp file: {err}")))?;

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
            .map(|len| if len > 0 { downloaded as f32 / len as f32 } else { 0.0 })
            .unwrap_or(0.0);
        let payload = DownloadProgressPayload {
            model: model_key.to_string(),
            progress,
            downloaded_bytes: downloaded,
            total_bytes: total,
        };
        let _ = app.emit("model-download-progress", payload);
    }

    fs::rename(&tmp_path, model_path)
        .map_err(|err| TranscriptionError::ModelDownload(format!("rename failed: {err}")))?;

    let _ = app.emit(
        "model-download-progress",
        DownloadProgressPayload {
            model: model_key.to_string(),
            progress: 1.0,
            downloaded_bytes: downloaded,
            total_bytes: total,
        },
    );

    Ok(())
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
        cpal::SampleFormat::F32 => build_input_stream_f32(&device, &stream_config.into(), channels, tx.clone(), err_app)?,
        cpal::SampleFormat::I16 => build_input_stream_i16(&device, &stream_config.into(), channels, tx.clone(), app.clone())?,
        cpal::SampleFormat::U16 => build_input_stream_u16(&device, &stream_config.into(), channels, tx, app.clone())?,
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
                    self.active_start_sample = self.total_samples_seen.saturating_sub(self.pre_roll.len());
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
