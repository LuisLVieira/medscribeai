# MedScribeAI

MedScribeAI is an experimental Tauri (Rust + React) desktop application that provides near real-time, local CPU medical conversation transcription and summarization into SOAP standard.

## Quick Start

- Install Rust toolchain (stable) and platform-specific build tools for Tauri.
- Install Node.js (recommended 18+). Then from project root:

```bash
npm install
npm run dev    # start the frontend (vite)
npm run tauri  # run the Tauri app (or `npm run tauri dev` depending on setup)
```

On first transcription run the app will download Whisper GGML models into the app data directory under `models/`.

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

## Running Locally — Rust

From `src-tauri/` you can build the native parts with Cargo:

```bash
cd src-tauri
cargo build
# For a release build:
cargo build --release
```

## Reporting Issues

- Use GitHub Issues to report bugs or request enhancements. Include steps to reproduce, platform details (OS, Rust & Node versions), and relevant logs.

## Code of Conduct

Be respectful and constructive. If you'd like, I can add a contributor `CODE_OF_CONDUCT.md` and templates for issues/PRs.

---

If you want, I can now:

- update other metadata (app icons, `tauri.conf.json` display name),
- add PR/issue templates and a `CODE_OF_CONDUCT.md`, or
- run a quick validation (e.g., `npm run build` or `cargo check`) locally.

Tell me which next step you prefer.
