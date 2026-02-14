## Implementation Tasks

- [x] 1. Refactor `MainContent` layout to top-bar-plus-body
  - Replace the current split transcript/SOAP pane structure in `src/App.jsx` with a top transcript region and a primary SOAP workspace below.
  - Remove transcript panel header/body rendering from the main content area.
  - Keep sidebar, patient selection, and header status/error/download indicators intact.
  - Requirement coverage: `main-workspace-layout` ("Main screen renders")

- [x] 2. Add top transcript stream component and transient display model
  - Introduce a `TopTranscriptStreamBar` component in `src/App.jsx`.
  - Derive stream text from recent transcript updates (for example, last `N` segments or last `M` characters) rather than rendering full historical transcript blocks.
  - Ensure older transcript content is displaced as new text arrives.
  - Requirement coverage: `main-workspace-layout` ("Ephemeral Transcript Feedback Stream", "Listening Signal Over Readability Archive")

- [x] 3. Enforce non-scrollable behavior for transcript feedback bar
  - Apply fixed-height, clipped overflow behavior to the top stream bar.
  - Prevent horizontal and vertical scrollbars from appearing in the transcript bar.
  - Ensure users cannot navigate transcript history via the bar.
  - Requirement coverage: `main-workspace-layout` ("Non-scrollable Transcript Bar")

- [x] 4. Implement rolling visual style and motion behavior
  - Add stream bar styles in `src/App.css` (background, edge fade, rolling/flowing text treatment).
  - Add subtle motion for live updates while avoiding distracting animation intensity.
  - Add `prefers-reduced-motion` fallback that disables movement but preserves live text updates.
  - Requirement coverage: `main-workspace-layout` ("Ephemeral Transcript Feedback Stream")

- [x] 5. Validate responsive layout and accessibility behavior
  - Verify transcript bar remains visible and non-overlapping across narrower window sizes.
  - Verify SOAP editor remains the dominant and usable workspace on resize.
  - Mark stream region with appropriate live-status semantics (`aria-live="polite"`).
  - Requirement coverage: `main-workspace-layout` ("Responsive Top Bar Layout"), accessibility expectations from design

- [x] 6. Regression-check recording and transcription integration
  - Confirm `transcription-update` events still update patient transcript data without duplication regressions.
  - Confirm recording start/stop controls and footer recording bar still behave correctly.
  - Confirm header status/error/download indicators continue to update as before.
  - Requirement coverage: change stability and integration safety
