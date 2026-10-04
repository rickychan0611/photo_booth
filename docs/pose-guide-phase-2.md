# Phase 2 plan: Pose Editor, guest selection, group scenes and framing

Status: implemented; verification and review checkpoint. Phase 1's camera/session
controller remains the underlying runtime. See the implementation notes below.

## Scope and implementation order

1. Add a backward-compatible scene contract and deterministic multi-character evaluation.
2. Add validated local storage and load a catalog snapshot at session start.
3. Add an Admin → Poses editor with joint editing and immediate preview.
4. Add timeline, caption and narration synchronization tools.
5. Add group composition and full-body/half-body preview controls.
6. Add the guest composition screen and composition-aware pose selection.
7. Integrate random compatible-pose selection into the existing shot loop and verify Electron flows.

Reuse the common skeleton, expression evaluation, Canvas skin, audio channels,
countdown and capture controller. Keep editor state outside the large App component.
AI generation, polished Rive assets, Ghost Mode, pose detection and the full
20-plus-pose library remain later phases.

## Scene data and group sizes

Introduce schema version 2 with scene-level identity, category, tags, instruction,
duration, captions and optional local narration. Each participant has a stable ID,
label, scene position, scale, facing and its own body, expression, hand and event
tracks. Participant tracks use the existing human-2d-v1 skeleton; character-space
joint coordinates stay independent of scene layout and skin.

All participants share one playback clock and one narration track. Per-person
timing differences are authored on that clock; do not run separate countdowns.
Adapt v1 definitions to a single participant in memory so existing poses and
pose data continues to load without rewriting its JSON. Older assignment settings
remain readable, while normal Phase 2 sessions use random compatible selection.

Compatibility metadata includes participant minimum/maximum and supported framing.
Support exact sizes 1, 2, 3 and 4, plus flexible 4+ scenes with minimum 4 and no fixed
maximum. Exact-four scenes take priority for four guests. Flexible scenes contain
explicit repeatable roles; additional participants repeat those roles in an
authored row layout. Do not duplicate an arbitrary couple pose for larger groups.

Guests enter their composition once before the session using Men, Women, Boys and
Girls counters. The total is independent of the number of photos. Snapshot the
confirmed composition, group style and resolved catalog before the first
demonstration. Automatic counting and camera-based age/gender analysis are removed
from the plan.

Example compositions: two guests form a shared heart; three guests lean toward
the center; four guests use alternating peace gestures; flexible groups raise
their hands together. Include small verification fixtures for these sizes, not
the full Phase 3 pose pack.

## Full-body and half-body framing

Always retain the complete skeleton. Full-body presentation includes head through
ankles. Half-body presentation changes the scene camera/crop to emphasize head,
torso, arms and hands; it does not remove lower-body joints from the data.

Normal sessions derive framing from the template slot automatically; guests do
not choose vertical/horizontal or full/half body. Resolve the current photo slot
before each demonstration: vertical means
full body; horizontal means half body; square defaults to half body. Share one
slot-framing resolver across the viewfinder, pose selection and capture so the
effective width/height and 90/270-degree rotation are interpreted consistently.
Audit the existing viewfinder rotation and capture-aspect handling before wiring
this resolver; they currently obtain their aspect through different paths.
In selection mode, follow the existing primary-slot rule used for all candidate
captures. Do not infer framing from print-paper orientation or the booth display.

Leg-dependent scenes declare full-body compatibility and cannot silently become
half-body demonstrations. Pose selection filters by participant count and framing.
An empty compatible candidate set uses a neutral Freestyle scene for that
count/framing. If no valid scene can be resolved, use the existing legacy
instruction/countdown fallback.

The admin preview shows the photo-window crop and safe bounds. Framing metadata
does not change Canon camera aiming, zoom, capture geometry or the HDMI mask.
Actual lens placement/distance must already include the desired people/body area.
Slot orientation is resolved automatically without another guest question.

## Guest screen: Who's in the photo?

Screen title: **Who's in the photo?**

Keep this screen minimal: title, people counters, pose-style buttons and navigation.
No character preview, pose picker or orientation control appears here.

Place the entire interaction in the upper half of the portrait screen. The order
is title → four count rows → total → pose-style buttons → Continue/Back. The style
buttons sit directly beneath the people-count controls. Use compact spacing and
large touch targets that fit this area on the booth; keep the lower half clear.
If an existing live preview is active, preserve it behind the controls without
changing camera acquisition just for this screen.

Four large touch-friendly rows, each with a minus button, count and plus button:

| Guest type | Counter |
| --- | --- |
| Men | − 0 + |
| Women | − 0 + |
| Boys | − 0 + |
| Girls | − 0 + |

Use plural Boys/Girls consistently. Men/Women are adult counters; Boys/Girls are
children. Start all counters at zero, disable minus at zero, and enable Continue
after at least one person is selected. Show the total, e.g. "4 people joining".
Use large labeled controls and accessible button names such as "Add one woman".
No keyboard or typed numbers are required. Validate whole nonnegative counts and
use an admin-configured group capacity instead of an arbitrary hidden maximum.

For two or more people, also show **Pick your pose style** on the same screen:
Friends, Family and Group, plus Couple when exactly two adults and no children
are selected. Default to Group, so choosing a relationship is optional. Solo
style is automatic for a single guest. A man and a woman are not automatically
treated as a couple; same-gender adult couples are equally eligible. Counts with
children do not automatically imply Family. A child-only group can use Friends,
Family or Group packs with child-compatible scenes.

Insert this screen after template/design selection and before the existing intro.
The current continueAfterDesignSelection starts the session immediately; route
that boundary through guest selection and startSession only on Continue. Pass
the confirmed composition directly to the session rather than reading recently
set React state. Back returns to the existing template/design choice and retains
the current draft. Cancel/finish/new session clears it. Retain existing payment,
queue and camera-start ordering. The guide-disabled path bypasses this screen and
keeps the existing flow. Admin may disable guest selection for a fixed-composition
event and provide a default; active sessions remain immutable.

Session composition contract:

```ts
type GuestComposition = {
  men: number;
  women: number;
  boys: number;
  girls: number;
  style: 'solo' | 'couple' | 'friends' | 'family' | 'group';
};
```

Derive total and adult/child totals rather than storing inconsistent duplicate
counts. These are guest-entered choices, not attributes inferred from images.
Keep the composition in session memory; do not add it to photo metadata or
settings history. Only the optional event default belongs in admin settings.

## Random composition-aware pose selection

Extend scene metadata with supported styles and role requirements. Each role can
accept men, women, boys, girls, any adult, any child or any person. This allows
authored men's/women's solo poses and mixed group scenes without changing the
common skeleton. Role metadata is separate from skin selection and rig coordinates.
The editor assigns these requirements and previews example guest compositions.

First filter by current slot framing, total participant count, role matching and
selected style. Child participants require explicitly child-compatible scenes;
adult-only poses cannot be assigned to them. Couple scenes require the explicitly
selected Couple style. Randomly choose from the compatible candidates; guests
choose a style, not a particular pose. Use a shuffled bag per eligible candidate
set so poses do not repeat until that set is exhausted. On reshuffle, avoid the
immediately previous pose when another candidate exists. If only one compatible
pose exists, allow reuse. Inject the random source for deterministic tests.
Pose tags express the authored pack's intended style; they
do not hardcode that every woman/man must perform the same type of gesture.

Phase 2 random selection replaces Phase 1's fixed cycle and explicit per-shot
pose priority in normal guided sessions. Preserve older saved poseId values for
settings compatibility, but do not let them override random selection. Admin
editor previews can still select a specific pose. If there are no compatible
candidates, use matching Freestyle, then the legacy instructions. A child/mixed
group must not fall back to an adult-only scene. An empty catalog never blocks
capture. Resolve a new candidate set whenever the next slot's orientation changes.

Keep count-independent Friends and Group options available when a specialized
pack is absent. Counts alone do not establish relationships or physical positions.
Use role captions and the illustrated group arrangement to explain who performs
each action; do not assume the camera knows which guest is standing on which side.

Include small prototype fixtures for men's/women's solo, two-adult Couple,
Friends, mixed-age Family, children and flexible Group matching. The complete
20-plus-pose collection remains Phase 3; metadata cannot substitute for authoring
different, fun demonstrations for these combinations.

During photography, show a compact transparent group demonstration at bottom
center with one shared caption. Start with the existing 25–30% screen-width area;
verify readability for groups on the portrait screen before choosing any larger
default. Flexible group demonstrations may use representative repeatable roles
rather than making dozens of unreadably small characters. Editor role labels
remain legible; mirror the composition and characters together, never captions.

## Editor behavior

Add Admin → Poses with a saved-pose list, editing stage and property controls.
Select a participant, then a joint or keyframe. Joint handles and skeleton lines
are optional overlays; dragging updates Canvas immediately. Convert pointer
positions through scene scale, crop and mirror transforms into canonical joint
coordinates. Clamp to the supported coordinate range. Moving a joint changes
that joint; moving a participant changes its scene transform. Do not introduce
automatic inverse kinematics or collision avoidance in this phase.

Expose head tilt, orientation, named expressions, continuous facial controls,
hand gestures, instruction, category and tags. Add/remove/duplicate participants,
position and scale them, and optionally mirror a participant's pose anatomically.
Show left/right role labels so coordinated group instructions are understandable.

Support undo/redo, reset draft, duplicate, save, delete and JSON export. Editing a
bundled pose starts a custom copy with a new ID; bundled originals stay available.
Saving updates that custom JSON. Deleting a custom pose removes it from future
random candidate sets; active sessions retain their catalog snapshot. Bundled
fallbacks remain available.

All demonstrations begin standing. The time-zero neutral body frame is fixed;
edit later frames. Save explicit evaluated body/expression values at edited
keyframes so sparse inheritance cannot accidentally change downstream frames.

## Timing and narration

The current eight seconds is a default, not a fixed runtime limit. Add total
duration, teaching-step timestamps, per-participant keyframes, event durations
and caption editing. Preview with play, pause, scrub and restart; optionally show
the existing countdown visually, without taking or saving a photo.

For silent scenes, an explicit Stretch animation action proportionally rescales
body, expression, hand, caption and event times and event durations. Changing the
duration alone does not silently rescale tracks. Reject out-of-range frames and
timestamp collisions; offer stretch or move affected frames before saving.

Allow local narration assignment/import into app-managed audio storage, display
its duration and a playback-position indicator, and add named narration markers.
Teaching steps can reference markers with offsets so body gestures, expressions
and captions remain aligned when a marker moves. Resolve these references to
ordinary absolute timestamps before runtime evaluation.

Never automatically change recorded audio speed or pitch. With narration attached,
keep audio-relative markers anchored unless the user explicitly edits them.
Fit animation to narration is an explicit operation: set demonstration duration
to audio start plus recording length and retime visual tracks, leaving the actual
recording and its speech markers unchanged. Review marker-linked steps afterward.
Reject saves that truncate known narration; allow extending/retiming the animation
or removing the audio assignment. Do not add a separate post-demonstration hold.

Preview seeking/pause must seek/pause narration too. Implement this through shared
timeline evaluation and an extended local audio playback adapter; guest play/stop
semantics stay unchanged. Missing/unloadable files remain silent and cannot block
photography. Captions remain visible with narration enabled.

## Modules and persistence

Extend src/pose/types.ts, validation.ts, PosePlayer.ts and library.ts with version
adapters and scene evaluation. Keep a participant renderer receiving the existing
evaluated rig frame; add SceneRenderer to arrange/crop participant renders. Update
PoseGuideOverlay.tsx to consume a scene frame without React updates per frame.

Add src/pose/editor/ for draft state, timeline operations, stage/joint handles,
participant controls and PoseEditor. Add renderer repository/audio adapters.
Add a separate guest-composition screen component plus pure composition
validation and pose-matching modules. Wire the existing guest session boundary
in App.tsx and keep the selection UI outside the main component.
Add electron/poseStorage.ts for list/save/delete/export and managed audio import,
with matching preload/types/browser-mock methods. Reuse existing admin settings
and session shot orchestration rather than adding another shooting workflow.

Keep custom JSON and imported audio under userData/pose-library, separate from
event photo folders and settings.json. Use safe IDs, schema validation, bounded
files and atomic writes. Validate at save and load; report invalid files while
retaining working bundled poses. Reject network audio. Do not expose arbitrary
filesystem writes through IPC. Share renderer-free schema validation in an
Electron-build-compatible module; preserve current dist-electron entry paths.

Load the catalog once per session. Saving/deleting in Admin affects subsequent
sessions only. No frame-by-frame IPC or network service is required.

## Verification and review checkpoint

- Existing v1 examples retain timing, neutral starts, cancellation and countdown.
- Verify scenes for 2, 3, 4 and flexible 4+ guests, including additional repeated roles.
- Verify participant movement/expression independence on the shared clock.
- Verify joint dragging and cropping under mirrored portrait/landscape previews.
- Verify mixed-orientation slots switch framing per shot, including rotated slots.
- Verify whole-scene stretching, caption/marker links, collisions and audio seek/stop.
- Verify save/duplicate/delete/export, restart persistence and malformed-file handling.
- Verify current sessions ignore mid-session editor changes and saved poses work offline.
- Repeat guide-disabled, screenshot fallback and pending-capture cancellation checks.
- Check live-preview responsiveness with multiple characters and recording enabled.
- Distinguish simulated camera results from physical HDMI/Canon verification.
- Verify zero-count validation, every counter, capacity, total, Back, cancel,
  per-session reset, and guide-disabled/fixed-event bypass.
- Verify men's/women's solo, same/mixed-gender two-adult Couple, Friends, mixed-age
  Family, children and 4+ Group eligibility and empty packs.
- Verify random selection, no-repeat bags, single-candidate reuse, exhaustion,
  mixed-orientation candidate changes and compatibility with older poseId settings.
- Verify all guest-screen controls fit in the upper half of the portrait display,
  with style buttons below counters and no pose/orientation chooser.
- Verify composition matching works fully offline and selected roles/captions
  match the demonstrations without adding analysis load to the preview.

Present the editor and saved group examples for review before starting Phase 3.

## Implementation notes

- Guest template/design selection now opens **Who's in the photo?**. The four
  counters, total, compatible style buttons and Continue fit in the upper half.
  Back retains the draft; starting/cancelling a session clears it. Guide-disabled
  sessions bypass the question; Workflow can also configure a fixed event group.
- RandomSceneSelector filters by composition, style, child compatibility and the
  current slot's effective dimensions, then uses shuffled no-repeat bags. Old
  poseId settings remain readable but no longer override normal random selection.
- Slot geometry is shared by viewfinder, pose framing and still-photo aspect.
  Rotation by 90/270 degrees swaps effective dimensions. Candidate-selection
  sessions use the primary slot for all captures, preserving the existing rule.
- The four original JSON poses adapt to schema v2 in memory. Additional prototype
  scenes live in src/pose/poses/scenes.json: men's/women's solo, children, Couple,
  Friends, Family and flexible Group examples. They are sample data, not final art.
- SceneTimeline evaluates independent participant tracks against one clock.
  ScenePlayer reuses PosePlayer for cancellation, audio and completion. SceneRenderer
  composites the existing Canvas skin, with full-body or half-body presentation.
  Groups above twelve show twelve representative figures; editor scenes support
  up to twelve authored participants and the guest counter capacity supports 1–30.
- Admin → Poses loads separately from the guest bundle. It provides joint dragging,
  skeleton display, participant transforms/roles, facial sliders and presets,
  gestures/events, captions, play/pause/scrub, step editing, duration/stretch,
  countdown-only preview, local narration/markers, reset, undo/redo, duplicate,
  save/delete and JSON export. Editing a bundled example creates a custom copy.
- Align current step creates a caption/keyframe if necessary and moves the body,
  face, hands and caption to the chosen narration marker. Moving a linked marker
  moves that step. Stretch keeps linked steps/audio markers anchored and validates
  ordering/collisions. Fit to narration uses the recording's natural duration;
  known audio truncation prevents saving. Missing narration remains silent.
- Pure types/validation live in electron/poseTypes.ts and poseValidation.ts and
  are re-exported by src/pose, preserving the Electron compiler's entry paths.
  electron/poseStorage.ts stores bounded JSON atomically under userData/pose-library
  and imports audio into its audio subfolder. Mutating IPC is restricted to the
  admin window. Browser preview provides corresponding local-storage behavior.
- The session snapshots the catalog and guest composition. Editor changes affect
  subsequent sessions. No animation frames travel through IPC or require AI.

## Running verification

`npm run build` checks and builds both renderer and Electron. `npm run test:poses`
runs 23 runtime/scene tests, including v1 compatibility, group matching, random
selection, rotated slot framing, joint editing, retiming and narration markers.

`scripts/verify-pose-phase2.cjs` launches built Electron with an isolated profile,
simulated camera and disabled printing. Supply Playwright with
POSE_PLAYWRIGHT_MODULE. Default mode checks the guest screen, mixed-slot session,
editor, persistence, local audio transport/markers, export/delete and legacy mode.
POSE_EDITOR_ONLY=1 narrows this to editor/storage/audio and legacy checks.
POSE_REGRESSIONS_ONLY=1 checks five-person fixed groups, capture-safe screenshot
fallback, cancellation during demonstration/countdown/pending simulated USB still,
and MediaRecorder lifecycle using a simulated recording source and intercepted
transcoding. Test assets/results remain under .cache/pose-phase2.

Real HDMI capture-card/Canon RP behavior and MP4 encoding are separate hardware
checks. No physical hardware verification is claimed by the simulated tests.

Checkpoint results: production build and all 23 runtime/scene tests pass. Both
default and regression Electron checks pass, with no renderer errors. The guest
screen's last control ended at 439px in a 960px viewport (above its 480px midpoint).
A family session selected distinct random poses for portrait and landscape slots;
saved image aspects matched 2:3 and 3:2. Median frame interval was 16.7ms and the
95th percentile was 16.8ms with simulated camera input. Joint dragging, a six-second
retime, save/reload, local WAV import, audio pause/seek, marker alignment, export,
delete, malformed-file handling and guide-disabled capture all passed. Five-person
fixed-event sessions passed screenshot fallback, cancellation at all three
stages and multi-shot MediaRecorder checks. Existing real booth settings were not
modified by these isolated runs. Phase 3 remains deferred for review.
