# Phase 4: AI Pose Generator

Status: implemented. Phase 4 uses the Phase 2 editor, renderer, validator and local
pose storage. It does not run during guest sessions.

## Admin flow

Admin → Poses contains a compact **AI Pose Generator** section. Enter a natural
language description, choose OpenAI, Gemini or xAI, then select **Generate
preview**. A successful result immediately replaces the editor draft and displays
its final target pose in the existing sticky preview. Every existing editor tool
remains available for correction. **Save pose** writes the corrected scene to the
local pose library, where normal sessions load it without an internet connection.

The generator reuses provider API keys from Admin → AI Presets. Text model and
endpoint settings are separate from image-generation settings because image
models cannot reliably produce structured pose data. Defaults are configurable in
the generator's Provider settings:

| Provider | Default text endpoint | Default model |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1/responses` | `gpt-5.6-luna` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/interactions` | `gemini-3.8-flash` |
| xAI | `https://api.x.ai/v1/responses` | `grok-4.7` |

The adapters use each provider's structured-output format. The implementation
follows the current [OpenAI structured-output API](https://platform.openai.com/docs/api-reference/responses),
[Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output),
and [xAI structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs).

## Safe data path

The provider does not write a `PoseScene` directly. It returns a constrained
provider-neutral plan containing metadata, compatibility, participant placement,
two to four teaching steps, normalized joints, hand gestures, expressions and
blink/wink events. `electron/poseAiCore.ts` performs three gates:

1. Validate the provider response and every value, enum, coordinate and timeline.
2. Compile it into schema v2 with a locked neutral standing frame at zero.
3. Run the existing `validateScene` before returning anything to React.

Malformed JSON, unsafe coordinates, missing fields, invalid timelines, provider
errors and missing credentials are rejected. Generation runs in Electron's main
process with a 90-second timeout. The guest renderer does not receive a generation
endpoint and cannot invoke the admin-only IPC handler.

## Offline behavior

Only the admin Generate action requires a network connection. Preview, manual
editing, saving, scene selection, animation, captions, countdown and photography
continue using local files and the existing runtime. Provider output is never
needed again after a scene is saved. Failed generation leaves the current pose
library unchanged.

## Verification

`tests/pose-ai.test.cjs` verifies compilation, neutral starts, continuous facial
values, wink events, flexible groups, all three provider request shapes, missing
credentials, provider errors and malformed JSON. The Electron verification stubs
the remote response and checks immediate preview, validation and local save.

Live provider requests require the owner's API keys and were not made during the
automated verification. Canon RP and HDMI hardware behavior are unchanged by this
admin-only feature.
