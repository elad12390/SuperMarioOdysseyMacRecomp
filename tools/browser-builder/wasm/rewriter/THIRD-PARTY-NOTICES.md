# Dependency notices

The static bundle contains only open-source tooling. Game inputs, rewritten
game images and personal data are excluded. Preserve these notices and the
upstream licenses when incorporating the bundle in a release.

| Component | License / upstream source | Bundle location |
| --- | --- | --- |
| nxnative pinned Python sources | MIT; [upstream](https://github.com/seedds/nxnative) and canonical checkout LICENSE | `sources.json`, `NXNATIVE-LICENSE` |
| Pyodide 0.28.3 | MPL-2.0; [source and license](https://github.com/pyodide/pyodide/tree/0.28.3) | `pyodide/` |
| CPython 3.13 | PSF license; [license](https://docs.python.org/3.13/license.html) | Pyodide runtime and standard library |
| Capstone 5.0.6 | BSD; [source and license](https://github.com/capstone-engine/capstone/tree/5.0.6) | Wheel includes `capstone-5.0.6.dist-info/licenses/LICENSE.TXT` |
| python-lz4 4.4.4 and LZ4 | BSD; [source and licenses](https://github.com/python-lz4/python-lz4/tree/v4.4.4) | WASM wheel license metadata |

Emscripten/LLVM, emsdk, Bun, uv, setuptools, wheel and pip are build tools, and
puppeteer-core is test tooling. Their installed packages are not copied to the
static bundle (only Pyodide's package directory is copied from node_modules).
The Capstone WASM library is built from the exact official source archive with
no source changes. The canonical rewriter is unchanged after applying the
separately pinned, existing project patch. No source-code network service or
native executable is needed at conversion time.
