# Browser shader pipeline

Run the pinned, unchanged nxnative shader splitter and shader build rules serially
inside one Pyodide worker. Native subprocess calls cross a synchronous JS bridge
to the real .NET Maxwell translator and SPIRV-Cross WASM in that same worker.
The user approved native Metal compilation at first launch; output is honest MSL
source and reflection, never a fake metallib or bundled Apple compiler.

API: `run({inputDirectory, outputDirectory, profileDirectory?, signal?}, progress)`.
Input is a local extracted directory with `ExeFS/main` and `RomFS/`; output is an
empty directory dedicated to this job. Return `{files, chain, inputs, ...}` after
all outputs are hashed and written. Abort terminates the worker and cleans only
the reserved output names. No private input is fetched from or sent to HTTP.

Bundle only pinned OSS source, the public constant-only v0 game.tsv, adapter
source, and tool hashes. Generate all map/facts/pairs/guard/extent tables from the
user's files. Preserve the original vertex/pixel ordering, precise math, depth,
padding, shadow/fetch variants and chain/input stamp checks. Source emission
changes storage suffixes, not shader transformations. An adapter fingerprint and
the verified actual WASM bytes form a distinct browser chain.

Verify with real local shaders through headless-shell and real WASM tools,
including original-rule reflection/MSL comparison, table/stamp integrity,
cancellation/cleanup, unsupported-input rejection and no upload requests.

Fetch source cleanup must preserve final _bf.metal while removing AIR intermediates; shadow and geometry source libraries stay present under their runtime basenames. Final mounted-DMG verification reads actual declared files, validates size/SHA256, and compares all current required source names, canonical JSON, table bodies and input stamps using CPU only. A manifest hash alone cannot establish successful OPFS/DMG writes.
