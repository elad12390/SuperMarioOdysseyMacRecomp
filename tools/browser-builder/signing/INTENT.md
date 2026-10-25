# Browser ad-hoc resource sealing

Seal new ordinary private resource files into an existing public app template,
entirely in browser TypeScript, WebCrypto and WASM. Preserve all existing resource-envelope
records/rules and the nested host's cdhash requirement. Add SHA-1 and SHA-256
digests for new Resources/game files and a new Resources/Game.icns icon.
Use native WebCrypto SHA-1 and SHA-256 for 256 KiB..64 MiB resources, read once
into a reusable bounded lane buffer. Stream other sizes through pinned MIT
hash-wasm. Use at most four independent resource lanes with private hash states,
1 MiB read chunks and at most 64 MiB retained per lane / 256 MiB total, plus
native digest copies. No whole-game/image buffers. Preserve every hash/size/EOF check, deterministic
envelope bytes, monotonic aggregate progress and reader cleanup before returning
an error or cancellation. This is bounded I/O overlap in one browser worker;
there are no extra workers or cached caller digests. Without WebCrypto, stream
through WASM; unsupported native algorithms reuse retained bytes for fallback.
Drain both native digests before reusing a buffer, propagating abort or returning
failure. Unexpected native errors must reject before updating the seal.
Validate optional expectedSha256 as exactly 64 hexadecimal characters before
hashing. Compare it with the resource's existing SHA-256 result and fail before
envelope generation on mismatch, including same-size corrupt packed bytes.

Update only the resource-directory special slot in the existing thin ARM64
Launcher CodeDirectory. Require ad-hoc SHA-256, validate all code-page/Info/
requirements/resource digests before changing anything. Preserve signed code,
Info, requirements, other special slots and all Mach-O layout/lengths.
Reject CMS/certificates, fat/non-ARM64 binaries, multiple/unknown CodeDirectories,
unexpected blobs/layouts, changed existing resources, malformed XML/paths and
incomplete streams. Never omit resources or bypass native verification.

Acceptance: browser sealApp(entries, options) output is written with the proven
browser DMG writer, mounted readonly, and independently passes macOS codesign
--verify --deep --strict. Adding a private resource before sealing must fail that
same check. Mutating a sealed resource afterwards must fail. No app, Launcher or
host execution, no desktop UI, no certificate signing, no Rust or Player use.
