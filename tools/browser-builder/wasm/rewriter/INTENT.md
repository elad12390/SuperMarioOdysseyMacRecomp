# Browser NSO rewriter

Run the pinned nxnative Python rewriter unchanged inside a dedicated Pyodide
worker. Accept only local directory handles and the supported Odyssey v0 ExeFS
modules. Read one module at a time; never accept a URL or NSP buffer as input.

API: `run({inputDirectory, outputDirectory, modules, signal?}, progress)` returns
`{files, modules, provenance}` only after every output has been written and hashed.
Cancellation terminates the worker and removes this run's outputs. Existing
output names are rejected rather than overwritten. Failures never return success.

The release bundle contains pinned Python sources, Capstone ARM64 with detail
support, LZ4, Pyodide and dependency notices. Dependencies and private test output
are generated only under `tmp/odyssey/browser-rewriter/`.

```gherkin
Scenario: Rewrite the supported original ExeFS in a real browser
  Given original main, subsdk0 and sdk files selected with local directory handles
  When run executes the canonical Python rewriter in a WASM worker
  Then every emitted binary and TSV equals the existing patched_v0 file byte for byte
  And a manifest describes the completed files and pinned sources
  And no private input or output is transmitted through HTTP

Scenario: Reject invalid input without a ready result
  Given an unsupported build, truncated NSO, missing module or non-file input
  When run validates the input
  Then it rejects with an actionable error before rewriting

Scenario: Cancel an active rewrite
  When the caller aborts run
  Then the worker terminates and all outputs created by that run are removed
```
