# MedScribeAI

MedScribeAI is an experimental Tauri (Rust + React) desktop application that provides near real-time, local CPU medical conversation transcription and summarization into SOAP standard.

https://www.youtube.com/watch?v=CC4VzAdQJSo

## Quick Start

- Install Rust toolchain (stable) and platform-specific build tools for Tauri.
- Install Node.js `20.19+` (or `22.12+`), then from project root:

```bash
npm install
npm run tauri dev
```

On first transcription run the app will download Whisper GGML models into the app data directory under `models/`.

## Build Instructions

### 1. Build frontend only

```bash
npm run build
```

### 2. Build Tauri app bundle (`.app`) on macOS

`whisper-rs-sys` may fail on macOS with `std::filesystem` errors if the minimum target is too old (`10.13`). Use:

```bash
CMAKE_OSX_DEPLOYMENT_TARGET=10.15 \
CFLAGS='-mmacosx-version-min=10.15' \
CXXFLAGS='-mmacosx-version-min=10.15' \
npm run tauri build -- --bundles app
```

Output path:

- `src-tauri/target/release/bundle/macos/MedScribeAI.app`

If a downloaded app is blocked on macOS with a "damaged" message, remove quarantine metadata and reopen:

```bash
xattr -dr com.apple.quarantine /path/to/MedScribeAI.app
```

### 3. Full Tauri build (includes DMG)

```bash
npm run tauri build
```

Notes:

- If your environment hits `hdiutil: create failed` during DMG creation, build `--bundles app` first as the reliable path.
- Tauri warns that `identifier: "com.medscribeai.app"` ends with `.app`; consider changing it to avoid macOS bundle naming conflicts.

## GitHub Releases (macOS + Windows + Linux)

This repo includes `.github/workflows/release.yml` to build and publish all three platforms from GitHub Actions.

Trigger a release by pushing a version tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow will build:

- macOS: `.app` bundle
- Windows: `msi` and `nsis` installers
- Linux: `AppImage` and `deb` packages

and upload them to the GitHub Release for that tag.

## Project Layout

- `src/` — frontend React app (Vite)
- `src-tauri/` — Rust/Tauri backend and native code
- `models/` — (runtime) directory for downloaded GGML models

## Runtime Configuration

- `model`: `tiny.en` (default) or `base.en`
- `vad_sensitivity`: `0-3` (higher = more aggressive)
- `max_chunk_seconds`: `4-12`
- `auto_speaker_labeling`: `true|false`

## Contributing

We welcome contributions. To make collaboration smooth, follow these guidelines:

- **Fork + Branch**: Fork the repository and create a branch named `feat/<short-description>` or `fix/<short-description>`.
- **Issue First**: Open an issue describing the problem or feature before large changes. Use the issue to discuss design and scope.
- **Small PRs**: Keep pull requests focused and small. Each PR should address one logical change with a clear description and testing notes.
- **Commit Messages**: Use present-tense, short messages, e.g. `Add transcription-stop command`.
- **Code Style**:
  - Frontend: follow existing React code style and use Prettier if configured.
  - Rust: run `cargo fmt` and follow idiomatic Rust.
- **Tests**: Add unit tests where practical and include instructions to run them.
- **Review**: Assign reviewers and request review using the repo's Pull Request workflow. Address feedback with follow-up commits.

## Developer Workflow

1. Pull latest `main` and create a feature branch:

```bash
git checkout main
git pull
git checkout -b feat/your-feature
```

2. Implement changes, run `cargo fmt` and `npm run build` if needed.
3. Run the app locally with `npm run tauri dev` to validate end-to-end behavior.
4. Push your branch and open a PR against `main`.

## Reporting Issues

- Use GitHub Issues to report bugs or request enhancements. Include steps to reproduce, platform details (OS, Rust & Node versions), and relevant logs.

## Code of Conduct

Be respectful and constructive.
