# Portable development setup

The repository is the source of truth for shared Photo Booth behavior and reusable assets.

## New computer

1. Clone or pull the repository.
2. Run `npm install`.
3. Install 64-bit Python and run `py -3 -m pip install -r python\requirements.txt` when Canon USB capture is needed.
4. Run `npm run dev`.
5. Configure local credentials, the event output folder, camera, and printers in the admin window.

Shared settings are loaded from `config/settings.shared.json`. In development, changes to shared settings are written back to that tracked file and can be committed normally.

Private and machine-specific values are written to ignored `config/settings.local.json`. This includes API keys, cloud credentials, passwords, camera identifiers, output folders, and printer assignments.

Reusable files live under `public/project-assets/`. Guest originals, final photos, thumbnails, videos, and AI queue inputs/results remain in the local event folder and must not be committed.

## Maintenance

- `npm run portable:migrate` refreshes the tracked snapshot from this computer without deleting source files.
- `npm run portable:verify` checks for secrets, absolute paths, missing assets, videos, and files too large for normal GitHub storage.
- Run `npm run portable:verify` before committing portable data changes.
