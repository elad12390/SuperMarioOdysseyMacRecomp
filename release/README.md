# Play Super Mario Odyssey

Double-click **Super Mario Odyssey.app** in this folder. It opens your **Player**
save, with native rendering and controller support.

Double-click **Play Fresh Save.command** to start your separate **FreshStart**
playthrough from the beginning. After its first launch, this shortcut resumes
that new playthrough. Your original progress still opens with the normal app.
Both launchers use the same prepared native game build.

This is the local playable build. Keep it inside this workspace: the app uses
the prepared game data in `game-data/super-mario-odyssey/`.

Your existing progress is in `game-data/super-mario-odyssey/run/save/`.
Additional personal slots are in `game-data/super-mario-odyssey/run/saves/`.
Automated tests use separate files under `tmp/odyssey/`.
Verified dated backups of your original save and renderer settings are in
`game-data/super-mario-odyssey/save-backups/`; each has a SHA-256 manifest.

To play another personal slot from Terminal:

```sh
./scripts/play-odyssey.command --slot Elad2
```

Folder guide:

| Folder | Contents |
| --- | --- |
| `release/` | The app to open and play |
| `game-data/super-mario-odyssey/` | Prepared native host, game data and your saves |
| `source-dumps/super-mario-odyssey/` | Your original NSP and extraction |
| `tools/game-harness/` | Native Playwright tests and recording tools |
| `external/nxnative/` | Native runtime source |
| `tmp/` | Generated logs, videos, test saves and diagnostics |

Rebuild the local app launcher with `./scripts/build-odyssey-app.command`.
