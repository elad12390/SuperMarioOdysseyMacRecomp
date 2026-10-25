# Browser ad-hoc resource sealing

Seal new ordinary private resource files into an existing public app template,
entirely in browser TypeScript/WASM. Preserve all existing resource-envelope
records/rules and the nested host's cdhash requirement. Add SHA-1 and SHA-256
digests for new Resources/game files and a new Resources/Game.icns icon.
Stream resource bytes through pinned MIT hash-wasm; never buffer game files.

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
