# October 2026 meme pose pack

The pack contains the 40 selected meme and photo-booth poses, with inclusive
participant roles, group limits, framing rules and four spoken coaching cues.
The illustrations use the existing photorealistic sticker style, white/color
outlines and dimensional arcade titles. Images were generated individually with
the built-in image generation tool, using the previous Shoulder Switch image as
a style reference. Transparent WebP assets live in `public/pose-guides/`.

The source of truth for prompts, casting, pose descriptions and library metadata
is `scripts/meme-pose-pack.cjs`. The generated prompt manifest is
`src/pose/poses/meme-pose-pack.json`. Existing poses and their artwork are preserved.

After saving all 40 cutouts, run:

```
npm run build:meme-poses
npm run generate:meme-voices
npm run save:meme-voices
npm run test:poses
npm run build
```

The pack builder checks every image exists before registering the photo manifest
and rebuilding the scene library. The voice command uses the locally saved
ElevenLabs settings, generates only this pack, decodes each MP3 to check it, and
skips existing audio. The save command persists the pack as complete editable
library entries under `config/poses/`, with timing adjusted to the voice duration.
Audio stays portable under `public/project-assets/audio/elevenlabs/`.

The normal application and portable builds include the bundled library and
cutouts through Vite, and editable pose entries plus voice assets through the
existing Electron resource configuration. The application prebuild hook runs
the pack builder automatically, so missing pack artwork stops the build.

To prepare WebP cutouts and a preview sheet from the local generation source map:

```
python scripts/prepare-meme-cutouts.py .cache/meme-pose-image-sources.json
```

This preserves the generated alpha without changing the artwork and checks every
saved image. The local source map and verification report stay in the ignored
cache directory. The preview is `docs/assets/meme-pose-pack-preview.jpg`.
