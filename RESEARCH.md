# Sources used by the Odyssey builder

- [nxnative](https://github.com/seedds/nxnative) - Native ARM64 execution and Metal backend. The release pins commit 0045c1dfb639f9775891382646ad38c2a11c56bf and applies the tracked compatibility patches.
- [Original SwitchRecomp project](https://github.com/bgyss/SwitchRecomp) - Project ancestry and original licensing; the generic framework is no longer part of this product.
- [SPIRV-Cross](https://github.com/KhronosGroup/SPIRV-Cross/tree/f11ba9f0b21ba8fc15153d50a2a1ae31ab1cf8f7) - Pinned SPIR-V to Metal translation. Source and license hashes are recorded in tools/browser-builder/wasm/shaders/sources.json.
- [Pyodide](https://github.com/pyodide/pyodide/releases/tag/0.28.3) - Python runtime for the browser ARM64 rewriter and shader rules. Exact wheel hashes accompany the built tools.
- [GitHub Pages artifact action](https://github.com/actions/upload-pages-artifact/blob/v4/action.yml) - Its archive step excludes dotfiles; public manifest entries use ordinary filenames and the archive regression applies the same filter.

The public bundle contains the dependency inventory, licenses and source recipes.
Private game inputs and generated shader fixtures are excluded. Build and gameplay
verification is documented in docs/browser-release.md.
