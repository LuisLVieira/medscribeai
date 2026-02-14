# Tauri + React

This template should help get you started developing with Tauri and React in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Local CPU Transcription (Whisper + Tauri)

This app now includes local, CPU-only microphone transcription with near real-time updates:

- Audio input from `cpal`
- Chunking with lightweight energy-based VAD (CPU-friendly)
- Whisper inference via `whisper-rs` with GGML models (`tiny.en` default, `base.en` optional)
- Segment events emitted from Rust to frontend:
  - `transcription-update`
  - `transcription-error`
  - `model-download-progress`

### Installation Notes

1. Install Rust toolchain and platform build tools for Tauri.
2. Run `npm install`.
3. Run `npm run tauri dev`.
4. On first transcription start, the model is downloaded automatically to app local data directory under `models/`.

### Runtime Config

Frontend starts transcription with:

- `model`: `tiny.en` or `base.en`
- `vad_sensitivity`: `0-3` (higher = more aggressive speech detection)
- `max_chunk_seconds`: clamped to `4-12`
- `auto_speaker_labeling`: `true/false`

### Expected CPU Performance

On typical laptops/desktops (Intel i5/i7 11th gen+ with ~16 GB RAM), expected segment latency is usually:

- `tiny.en`: often around `1.5-3.5s`
- `base.en`: often around `2.5-5s`

Actual latency depends on microphone quality, CPU load, and chunk boundaries.

### Known Limitations

- Speaker labels (`Doctor`/`Patient`) use simple alternating heuristics, not full diarization.
- Medical terminology accuracy is limited with `tiny.en`/`base.en`.
- VAD is intentionally simple for low CPU usage and may miss low-volume speech or include short noise bursts.
- No GPU/Metal/CUDA/Vulkan acceleration; CPU-only path is used everywhere.
