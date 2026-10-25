# Super Mario Odyssey Mac Recomp repository guidelines

## Scope and layout

This project builds Super Mario Odyssey base 1.0.0 for Apple Silicon macOS.
The product is a static website that converts a user's local NSP and keys through
browser WASM and downloads a standalone native app in a DMG.

- tools/browser-builder/: website, converters, packaging and release tooling.
- tools/browser-builder/runtime/: source-built native template and launcher.
- tools/game-harness/: native Playwright-style controls and recorded tests.
- scripts/patches/: pinned Odyssey runtime compatibility patches.
- docs/: current Odyssey build, runtime and input documentation.
- tmp/odyssey/: ignored logs, builds, test saves, captures and recordings.

The unused generic Rust workspace, sample titles, specification series, Nix
shell and AWS automation were removed at the user's request. Keep the project
focused on this game and the browser-to-DMG workflow.

## Boundaries

- Extraction, ARM64 conversion and shader translation run locally in browser
  WASM. Do not add game uploads, a remote build service or a native converter.
- The user approved native first-launch Metal compilation of browser-generated
  shader source. Publish only reusable OSS tools/runtime, source recipes and
  notices. Never track or publish game binaries, keys, derived game DMGs or saves.
- Use pristine pinned nxnative source with the tracked compatibility patches.
  The ignored development checkout can contain unrelated experiments.
- Preserve existing Player saves, preferences and prepared game builds. Keep
  Tests isolated. Preserve persistent identifiers and save-path compatibility
  while changing project branding.
- Native-window and ScreenCaptureKit tests require explicit user permission.
  Use the isolated headless native path for automated gameplay acceptance.
- Fix renderer issues through resource/frame lifecycles. Preserve uncapped
  rendering and verify frame times, render rate and memory after renderer fixes.
- Keep FPS limit and counter settings together in Options > Graphics.
- Keep generated artifacts under tmp/odyssey/. Keep persistent Player data in
  its existing game directory or Application Support profile.

- Keep the README and builder's no-piracy, no-game-included and Nintendo
  non-affiliation notices visible. Never describe a disclaimer as legal clearance
  or promise that the project has no legal risk.

## Development and checks

Use Bun. Full source-release commands and required SDK versions are documented
in docs/browser-release.md and .github/workflows/browser-release.yml.

- bun run --cwd tools/browser-builder typecheck
- bun run --cwd tools/browser-builder test
- bun test ./tools/browser-builder/dmg/test
- bun run --cwd tools/browser-builder/signing test (requires the built runtime)
- bun test ./tools/browser-builder/runtime/tests/portable.test.ts
- bun tools/browser-builder/tests/release-reuse.mjs --runtime /absolute/runtime/public
- bun tools/browser-builder/release/tests/public-marker.test.mjs

Run the full applicable suite after changes and record commands/results. A site
build or unit check does not establish playable output. Release acceptance needs
the real browser pipeline, verified DMG, relocated app and native gameplay/audio.
Keep scope-specific instructions in the modules' AGENTS.md files.

## Source hygiene and delivery

- Author and commit as Elad Ben-Haim <elad12390@gmail.com> using repository-local
  Git settings. Do not use the work email or add AI attribution/co-author trailers.
- Keep changes focused. Update the relevant build/runtime documentation with
  behavior, scope and process changes. Prefer concrete acceptance criteria.
- Keep text ASCII unless a source name requires Unicode.
- Preserve byte-verified dependency licenses; formatting exceptions are limited
  to tools/browser-builder/release/licenses/*.txt.
- Always test, document and commit code you modify. Only publish/push when the
  user has requested it; the browser website release is explicitly authorized.
- Use concise commit messages and document relevant test outcomes in PRs.
- Never stage unrelated existing work. Before delegation record git status and
  diff statistics, assign exclusive writable scopes, then review each returned
  diff against that baseline. Do not mix unrelated agent scopes in one commit.
- If hooks modify files, rerun their targets, stage again and recommit as needed.
  Publish only a clean audited source snapshot with checks green.
