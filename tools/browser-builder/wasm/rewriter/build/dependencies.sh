#!/usr/bin/env bash
# Invoke from any directory. All generated dependencies/caches stay in tmp.
set -euo pipefail
REWRITER_ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
REWRITER_SCRATCH="$REWRITER_ROOT/tmp/odyssey/browser-rewriter"
REWRITER_VENV="$REWRITER_SCRATCH/python-env/venv"
REWRITER_SDK="$REWRITER_SCRATCH/toolchain/emsdk"
REWRITER_CAPSTONE="$REWRITER_SCRATCH/toolchain/capstone-5.0.6"
export TMPDIR="$REWRITER_SCRATCH/toolchain/temporary"
export UV_CACHE_DIR="$REWRITER_SCRATCH/uv-cache"
export BUN_INSTALL_CACHE_DIR="$REWRITER_SCRATCH/bun-cache"
export EM_CACHE="$REWRITER_SCRATCH/toolchain/em-cache"
export SOURCE_DATE_EPOCH=1754006400
mkdir -p "$TMPDIR" "$REWRITER_SCRATCH/setup" "$REWRITER_SCRATCH/build-logs"
cd "$REWRITER_ROOT"

# Each command is a background job with its PID, captured output and exit code.
job() {
    local label="$1"; shift
    "$@" > "$REWRITER_SCRATCH/build-logs/$label.log" 2>&1 &
    local child=$!
    printf '%s\n' "$child" > "$REWRITER_SCRATCH/build-logs/$label.pid"
    printf '%s PID %s\n' "$label" "$child"
    local result=0
    wait "$child" || result=$?
    printf '%s\n' "$result" > "$REWRITER_SCRATCH/build-logs/$label.status"
    if [ "$result" -ne 0 ]; then cat "$REWRITER_SCRATCH/build-logs/$label.log"; return "$result"; fi
}

job bun bun add --cwd "$REWRITER_SCRATCH/setup" --exact pyodide@0.28.3 puppeteer-core@24.15.0
if [ ! -x "$REWRITER_VENV/bin/python" ]; then job venv uv venv "$REWRITER_VENV" --python 3.13; fi
job python-deps uv pip install --python "$REWRITER_VENV/bin/python" pip==26.2.2 setuptools==80.9.0 wheel==0.48.0
job capstone-source uv run --no-project --python "$REWRITER_VENV/bin/python" pip download --no-deps --no-binary=:all: --no-build-isolation capstone==5.0.6 -d "$REWRITER_SCRATCH/toolchain"
printf '%s  %s\n' b11a87d67751b006b9b44428d59c99512e6d6c89cf7dff8cdd92d9065628b5a0 "$REWRITER_SCRATCH/toolchain/capstone-5.0.6.tar.gz" | shasum -a 256 -c -
job unpack tar -xzf "$REWRITER_SCRATCH/toolchain/capstone-5.0.6.tar.gz" -C "$REWRITER_SCRATCH/toolchain"
if [ ! -d "$REWRITER_SDK/.git" ]; then
    job emsdk-source git clone --depth 1 --branch 4.0.9 https://github.com/emscripten-core/emsdk.git "$REWRITER_SDK"
fi
test "$(git -C "$REWRITER_SDK" rev-parse HEAD)" = 3bcf1dcd01f040f370e10fe673a092d9ed79ebb5
job emsdk-install uv run --no-project --python "$REWRITER_VENV/bin/python" "$REWRITER_SDK/emsdk.py" install 4.0.9
job emsdk-activate uv run --no-project --python "$REWRITER_VENV/bin/python" "$REWRITER_SDK/emsdk.py" activate 4.0.9
set +u
source "$REWRITER_SDK/emsdk_env.sh"
set -u
export EM_CACHE="$REWRITER_SCRATCH/toolchain/em-cache"
job prepare bun "$REWRITER_ROOT/tools/browser-builder/wasm/rewriter/build/prepare.mjs"

cd "$REWRITER_CAPSTONE/src"
job capstone-clean make clean CAPSTONE_ARCHS=aarch64 CAPSTONE_BUILD_CORE_ONLY=yes
job capstone make -j4 CAPSTONE_ARCHS=aarch64 CAPSTONE_BUILD_CORE_ONLY=yes CAPSTONE_SHARED=yes CAPSTONE_STATIC=no CAPSTONE_DIET=no CC=emcc AR=emar RANLIB=emranlib HOST_OS=Linux \
    CFLAGS='-O2 -fPIC -Iinclude -DCAPSTONE_HAS_ARM64 -DCAPSTONE_USE_SYS_DYN_MEM' \
    LDFLAGS='-sSIDE_MODULE=1 -sWASM_BIGINT' capstone_LDFLAGS=-shared
mkdir -p "$REWRITER_CAPSTONE/capstone/lib"
cp libcapstone.so.5 "$REWRITER_CAPSTONE/capstone/lib/libcapstone.so"
cd "$REWRITER_CAPSTONE"
# Official setuptools build packages the upstream binding and our WASM library.
export LIBCAPSTONE_PATH=capstone/lib
job capstone-wheel uv run --no-project --python "$REWRITER_VENV/bin/python" setup.py bdist_wheel --plat-name pyodide_2025_0_wasm32 --dist-dir "$REWRITER_SCRATCH/bundle"
cd "$REWRITER_ROOT"
job lz4 bun "$REWRITER_ROOT/tools/browser-builder/wasm/rewriter/build/lz4.mjs"
job finalize bun "$REWRITER_ROOT/tools/browser-builder/wasm/rewriter/build/finalize.mjs"
printf 'Bundle: %s/bundle\n' "$REWRITER_SCRATCH"
