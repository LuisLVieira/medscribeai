## Why

The current two-column layout forces the conversation transcript and SOAP note to compete for horizontal space, which makes the clinical note area feel constrained. Moving transcript content into a top rolling bar improves focus on SOAP authoring while still preserving real-time conversational context.

## What Changes

- Replace the current left-side transcript panel with a horizontal transcript bar at the top of the app window.
- Keep the SOAP note editor/content as the primary body area beneath the top bar.
- Restyle transcript rendering to feel like rolling, live-updating reasoning text (animated/flowing reveal rather than static block text).
- Ensure the new layout works on both common desktop sizes and smaller windows without clipping key content.

## Capabilities

### Modified Capabilities

- `main-workspace-layout`: Shift from a two-column split to a top-bar-plus-content layout where SOAP note content remains the dominant workspace, and transcript behavior is presented as transient non-scrollable listening feedback.

## Impact

- `src/App.jsx`: Restructure layout regions and transcript rendering order.
- `src/App.css`: Add top-bar styles, rolling text behavior, spacing, and responsive layout adjustments.
