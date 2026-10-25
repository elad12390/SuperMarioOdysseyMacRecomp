#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/../../../.." && pwd)
work_dir="$repo_dir/tmp/odyssey/browser-shaders"
source_dir="$work_dir/SPIRV-Cross"
revision=f11ba9f0b21ba8fc15153d50a2a1ae31ab1cf8f7
if [ ! -d "$source_dir/.git" ]; then
  git clone --depth 1 --branch vulkan-sdk-1.4.363.0 https://github.com/KhronosGroup/SPIRV-Cross.git "$source_dir"
fi
[ "$(git -C "$source_dir" rev-parse HEAD)" = "$revision" ] || { echo "SPIRV-Cross source revision mismatch" >&2; exit 1; }
bun "$script_dir/verify-cross-sources.mjs" "$source_dir"
em++ --version | head -n 1 | grep -E ' 6[.]0[.]13(-git)?$' >/dev/null || { echo "Emscripten 6.0.13 is required" >&2; exit 1; }
mkdir -p "$work_dir/cross"
em++ -O2 -std=c++17 -fexceptions -I "$source_dir"   "$script_dir/spirv-cross.cpp"   "$source_dir/spirv_cross.cpp" "$source_dir/spirv_parser.cpp"   "$source_dir/spirv_cross_parsed_ir.cpp" "$source_dir/spirv_cfg.cpp"   "$source_dir/spirv_glsl.cpp" "$source_dir/spirv_msl.cpp"   -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker   -sALLOW_MEMORY_GROWTH=1 -sDISABLE_EXCEPTION_CATCHING=0   '-sEXPORTED_FUNCTIONS=["_malloc","_free","_shader_cross","_shader_cross_glsl","_shader_cross_error"]'   '-sEXPORTED_RUNTIME_METHODS=["UTF8ToString","HEAPU8"]'   -o "$work_dir/cross/spirv-cross.mjs"
cp "$script_dir/msl-translator.mjs" "$work_dir/cross/translator.mjs"
bun "$script_dir/verify-cross-sources.mjs" "$source_dir" "$work_dir/cross/SPIRV-Cross.LICENSE"
