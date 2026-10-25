# Browser ARM64 NSO rewriter

This module executes the canonical nxnative Python rewriter unchanged in a
dedicated Pyodide worker. It produces native ARM64 images and the loader's TSV
sidecars. It does not execute the native game or build the rest of the app.

## Integration

```js
import { run } from './rewriter/index.mjs';

const controller = new AbortController();
const manifest = await run({
  inputDirectory,  // local FileSystemDirectoryHandle containing original ExeFS
  outputDirectory, // separate local FileSystemDirectoryHandle
  modules: ['main', 'subsdk0', 'sdk'],
  signal: controller.signal, // optional
}, event => {
  // stage: validate | bootstrap | rewrite | python | rewritten
  // rewrite/rewritten: module, completed, total
  // python: real upstream stdout/stderr text
});
// manifest.files: [{name, size, sha256}, ...]
// manifest.modules: [{name, buildId, inputSize}, ...]
// manifest.provenance: pinned revision, patch digest and dependency versions
```

Use the generated bundle's `index.mjs`: its default dependency URL is the same
directory as the adapter. If serving source and dependencies separately, pass
`bundleURL: '/static/rewriter/'`. This URL locates static dependencies only;
game input must always be a local directory handle. Serve `.mjs` as JavaScript
and `.wasm` as `application/wasm`, over HTTPS or localhost.

An existing expected output name causes rejection without overwriting it. Use a
dedicated empty directory for a run, with no concurrent writers. On failure or
cancellation, the parent terminates the worker and removes this run's outputs.
Only a fulfilled promise means the manifest is ready. No output is executed.

Supported original v0 builds:

| Module | First 16 build-ID bytes |
| --- | --- |
| main | `3ca12dfaaf9c82da064d1698df79cda1` |
| subsdk0 | `798c30e126697f2222cf843f78f5c140` |
| sdk | `ae34e75d02925f4417b24499ad80c394` |

All three modules are validated before bootstrapping. Segment bounds,
decompression sizes and the original NSO SHA-256 segment hashes are checked.
Inputs are read individually (limit 128 MiB per module, 256 MiB image/BSS).
The worker releases Python rewrite state and MEMFS files between modules.

## Pinned local build

Requirements: Bun, uv, git, make and an arm64 macOS host. Run the build as a
background job with a captured PID, log and exit status:

```sh
job_dir=tmp/odyssey/browser-rewriter/build
mkdir -p "$job_dir"
(
  bash tools/browser-builder/wasm/rewriter/build/dependencies.sh
  result=$?
  printf '%s\n' "$result" > "$job_dir/build.status"
) > "$job_dir/build.log" 2>&1 &
job_pid=$!
printf '%s\n' "$job_pid" > "$job_dir/build.pid"
```

The build also captures each dependency command's PID/log/status under
`tmp/odyssey/browser-rewriter/build-logs/`. The directory
`tmp/odyssey/browser-rewriter/bundle/` is the complete static module to copy
into the browser release; it contains adapter/worker, `sources.json`, Pyodide,
WASM wheels, dependency hashes, notices and `SHA256SUMS`. Keep private test
inputs, browser profiles and evidence out of the release bundle.

Pins:

- nxnative commit `0045c1dfb639f9775891382646ad38c2a11c56bf`.
- Root `scripts/patches/nxnative-odyssey-sdk3.patch` SHA-256
  `98cfcc7d1456941d75c3c3ef7be1b0e9194a0d73d6fae7a1604f90cdc157aaff`.
- Pyodide `0.28.3`, Python ABI `cp313`, platform `pyodide_2025_0_wasm32`.
- Emscripten `4.0.9`, emsdk commit
  `3bcf1dcd01f040f370e10fe673a092d9ed79ebb5`.
- Capstone `5.0.6` source archive SHA-256
  `b11a87d67751b006b9b44428d59c99512e6d6c89cf7dff8cdd92d9065628b5a0`.
  Official Makefile, ARM64 backend, full detail (DIET disabled), WASM side module;
  official setuptools wheel includes the unchanged upstream ctypes binding.
- LZ4 `4.4.4`, official Pyodide WASM wheel SHA-256
  `98d2f8ec75fd46f2e99204a38aecdd7d9d00b20c27c2578033dfdf66c993198c`.
- Test-only puppeteer-core `24.15.0`.

The build reads source with `git show` at the pinned commit and applies only the
Python portions of the approved root patch in scratch storage. It never copies
the ignored child's working tree. `sources.json` contains the actual source
text and hashes for all 23 Python files, including every upstream per-build
patch, retaining the canonical `build_src.sha256` layout and patch registry.
No Python patcher or ARM64 instruction logic is reimplemented or monkeypatched.

The Emscripten/uv/setuptools tools run on the build host only; the delivered
product uses browser WASM and filesystem APIs exclusively. Host dependency
installation uses Bun/uv/emsdk and Pyodide's normal package installer. The build
sets a fixed `SOURCE_DATE_EPOCH` for reproducible wheel ZIP metadata.

Official references used for build behavior:
[Pyodide package builds](https://pyodide.org/en/stable/development/building-packages.html),
[pyodide-build](https://pyodide-build.readthedocs.io/en/latest/),
[ABI and SDK version management](https://pyodide-build.readthedocs.io/en/latest/how-to/xbuildenv.html).

## Real browser verification

```sh
job_dir=tmp/odyssey/browser-rewriter/verification
mkdir -p "$job_dir"
(
  bun tools/browser-builder/wasm/rewriter/test/browser.mjs
  result=$?
  printf '%s\n' "$result" > "$job_dir/test.status"
) > "$job_dir/test.log" 2>&1 &
job_pid=$!
printf '%s\n' "$job_pid" > "$job_dir/test.pid"
```

The test launches only the dedicated headless shell under
`~/.cache/going-up-browsers/`, with an isolated scratch profile. It loads local
ExeFS bytes through DevTools into real OPFS directory handles; the static test
server cannot serve private input/output. Content Security Policy blocks external
connections, and page/worker request observation rejects uploads or HTTP bodies.
The result hashes every actual output
read back from the browser filesystem, comparing all 18 binaries/TSVs with
`game-data/super-mario-odyssey/patched_v0/` and validating the source-provenance
file against the pinned source bundle. That historical provenance file records
an older Odyssey patch source digest, so it is not the provenance oracle.

Rejections cover URL inputs, wrong module sets, missing modules, unsupported
builds, truncated segments, wrong magic, corrupt segment hashes, existing output
preservation and cancellation after real SDK outputs have been written. The
success/cancellation paths use the real Python patcher, Capstone and LZ4 WASM.
`tmp/odyssey/browser-rewriter/green.json` records outputs, progress and network
evidence. Overrides: `REWRITER_EXEFS`, `REWRITER_ORACLE`, `REWRITER_CHROME`.
