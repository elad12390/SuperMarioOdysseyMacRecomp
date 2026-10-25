# Browser extractor verification

- Keep the private-input browser proof as an explicit CLI script named
  `tests/browser-proof.mjs`, outside `*.test.*` and `*.spec.*` discovery. A root
  `bun test` must never accidentally start real NSP extraction.
- Give every proof invocation its own profile, browser endpoint record and
  evidence file under `tmp/odyssey/browser-extractor/tests/<run-id>/`.
- Identify test browsers by the recorded endpoint or captured PID. Never reuse
  another invocation's live handles or terminate browsers with broad patterns.
- Run actual NIST known-answer checks in WASM before private-input extraction;
  save their verified result alongside the real NSP extraction evidence.

- Generate package locks from signed public NuGet packages with the SDK library-packs feed disabled. Homebrew may bundle different bytes at the same version. Verify a clean locked restore and the full source release build; a cached publish or reuse-only check does not cover this path. The release builder isolates its NuGet cache under ignored scratch.
