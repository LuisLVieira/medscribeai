## Implementation Tasks

- [x] 1. Remove backend speaker-labeling configuration and heuristics
  - Remove `auto_speaker_labeling` from `TranscriptionConfig` and default parsing in `src-tauri/src/transcription.rs`.
  - Delete `SpeakerTracker` and all related invocation in the transcription loop.
  - Ensure emitted transcription payload no longer depends on inferred speaker identity.
  - Requirement coverage: `transcription-feedback-stream` ("Transcription Pipeline Omits Speaker Labeling")

- [x] 2. Simplify frontend transcription payload handling and stream formatting
  - Update transcription event handling in `src/App.jsx` to stop relying on `speaker` for display lines.
  - Update stream derivation logic so top bar output uses raw text only.
  - Preserve duplicate detection and timestamp handling behavior where still needed.
  - Requirement coverage: `transcription-feedback-stream` ("Raw Transcript Feedback Stream")

- [x] 3. Remove speaker-labeling controls from top recording UI
  - Remove `autoSpeakerLabeling` state and prop plumbing from `App` and `MainContent`.
  - Remove the "Auto" speaker-labeling checkbox from `TopTranscriptStreamBar`.
  - Keep model and VAD controls intact.
  - Requirement coverage: `transcription-feedback-stream` ("No Diarization Controls In Recording UI")

- [x] 4. Clean up related UI styles and run verification
  - Remove now-unused CSS selectors connected to removed diarization controls, if any.
  - Verify app build/test path succeeds and top bar still behaves as listening feedback.
  - Requirement coverage: change stability and regression safety
