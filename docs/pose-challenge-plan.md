# Photo Pose Challenge System

## Direction

The guest-facing pose guide uses original, locally bundled photo cutouts instead
of a rigged animated character. Each cutout is a realistic person or group in an
achievable pose, surrounded by a thick white sticker edge, one strong colored
outline, a small number of graphic accents, and a bold video-game title built
into the composition.

The visual reference is the supplied sticker collage: expressive people, clear
silhouettes, bright clothing, readable hands, and transparent backgrounds. Titles
are rendered as part of the final artwork so spelling stays correct and the
typography stays sharp. Captions remain separate and editable in the app.

Race, skin tone, hair texture, body shape and styling vary across the library.
Multi-person artwork uses mixed-race groups where appropriate. Family artwork
has a warmer cooperative adventure-game mood with stars, shields and bright
colors; friends use party energy; couples use cinematic or romantic styling;
solo poses use character-selection and fashion-game styling.

## Runtime behavior

The existing Electron session still owns camera startup, HDMI live preview,
template slots, Canon capture, countdown, photo selection and printing. The
photo guide is a transparent overlay with no animation IPC and no runtime AI
dependency.

For each shot:

```text
live mirror → cutout enters → timed captions/audio cues → final hold
→ cutout shrinks and slides down → clean paint → 3 → 2 → 1 → capture
```

The demonstration lasts four seconds. Captions can change at roughly 0.5-second
beats, with the final pose held for the last two seconds. During countdown the
cutout and captions leave the screen completely before capture. HDMI preview
continues between shots.

Cutouts remain bottom-center while teaching and stay small enough to preserve the
guest's face and body as the primary visual. Full-body guides use a narrower
portrait presentation; half-body group guides use a wider presentation. The
guide does not cover the saved still because capture waits for the hidden overlay
to paint.

## Selection rules

The existing **Who's in the photo?** screen remains the only guest input. Guests
enter Men, Women, Boys and Girls counts and choose an optional style such as
Friends, Family or Group. Automatic people counting, age detection and gender
detection are not used.

The current template slot determines framing for every shot:

- vertical slot → full-body-compatible guide;
- horizontal slot → half-body-compatible guide;
- square slot → half-body-compatible guide;
- 90/270-degree slot rotation → use the slot's effective dimensions.

Pose selection is random within the compatible catalog and uses a shuffled bag so
the same guide does not repeat until the eligible set is exhausted. The slot's
people count and selected style remain authoritative. If no photo guide matches,
the session falls back to the existing instruction/countdown flow without blocking
photography.

The first bundled pilot contains twelve titled guides:

| Guide | People | Framing | Mood |
| --- | ---: | --- | --- |
| Peace Power | 1 | Half | playful solo |
| Runway Step | 1 | Full | fashion |
| Hero Landing | 1 | Full | action |
| Vogue Angles | 1 | Half | editorial |
| Back to Back | 2 | Full/half compatible scene | spy comedy |
| Sweet Moment | 2 | Half | romantic |
| Secret Shock | 2 | Half | funny friends |
| Anime Squad | 3 | Full | team action |
| Family Power | 3+ | Full/half compatible scene | family adventure |
| Emotion Explosion | 4 | Half | party reaction |
| Action Diamond | 4 | Full | action ensemble |
| Many Arms | 5+ | Half | group illusion |

The artwork is representative for flexible family and 5+ scenes; later packs can
add exact-count variants without changing the selection contract.

## Data contract

The existing validated scene metadata remains the source of duration, captions,
audio markers, people compatibility, style and framing. New scenes add an
optional visual block:

```json
{
  "visual": {
    "kind": "photo-cutout",
    "assetPath": "pose-guides/peace-power.webp",
    "alt": "A smiling guest points at the camera while making a peace sign and winking.",
    "accent": "#1769ff"
  }
}
```

Photo guides do not require joint tracks for their presentation. The old
skeletal scenes and editor data remain schema-compatible as a fallback while the
new image renderer becomes the default guest experience.

Assets are WebP files with alpha under `public/pose-guides/`. They are preloaded
before playback and referenced with local URLs so packaged Electron builds work
offline. Missing assets fail gracefully into the existing legacy instruction
flow.

## Voice and sound

Each guide may contain local narration timing markers and short scripts. The
runtime starts and stops local audio through the existing voice channel; missing
audio is silent and never blocks a photo.

Later, an ElevenLabs batch tool can generate narration from those scripts. It will
store downloaded audio and its voice/model/script metadata locally. ElevenLabs is
an authoring-time provider only; the booth will never require an API call during
an event. Captions and audio markers are authored together so narration does not
create an accidental extra hold.

## Admin editing

The Pose Editor now defaults to the photo-guide catalog and previews the actual
cutout artwork. Photo guides need simple controls rather than joint-by-joint rig
editing:

- replace or import a cutout image;
- edit title metadata, instruction, category, tags and compatibility;
- edit four-second caption timing;
- assign and align local narration;
- adjust scale and placement within the safe overlay area;
- preview, duplicate, save and delete.

Legacy skeletal scenes keep the existing skeleton editor for compatibility, but
they are no longer selected for normal guest sessions.

## Deferred phases

1. **Pilot review:** verify the twelve generated cutouts on the 43-inch portrait
   display with simulated camera sessions, then replace any weak image.
2. **Pose editor completion:** add image replacement, safe-area placement and
   compact photo-guide editing controls.
3. **Library expansion:** add exact-count variants for families, couples,
   children, 2/3/4-person groups and 5+ groups, with more race and styling
   variety while preserving the same visual language.
4. **Narration batch generation:** add ElevenLabs provider settings, batch
   generation, local caching, voice selection and marker review.
5. **Optional alternate variants:** add multiple local visual variants per pose if
   a session needs more appearance variety.
6. **Advanced modes:** consider Ghost Mode and reference-photo pose detection
   only after the cutout guide is stable.

Rive is no longer required for the guest-facing guide. It can be evaluated later
for a separate character experience, but it will not control these photo poses or
force the library back into per-joint animation authoring.

## Verification

`npm run build` must pass renderer and Electron typechecks. `npm run test:poses`
checks the validated pilot catalog, packaged assets, orientation filtering,
composition matching, four-second timelines, cancellation, missing-audio behavior
and legacy fallback. Electron smoke tests must verify portrait and landscape
slots, people-count selection, guide-disabled mode, countdown hiding and clean
capture. Canon RP and HDMI hardware checks remain separate from simulated tests.
