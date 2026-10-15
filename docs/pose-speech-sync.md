# Speech-aligned pose captions

Pose narration uses measured speech timestamps rather than a fixed six-second schedule.

- **Generate MP3** requests ElevenLabs speech with character timestamps and assigns each caption to the start of its spoken phrase.
- **Sync captions** aligns a pose's existing recording without replacing the MP3. Save the pose afterward.
- **Sync all captions** processes and saves the full library, skips completed poses, and can stop after the current pose.
- Guest playback and the editor follow the audio playback position. The guide holds its final caption for one second after the recording ends.
- Aligned timing is stored with each pose and works offline. Changing caption wording invalidates the alignment; generate or sync again.

The existing-recording workflow requires the ElevenLabs key's **Forced Alignment → Access** permission. New speech generation requires **Text to Speech → Access**.

## Batch processing

Run `npm run sync:pose-captions` to align the saved library. The batch reuses recordings, caches measured alignment by recording contents and caption text, backs up changed pose JSON under the app's user data folder, and resumes by skipping completed poses.

Progress and failures are saved to `output/pose-caption-sync.json`. A failed pose remains unchanged; no estimated timings are labelled as synced.

API references: [Speech with timing](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps), [Forced alignment](https://elevenlabs.io/docs/api-reference/forced-alignment/create/).
