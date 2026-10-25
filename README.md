# Super Mario Odyssey Mac Recomp

Build **Super Mario Odyssey** into a standalone native app for Apple Silicon Macs.
Select your own base-game NSP and console keys in the browser. Extraction, ARM64
code conversion, shader translation and DMG creation run locally through WASM.
Your game files and keys stay on your device.

**[Open the browser builder](https://elad12390.github.io/SuperMarioOdysseyMacRecomp/)**

The renamed public release is being verified. The complete local browser-to-DMG
build and the generated app's native gameplay, controls and audio have passed.

## Build your game

1. Open the builder on your Mac.
2. Select your **Super Mario Odyssey base 1.0.0 NSP** and **prod.keys**. Add
   **title.keys** if your dump requires it.
3. Choose **Build my Mac version** and keep the tab open until it finishes.
4. Download the DMG, open it, and copy **Super Mario Odyssey.app** to Applications.

The app requires **Apple Silicon and macOS 26 or later**. Updates and other games
are unsupported. Keep at least **20 GB of free disk space** for the build. The
first complete build on this M4 Pro took about 75 minutes on battery; this is a
local compilation process. macOS compiles the generated Metal shaders on first
launch. The finished game needs no Homebrew, Python or .NET installation.

The game includes native sound, keyboard/controller input, uncapped rendering
and an FPS counter. Frame limit and counter settings are together under
**Options > Graphics**. Saves and graphics settings live in Application Support.

## Develop and test

- [Build and release guide](docs/browser-release.md)
- [Native runtime and local player setup](docs/local-odyssey-setup.md)
- [Native Playwright-style game harness](tools/game-harness/README.md)

The harness drives the native game directly, with separate Player and Tests
profiles. Recorded tests include an action timeline, native sound and compressed
video. The browser is the test viewer; game input goes directly to the native host.

| Path | Purpose |
| --- | --- |
| tools/browser-builder | Website, browser WASM conversion and release tooling |
| tools/browser-builder/runtime | Standalone ARM64 app template and launcher |
| tools/game-harness | Native controls, assertions and recorded gameplay tests |
| scripts/patches | Pinned Odyssey runtime compatibility patches |
| docs | Odyssey build, runtime and input documentation |

Game dumps, keys, generated apps, saves, captures and recordings are excluded
from Git. Local test and build artifacts belong under tmp/odyssey/.

## Credits and licenses

The native runtime comes from [seedds/nxnative](https://github.com/seedds/nxnative),
with the source revision and compatibility patches pinned in this repository.
The browser builder uses LibHac, Ryujinx's shader translator, SPIRV-Cross,
Pyodide, Capstone and LZ4. Their source recipes and notices accompany the public
tools and app template.

This project originated from [bgyss/SwitchRecomp](https://github.com/bgyss/SwitchRecomp).
The generic specification framework and exploratory Rust workspace have been
removed. This repository is dedicated to Super Mario Odyssey on Apple Silicon.
Original copyright notices and applicable [MIT](LICENSE-MIT) and
[Apache 2.0](LICENSE-APACHE) license texts are retained.
