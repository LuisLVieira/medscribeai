## Purpose

Define transcription feedback behavior as raw, unlabeled listening feedback and remove diarization-related controls and processing.

## Requirements

### Requirement: Raw Transcript Feedback Stream
The application MUST display transcript feedback as raw text without speaker attribution.

#### Scenario: New transcription segment is received
- **WHEN** a transcription update event contains recognized text
- **THEN** the top transcript bar shows only transcript text content
- **AND** no speaker prefix (for example, "Doctor:" or "Patient:") is rendered

### Requirement: No Diarization Controls In Recording UI
The recording UI MUST NOT expose controls related to speaker labeling.

#### Scenario: User configures recording options
- **WHEN** the user opens recording controls in the top bar
- **THEN** model and VAD controls remain available
- **AND** no speaker-labeling toggle is visible

### Requirement: Transcription Pipeline Omits Speaker Labeling
The backend transcription pipeline MUST not run speaker-labeling heuristics.

#### Scenario: Transcription starts
- **WHEN** recording is started
- **THEN** no diarization/speaker-tracking component is initialized
- **AND** transcription output is emitted without inferred speaker labels
