# Browser-only Odyssey builder

Create a public GitHub Pages website that accepts a user-supplied Super Mario Odyssey base-game NSP and prod.keys (optional title.keys), performs extraction, ARM64 rewriting and shader translation locally in browser WASM workers, and downloads a self-contained playable Apple Silicon macOS DMG. No game bytes or keys leave the browser. No native helper or server build is allowed.

Constraints:
- Publish only open-source tools and a generic native runtime, with dependency notices and reproducible pinned builds. Never publish game-derived code, shaders, fonts, images, keys or personal saves.
- Keep the no-piracy, no-original-game-included and Nintendo non-affiliation notices visible in the README and builder. They describe the project; they do not provide legal clearance.
- Validate the supported title/build from decrypted metadata; fail clearly for unsupported input, missing keys, corrupt files or insufficient storage.
- Stream large input files and output through browser storage; do not place a multi-gigabyte NSP into one ArrayBuffer or WASM linear memory.
- Generated app is relocatable and uses Application Support for saves/settings; it must not depend on this checkout or Homebrew.
- Include native sound, controls, stable renderer and Graphics FPS settings. Preserve the existing Player installation and saves during validation.
- One user action starts conversion after both required files are selected. Show real progress and cancellation; download becomes available only after all stages succeed.

Acceptance examples:
1. Drop the supported base NSP and correct keys: the real browser pipeline produces a DMG; mount, copy the app outside this checkout, launch in an isolated test profile and reach controllable gameplay with audio.
2. Drop a wrong title or unsupported main build: reject before rewriting and do not produce a misleading ready download.
3. Wrong keys or truncated NSP: show an actionable error without exposing key values.
4. Cancel during a stage: terminate workers, release file handles and remove this job storage; keep source files untouched.
5. Observe network during a real run: static tool/runtime downloads only; no upload of game content, keys, save or generated output.
6. GitHub CI publishes a functional static site and reproducible public tool bundle containing no private inputs.

Current implementation status:
- Browser ports, standalone source-built native runtime, app sealing and disk-image assembly are implemented; real component and scale proofs are recorded in `docs/browser-release.md`.
- The integrated real-game browser-to-DMG run and all seven relocated native gameplay/audio checks pass locally. The public website is deployed; all 1,582 hosted assets, live intake/layout and 11-record hosted shader parity checks pass. Source/compiler fingerprints and the distinction between local full-game and hosted regression evidence are recorded in docs/browser-release.md.
- User explicitly selected all compilation/conversion in browser WASM on 2026-10-25.

Human decision: macOS first-launch Metal shader compilation explicitly approved; extraction, ARM64 rewriting and shader translation remain browser WASM.
