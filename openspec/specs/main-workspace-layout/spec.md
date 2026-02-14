## Purpose

Define the primary app layout and transcript feedback behavior so SOAP authoring remains the main workspace while live transcript text serves as transient listening feedback.

## Requirements

### Requirement: Ephemeral Transcript Feedback Stream
The application MUST present live transcript text as short-lived feedback in a horizontal bar at the top of the window to indicate active listening.

#### Scenario: Live speech updates appear in stream bar
- **WHEN** new transcript text is produced during a conversation
- **THEN** the text is rendered in the top transcript bar
- **AND** the text appears as a flowing/rolling stream rather than as a static transcript block

### Requirement: Non-scrollable Transcript Bar
The transcript stream bar MUST NOT provide scroll interaction or persistent transcript browsing behavior.

#### Scenario: User attempts to scroll transcript bar
- **WHEN** transcript content length exceeds the visible width of the bar
- **THEN** the bar continues to present rolling content within the fixed top area
- **AND** no horizontal or vertical scrollbar is shown for the transcript bar
- **AND** the user cannot use the transcript bar to navigate historical transcript entries

### Requirement: Listening Signal Over Readability Archive
The transcript stream MUST prioritize immediate listening feedback over long-form readability and retention.

#### Scenario: Conversation continues over time
- **WHEN** additional transcript text keeps arriving
- **THEN** older transcript segments are displaced by newer segments
- **AND** the UI communicates that transcript text is transient status feedback, not a permanent reading pane

### Requirement: Main Workspace Prioritizes SOAP Note Area
The application MUST use a top-bar-plus-body layout where SOAP note content remains the primary workspace region.

#### Scenario: Main screen renders
- **WHEN** the app window is displayed
- **THEN** the transcript stream bar appears at the top of the window
- **AND** the SOAP note panel is positioned below it as the dominant content area
- **AND** the previous two-column transcript/SOAP split is no longer used

### Requirement: Responsive Top Bar Layout
The application MUST preserve usable transcript feedback and SOAP editing layout on smaller window widths.

#### Scenario: Window width is reduced
- **WHEN** the user resizes the app to a narrower width
- **THEN** the top transcript bar remains visible and non-overlapping
- **AND** the SOAP note region remains accessible without layout breakage
