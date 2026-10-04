# Phase 3: Playful Pose Library

Status: implemented. The bundled offline catalog contains 87 schema-v2 scenes in
addition to the four Phase 1 compatibility demonstrations. The pack is generated
from reusable body, expression and composition archetypes with
`npm run generate:poses`; the runtime consumes the resulting JSON and never needs
the generator or a network connection.

## Library coverage

| Category | Scenes |
| --- | ---: |
| Funny | 15 |
| Party | 15 |
| Glamour | 11 |
| Friends | 10 |
| Couple | 7 |
| Family | 9 |
| Cute | 5 |
| Professional | 4 |
| Kids | 5 |
| Wedding | 4 |
| Group | 1 |
| Solo | 1 |

The category describes the primary browsing group; compatibility styles and tags
allow scenes to serve more than one guest composition. There are 24 solo scenes,
63 cooperative multi-person scenes and 16 flexible scenes that expand for larger
groups. Sixty-three scenes are child-safe. Adult-only scenes are excluded whenever
the entered group contains a boy or girl.

The pack includes dependable portrait foundations, but most of it is playful:
movie-poster formations, anime-inspired teams, secret agents, fashion editorials,
reaction chains, power-ups, human waves, many-armed illusions, family role-play,
zombie runway, alien abduction and other coordinated scenes. These are generic
genre ideas and do not depend on copyrighted characters or character artwork.

## Timing and group composition

Every bundled scene runs for four seconds. Captions change at 0.0, 0.5, 1.0, 1.5
and 2.0 seconds. Movement reaches the final body and expression at 2.0 seconds,
then holds unchanged until 4.0 seconds. The existing session countdown begins
afterward.

Multi-person scenes assign Guest A/B/C/D roles with independent bodies, hands,
expressions and mirrored placement. Exact two-, three- and four-person scenes use
pair, triangle and diamond layouts. Flexible 4+ scenes build overlapping front
and rear rows and display up to twelve representative characters on the guide.

Each scene carries people limits, eligible styles, full/half-body framing,
child-safety and searchable tags for formation, expression and interaction.
Existing template orientation selection remains authoritative: portrait slots use
full-body-compatible scenes and landscape slots use half-body-compatible scenes.

## Facial performance

The temporary Canvas character now supports 21 continuous controls, including
directional gaze, independent brows, brow furrow, cheek raise, nose scrunch,
smirk, frown, jaw drop and tongue in addition to the original smile, mouth, eye,
blush, pout and kiss controls. New presets cover confident, determined,
suspicious, villain, awkward, panic and deadpan expressions. Every scene authors
an expression per participant and retains natural blink/wink events during the
final hold.

## Admin library

Admin → Poses shows the total and filtered counts, a text search, category filter,
category label and people-count compatibility for every result. Bundled scenes
remain copy-on-edit so the generated pack cannot be overwritten accidentally.
Custom poses continue to use the existing local save, duplicate, edit, narration
and delete flow.

## Verification

The pose tests validate every bundled scene, category coverage, the four-second
timeline, half-second captions, two-second final hold, expression diversity,
people-role matching, adaptive groups and legacy-ID compatibility. Production
build and the isolated Electron editor verification are the release checks.
