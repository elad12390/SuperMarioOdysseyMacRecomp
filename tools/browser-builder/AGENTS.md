# Browser release builder

- Product conversion runs in dedicated browser WASM workers. Do not introduce a native helper, an upload endpoint, remote build service, or a browser UI that shells out to this checkout.
- The user approved first-launch compilation of browser-generated Metal source by the installed app. Extraction, ARM64 rewriting, Maxwell translation and MSL generation remain in the browser.
- Publish only reusable open-source runtime/tool assets, their exact source recipes and required notices. Real NSPs, keys, decrypted files, shader fixtures, screenshots containing game data and generated game DMGs stay under ignored `tmp/odyssey/`.
- Use the pristine pinned nxnative source plus the tracked compatibility patches for release builds. The ignored development checkout includes unrelated experimental changes.
- Tests use isolated headless Chrome from `~/.cache/going-up-browsers`, with a separate profile. Do not access the user's browser or existing Player instance.
- Command-line launcher validation, including rejected test-profile paths, must write stderr and exit without `NSAlert` or any desktop window. Negative tests must have bounded process timeouts and terminate only their captured child PID on failure.
- Treat complete cold browser build time as acceptance, targeting a few minutes on the M4 Pro. Report measured time to the ready DMG separately from download/checksum verification. An hour-long prototype baseline is not an acceptable product target. Keep .NET converter builds AOT-compiled and measure the real NSP path before claiming a speedup.
- Overlap independent work only after its input files are flushed and closed. Stop and join background conversion on failure/cancellation. Packed intermediates must retain logical file paths, sizes and SHA-256 values, and sealing must verify those digests before signing.
- Bun test commands must name explicit files or `./` directories. A bare `tests` argument also matches nested converter and native acceptance tests and must not be used for the intake unit suite.
- A site build or a single converted shader does not establish completion. Release validation must run the real browser pipeline, mount its generated DMG, relocate the app, and reach controllable gameplay with audio using an isolated save.
- Keep browser and native shader-chain identities matched. A cache/version mismatch must fail rather than reuse unrelated prepared shaders.
- Browser conversion acceptance must set the browser protocol timeout longer than the scenario timeout; the default three-minute DevTools timeout can terminate a healthy multi-gigabyte build. Keep the command in a captured background job and monitor progress.
- Treat `navigator.storage.estimate()` as advisory. Chromium may report usage plus a fixed 10 GiB for privacy; actual OPFS writes enforce quota. Do not hard-reject a valid larger build from that estimate alone.
- Keep vendored release license texts byte-for-byte identical to their pinned hashes. Formatting hooks exclude only `release/licenses/*.txt`; source files retain the ordinary checks.
