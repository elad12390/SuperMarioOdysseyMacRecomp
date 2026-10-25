# Browser shader pipeline scope

- Whole-library tests must mount the original local File objects or reuse the
  extractor's existing OPFS directory. Never copy a full multi-gigabyte RomFS
  corpus into another browser test origin or profile.
- A new localhost port is a new storage origin. Keep proof profiles disposable,
  capture their ownership, close only the owned headless browser, and remove its
  profile after the proof. Preserve result manifests and the small current shader
  fixture, not duplicate game data.
- Keep external/nxnative read-only. Public bundles contain pinned source, public
  profile constants and tool assets only; generated shader tables stay private.
