## Overview

This change removes diarization-style speaker labeling from both backend processing and frontend display. The transcript top bar remains a lightweight listening indicator and now renders unlabeled raw text only.

## Goals

- Remove speaker-labeling logic from the transcription runtime.
- Remove speaker-labeling controls from the recording UI.
- Keep Whisper STT output flow intact while simplifying payload and rendering.

## Non-Goals

- Changing the core Whisper model execution path.
- Reworking SOAP editing behavior.
- Adding persistent transcript history or diarization replacements.

## Current State

- Backend (`src-tauri/src/transcription.rs`) includes:
  - `auto_speaker_labeling` in `TranscriptionConfig`
  - `SpeakerTracker` heuristic for assigning Doctor/Patient
  - `TranscriptionSegment.speaker` in emitted payloads
- Frontend (`src/App.jsx`) includes:
  - `autoSpeakerLabeling` state and UI toggle in top-bar controls
  - Segment formatting that prefixes text with speaker labels in stream lines

## Proposed Design

### Backend Simplification

- Remove `auto_speaker_labeling` from `TranscriptionConfig`.
- Remove `SpeakerTracker` type and all calls to it.
- Emit transcription updates as raw text segments without speaker attribution in the payload contract used by frontend.
- Preserve timestamps and text so transcript timing and duplicate checks still function.

### Frontend Simplification

- Remove `autoSpeakerLabeling` React state and top-bar checkbox control.
- Update stream text derivation to use only segment `text` content.
- Remove speaker-dependent string construction from fallback transcript formatting logic where applicable.
- Keep recording toggle behavior, model selection, and VAD controls unchanged.

### Data Contract

- Frontend should tolerate either:
  - new payloads without `speaker`, or
  - legacy payloads with `speaker` (ignored for display),
  so rollout is non-breaking during transition.

## File-Level Changes

- `src-tauri/src/transcription.rs`
  - Drop `auto_speaker_labeling` config field/default/parsing.
  - Remove `SpeakerTracker` struct/logic and its usage in transcription loop.
  - Adjust `TranscriptionSegment` serialization to omit speaker labels.

- `src/App.jsx`
  - Remove `autoSpeakerLabeling` state and prop wiring.
  - Remove auto-label checkbox from `TopTranscriptStreamBar`.
  - Update segment-to-stream conversion to raw text only.

- `src/App.css`
  - Remove now-unused styles for removed control if present.
  - Keep top transcript bar visual behavior intact.

## Risks and Mitigations

- Risk: Existing cached transcript lines still include speaker prefixes.
  - Mitigation: apply raw-text formatting only to new incoming segments; optionally sanitize fallback string parsing.

- Risk: Frontend/backend contract drift during refactor.
  - Mitigation: keep frontend defensive against optional `speaker` while backend migration lands.

## Validation Plan

- Start recording and confirm top bar shows raw text snippets only.
- Verify no speaker-labeling toggle appears in top-bar controls.
- Verify transcription still streams and status updates remain functional.
- Verify no Rust compile errors from removed `SpeakerTracker` and config field.
