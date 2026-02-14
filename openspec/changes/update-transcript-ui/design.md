## Overview

This change replaces the current two-column transcript/SOAP layout with a top transcript feedback bar and a dominant SOAP workspace below. The transcript bar is intentionally ephemeral: it signals that the app is actively listening, but does not function as a readable transcript history.

## Goals

- Move transcript display from left panel to a top horizontal bar.
- Present live transcript updates as flowing/rolling text.
- Keep the transcript bar non-scrollable and transient.
- Preserve SOAP note editing as the primary workspace.

## Non-Goals

- Building transcript history browsing in the UI.
- Adding transcript search, pagination, or export flows.
- Changing transcription backend events or Rust command contracts.

## Current State

- `MainContent` renders transcript and SOAP in a 50/50 split using:
  - Transcript panel with `overflow-y-auto` and per-segment cards.
  - SOAP panel with editable HTML content.
- Transcript data is appended from `transcription-update` events into:
  - `patient.segments` (structured list)
  - `patient.transcript` (string fallback)

## Proposed Design

### Layout

- Keep `Sidebar` unchanged.
- In `MainContent`, replace the split body with:
  - `TopTranscriptStreamBar` (fixed-height horizontal feedback region).
  - `SoapWorkspace` below, taking remaining vertical space.
- Remove transcript panel header/body and transcript list rendering from the main body.

### Stream Behavior Model

- Derive display text from the newest transcript segments only.
- Maintain an in-memory stream window in UI state (for display), not a scrollable history view.
- Render text in a single-line (or compact two-line max) marquee-like container with clipping.
- Older content is automatically displaced as new segments arrive.

Implementation detail:
- Keep existing `patient.segments` storage for data continuity and possible future processing.
- Introduce a display-focused selector in `MainContent`:
  - Example: take last `N` segments or last `M` characters and join into one flowing line.
- The top bar never exposes scrolling affordances, even when text length exceeds width.

### Visual and Motion Design

- Add CSS for a subtle "listening stream" look:
  - soft gradient background
  - low-contrast boundary
  - moving text track animation
- Use mask/fade edges so clipped text feels continuous, not abruptly cut.
- Animation should be lightweight and continuous while new text arrives.

### Accessibility and Interaction

- Mark stream area as status feedback (`aria-live="polite"`).
- Ensure high enough text contrast for readability.
- Respect reduced-motion preferences (`prefers-reduced-motion`) by disabling marquee movement while still updating text.
- No pointer-based interaction is required for transcript bar (read-only feedback surface).

### Responsive Behavior

- Top bar keeps a fixed, compact height across desktop and smaller widths.
- SOAP editor remains fully accessible below the bar without overlap.
- On narrow windows, stream text is clipped/faded instead of wrapping into a tall transcript block.

## File-Level Changes

- `src/App.jsx`
  - Refactor `MainContent` structure from split panes to top-bar + SOAP body.
  - Add `TopTranscriptStreamBar` component.
  - Add display-window derivation logic from recent transcript updates.
  - Keep existing transcription event handling and patient data updates.

- `src/App.css`
  - Add styles for top transcript bar container, stream track, edge fades, and optional marquee effect.
  - Remove or de-prioritize old transcript-card styles that are no longer used in main layout.
  - Add reduced-motion and responsive rules for the stream bar.

## Risks and Mitigations

- Risk: Fast transcript updates can produce jittery UI.
  - Mitigation: buffer/coalesce updates into a short cadence (for example, 100-250ms render cadence) if needed.

- Risk: Continuous animation may distract users.
  - Mitigation: keep motion subtle, allow reduced-motion fallback, and favor smooth displacement over aggressive movement.

- Risk: Loss of visible transcript history may surprise users.
  - Mitigation: clarify behavior in product copy/status context ("Live listening feedback").

## Validation Plan

- Manual checks:
  - Transcript appears in top bar during live recording.
  - No scrollbar appears in the transcript bar.
  - Older text is displaced as new text arrives.
  - SOAP editor remains primary and usable across window sizes.
  - Reduced-motion mode disables marquee motion while preserving live updates.

- Regression checks:
  - Recording start/stop controls continue to work.
  - Status/error/download indicators in header remain visible and accurate.
