# Browser extraction evidence

All conversion tests use a separate puppeteer-core process and the cached
chrome-headless-shell, never Player or the user's Chrome. Private files are
selected as browser Files; the HTTP fixture serves only static public tools.

## RED before implementation

`tmp/odyssey/browser-extractor/jobs/red.log` and `red-evidence.json` record the
real browser failure to import the then-missing callable extractor module.
The acceptance scenarios were written in `tests/extraction.feature` first.

## Real WASM crypto and extraction

- The real base NSP is 5,611,009,601 bytes. The browser validates decrypted title
  `0100000000010000`, control display version `1.0.0`, and main build ID
  `3ca12dfaaf9c82da064d1698df79cda100000000000000000000000000000000`.
- A complete control/ExeFS run wrote six files, 22,768,898 bytes, to OPFS. The
  test reads back `ExeFS/main` and verifies its NSO0 magic and full build ID.
- Truncated input and wrong keys fail with sanitized errors. The suite verifies
  that partial job directories are removed, prior job output is preserved, and
  cancellation after actual decrypted RomFS copying releases handles and removes
  that job's storage.
- The initial platform AES failure was reproduced in the browser. The final
  provider adapts exactly three LibHac AES factories to Bouncy Castle, retaining
  LibHac's NCA parsing, key derivation, AES modes, and integrity checking.
- Actual NIST AES-128/AES-256 ECB and AES-128 CBC encrypt/decrypt checks, using
  explicit-key and parameterless .NET APIs, passed in the active extraction WASM
  instance. Explicit evidence is
  `tmp/odyssey/browser-extractor/tests/published-cached-proof/known-answers.json`.
- The final I/O bridge keeps one 1 MiB read-ahead window. Physical reads never
  exceed 1 MiB; the complete NSP is never loaded in an ArrayBuffer or WASM memory.

The exact final publication bundle passed the complete `EXTRACTOR_FULL=1`
suite with exit 0. It wrote 4,642 files totaling 5,527,856,754 bytes, including
the complete RomFS. All files were read with LibHac's integrity checking enabled.
The returned manifest contains all 4,642 output paths and sizes.

The full run served 338,106 storage reads using 5,950 physical FileReaderSync
reads, each at most 1,048,576 bytes. Total physical input bytes, including
bounded read-ahead and seeks, were 6,237,953,024. The suite observed 210 static
HTTP requests and 910 worker network events, with no network violations.

Compact proof is retained under
`tmp/odyssey/browser-extractor/tests/published-cached-proof/`:

- `evidence.json`: full passing suite, metadata, file manifest and I/O counters.
- `manifest.json` / `proof-hashes.json`: manifest plus SHA-256 of evidence and
  manifest files.
- `known-answers.json`: actual NIST checks from the running WASM instance.
- `output-hashes.json`: SHA-256 of all six actual control/ExeFS output files,
  computed in the browser from completed OPFS files.
- `cleanup.json`: ownership check and deletion record for the completed profile.

The browser closed normally. After verifying no active profile owner, the
5.2 GiB profile and its extracted game binaries were deleted. The inactive
221 MiB legacy profile from old failed runs was also removed after an ownership
check. No input dumps, keys, Player data, or user caches were cleaned.

## Publication and public restore

`jobs/publish-clean.log` and `jobs/publish-cached.log` record successful real
publication builds. `PublishTrimmed=false` preserves LibHac's framework facades;
a clean rebuild was required after switching from trimming. Copy the entire
`tmp/odyssey/browser-extractor/publish/wwwroot` directory into the static site.

`jobs/fresh-public-restore.log` records a locked restore with `--no-http-cache`,
an initially empty `fresh-nuget` directory and empty fallback folders. The public
NuGet flat-container package endpoint for LibHac 0.19.0 returned HTTP OK and its
content hash matched `packages.lock.json`. Publication was subsequently built
using that fresh package directory, rather than this Mac's global LibHac cache.

LibHac 0.19.0 and BouncyCastle.Cryptography 2.6.2 are browser dependencies.
Mono.Cecil 0.11.6 is build-time only and is excluded from the browser bundle.
Dependency notices are copied into the publication output. The separate
repository audit and higher-level pipeline own final publication approval and
complete generated-app acceptance.

## Optional control icon

The focused icon regression first failed against the accepted bundle because
`icon.jpg` was absent from the output manifest (`jobs/icon-red.log`, exit 1).
`Extractor.cs` now selects American English or the first icon in the original
native extractor's supported language order. It adds the optional file to the
existing bounded copy enumerator before ExeFS/RomFS. The byte-copy methods and
RomFS path were not changed.

`jobs/publish-icon.log` records a successful updated publication build.
`tests/icon-green/evidence.json` records the focused published-bundle browser
proof, exit 0: seven control/ExeFS files, 22,861,446 bytes, 1 MiB maximum input
read, crypto known answers true, and no network violations. The 92,548-byte
OPFS `icon.jpg` matches `game-data/super-mario-odyssey/extract/v0/icon.jpg`:

`SHA-256 9e22d954279ea488d11a85937148c71d904e62fb7f8ad6ef56e366d8849c01cc`

The accepted full proof remains unchanged. Adding this verified icon gives an
expected full manifest of 4,643 files and 5,527,949,302 bytes. This is a derived
total, not a repeated full-RomFS test. No private icon bytes are tracked or
included in the public tool bundle.
