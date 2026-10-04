# Animated Pose Guide (Compatibility History)

The current product direction is the photo-based Pose Challenge system described
in [Photo Pose Challenge System](pose-challenge-plan.md). The cutout renderer is
now the default guest experience; the skeletal character documented below remains
for compatibility, editor migration and comparison only.

## Current Phase 3 runtime

Phase 2 adds the upper-half **Who's in the photo?** guest screen, random compatible
scenes, template-slot full/half-body framing, and Admin → Poses. Phase 3 adds 87
playful offline scenes, coordinated multi-person compositions, expanded facial
performance, and compact search/category filtering. Saved JSON and narration work
locally. See [Phase 2](pose-guide-phase-2.md) and [Phase 3](pose-guide-phase-3.md).
The Phase 1 description below records the original checkpoint; its fixed cycling
and per-shot pose selector have been replaced by random selection in Phase 2.

## Phase 1 implementation

The existing Electron / React session remains responsible for camera acquisition,
photo count, countdown, Canon USB capture, selection and printing. The HDMI video
and current viewfinder remain unchanged. The pose coach is a separate transparent
Canvas overlay at bottom center, with a caption below it.

Each shot follows:

```
standing → two-second teaching sequence → two-second final hold → 3 → 2 → 1 → capture → next shot
```

There is no extra hold. On `3` the coach and caption fade; on `1` they disappear.
Before capture, the overlay is hidden synchronously and the session waits for a
paint. This also protects the existing screenshot fallback from guide burn-in.

Admin → Workflow contains the guide switch and a per-photo pose selector. Older
settings default to enabled. An unassigned shot cycles through Peace + Wink,
Heart Hands, Hands on Cheeks and Freestyle; an unavailable assigned ID uses
Freestyle. The guide switch restores the legacy per-shot message/timing flow.
Guide enablement and pose assignment are fixed for the active session; admin
changes take effect on the next session rather than interrupting a demonstration.
The existing intro, countdown, music and shutter audio are retained. Legacy shot
narration is suppressed during guided demonstrations so it cannot contradict the
step captions.

## Data flow and module boundaries

```
bundled pose JSON → validation → PoseTimeline / common skeleton
                                      ├─ body transforms
                                      ├─ ExpressionController
                                      ├─ hand gestures
                                      └─ captions / audio markers
                                 → CharacterRenderer → transparent Canvas
session controller → await PosePlayer.play → existing countdown → captureFrame
```

- `src/pose/types.ts`: versioned pose, evaluated frame, clock and audio contracts.
- `validation.ts`: checks versions, joint names, normalized coordinates, expression
  controls, timestamps, durations, gestures and local audio references.
- `skeleton.ts`: neutral rig, bone connections, easing and forward kinematics.
- `ExpressionController.ts`: independent expression interpolation, presets and
  transient blink/wink overlays.
- `PosePlayer.ts`: compiled timeline, one animation loop, completion/cancellation,
  optional audio preparation, playback and marker callbacks.
- `CharacterRenderer.ts`: interchangeable skin contract. A renderer receives an
  evaluated frame and must not branch on pose IDs.
- `CanvasCharacterRenderer.ts`: temporary full-body character and facial controls.
- `PoseGuideOverlay.tsx`: React boundary; updates React only when captions or
  session states change, not on every frame. Canvas resolution is capped at DPR 2.
- `audio.ts`: adapter to the existing local audio and volume system.
- `library.ts` and `poses/`: four compatibility demonstrations plus 87 validated,
  bundled, offline scenes.

The guide adds no animation IPC, Python processing, AI calls or new production
dependencies. Pose errors fall back to the existing instruction/countdown flow.
Cancellation propagates through an AbortSignal and the existing session run token;
stale captures cannot start another shot or update a replacement session.

## Pose format v1

Each definition has `schemaVersion: 1`, `skeletonVersion: "human-2d-v1"`, identity,
name, category, tags, instruction and `animation.durationMs` (4000 for the current pack).
The following tracks share a clock starting at zero:

| Track | Keyframe fields |
| --- | --- |
| `body` | `timeMs`, optional joint coordinates, `headTilt` in degrees, `orientation` in −1…1 |
| `expressions` | `timeMs`, optional preset and continuous control overrides |
| `hands` | `timeMs`, optional `left` and `right` gesture |
| `captions` | `timeMs`, `text` |
| `events` | `timeMs`, `action` (blink/winkLeft/winkRight), `durationMs` |

Body, expression, hand and caption tracks start at time zero. Sparse authored
body frames inherit unchanged joints; runtime frames contain the complete rig.
Continuous tracks ease toward the next keyframe. Hand gestures and captions
change at their timestamps. Body coordinates use a canonical 400 × 720 character
space normalized to 0…1, with x increasing right and y increasing down. They are
independent of viewport size and print geometry.

Left/right names are anatomical. In the front-facing canonical rig, anatomical
left is screen-right. The character is reflected when `mirrorPreview` is enabled,
so a right-hand instruction appears on the guest's right in the mirror. Captions
are never reflected. `orientation` is a stylized 2D hint, not a 3D body rotation.

The hierarchy includes pelvis, torso, neck, head, shoulders, elbows, wrists,
hands, hips, knees and ankles. Bone edges represent upper arms, forearms, thighs
and lower legs. Interpolation reconstructs connected limbs using parent-relative
angles and interpolated segment lengths; it does not assume one skin's proportions.
Future skins can retarget these transforms to their own bind lengths.

Facial controls include smile, mouth opening, independent eye closure, brows,
blush, pout, kiss, directional gaze, independent brow raising, brow furrow, cheek
raise, nose scrunch, smirk, frown, jaw drop and tongue (all 0…1). Presets also
cover confident, determined, suspicious, villain, awkward, panic and deadpan.
Timed blinks/winks temporarily overlay the underlying expression without modifying
body movement.

## Pose narration

No narration assets are required or generated in Phase 1. A pose can optionally
contain:

```json
"audio": {
  "filePath": "C:/event/audio/poses/peace-wink.wav",
  "startMs": 0,
  "markers": [
    { "id": "raise-hand", "timeMs": 0 },
    { "id": "peace-sign", "timeMs": 2600 },
    { "id": "smile-wink", "timeMs": 5200 }
  ]
}
```

Use local files; network audio URLs are rejected. Before the animation clock
starts, the adapter loads the local file with a bounded 1.5-second wait. Failure
continues silently. Playback begins at `startMs` and uses the existing voice
volume/channel controls. Stop, reset, replacement and completion stop narration
and invalidate stale loads. Marker callbacks fire once per playback.

When adding recordings, author body/expression/caption timestamps against the
recording and explicitly set the pose duration. The timeline owns countdown;
audio duration does not add an independent hold. Recordings must fit within the
authored timeline. The current four definitions intentionally contain no audio.
The future editor will expose assignment and synchronization controls.

## Verification

`npm run build` typechecks both renderer and Electron and builds the UI.
`npm run test:poses` uses Node's test runner with in-memory TypeScript compilation;
it adds no test framework or production dependency. It verifies timelines,
neutral starts, easing, expressions, captions, validation, 12-shot cycling,
cancellation, replacement, reset and audio lifecycle behavior.

`scripts/verify-pose-guide.cjs` is an optional Playwright desktop smoke test.
Provide Playwright via `POSE_PLAYWRIGHT_MODULE` or your development environment.
It launches the built Electron application with an isolated profile and simulated
camera input. Test photos, screenshots and results stay under `.cache/pose-check`.
It never changes the booth's real settings or prints. Physical Canon/HDMI behavior
requires a separate on-device test; simulated input is not hardware certification.

The desktop verification also has focused modes: `POSE_CHECK_ADVANCED_ONLY=1`
checks screenshot fallback, cancellation of a pending simulated Canon capture,
six shots and MediaRecorder lifecycle. `POSE_CHECK_SETTINGS_ONLY=1` checks admin
changes during a demonstration. The recording test uses a simulated recording
source and intercepts transcoding; it does not certify screen-source drivers or
MP4 encoding.

Phase 1 checkpoint results: production build and all 12 runtime tests passed.
Electron checks passed for four guided shots, offline operation, selection,
legacy-mode capture, cancellation during animation/countdown/pending simulated
Canon capture, screenshot fallback, six shots with simulated recording input,
invalid-ID fallback and admin changes during a demonstration. No renderer errors
were recorded. In the four-shot simulated-camera run, median animation-frame
interval was 16.7 ms and the 95th percentile was 16.8 ms. Canon RP and HDMI capture
hardware were not detected during verification; those remain unverified.

## Review checkpoint and next phases

| Phase | Status | Deliverable |
| --- | --- | --- |
| 1 | Implemented; review checkpoint | Temporary rig, four JSON timelines, captions, countdown integration, audio hooks |
| 2 | Implemented; review checkpoint | [Pose Editor, guest composition, random group scenes, framing and audio timing](pose-guide-phase-2.md) |
| 3 | Implemented; review checkpoint | [87-scene playful library, coordinated groups, expressions, search and filtering](pose-guide-phase-3.md) |
| 4 | Implemented; review checkpoint | [Provider-independent AI description → validated JSON → preview/correction → offline storage](pose-guide-phase-4.md) |
| 5 | Deferred | Polished reusable character and interchangeable skins, including Rive feasibility testing |
| 6 | Deferred | Ghost presentation and independent reference-image pose detection |

Rive's advanced web runtime exposes named bones and mutable transforms, but a
specific rig still needs testing for deformation, constraints, retargeting and
competing animation controls. Actual `.riv` authoring/export access must be
confirmed. No Rive asset or runtime dependency is included in Phase 1. A later
adapter must consume the same evaluated frame, without separate animations per
pose. Until that works reliably, keep Canvas as the proven renderer.

Future Ghost Mode changes overlay placement/opacity, not pose evaluation. AI and
reference detection should produce the common validated pose format, independently
of rendering. Pose definitions must not contain skin IDs, Rive node names or
handcrafted animation names.
