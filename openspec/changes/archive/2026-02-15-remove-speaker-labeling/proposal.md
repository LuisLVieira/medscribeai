## Why

The current transcription pipeline includes diarization-related heuristics that try to assign speakers (for example, Doctor/Patient) to transcript segments. This adds complexity and can produce noisy labels that are not required for the current product goal, which is lightweight live listening feedback.

## What Changes

- Remove speaker labeling behavior from the transcription processing path.
- Remove diarization-related UI controls and state from the app.
- Render transcript feedback in the top bar as raw text without speaker attribution.
- Keep transcript feedback focused on real-time "system is listening" status rather than structured conversation analysis.

## Capabilities

### Modified Capabilities

- `transcription-feedback-stream`: Simplify live transcript display to unlabeled raw text and remove speaker-labeling dependencies from backend and frontend.

## Impact

- `src-tauri/src/lib.rs`: Remove speaker-labeling heuristics from transcription event output and related config handling.
- `src/App.jsx`: Remove speaker-labeling controls/state and adjust transcript rendering to show raw text only.
- `src/App.css`: Update styling as needed after removal of speaker-labeled UI elements.
