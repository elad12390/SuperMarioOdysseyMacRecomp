#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/../../../.." && pwd)
work_dir="$repo_dir/tmp/odyssey/browser-shaders"
sh "$script_dir/build.sh"
sh "$script_dir/build-spirv-cross.sh"
bun "$script_dir/tests/prepare-fixtures.mjs"
dotnet build "$repo_dir/external/nxnative/dm/gfx/tools/dmsh_xlate/dmsh_xlate.csproj" -c Release --artifacts-path "$work_dir/native" -p:GeneratePackageOnBuild=false
dotnet "$work_dir/native/bin/dmsh_xlate/release/dmsh_xlate.dll" "$work_dir/fixtures/jobs.json" "$work_dir/native-output"
source_dir="$work_dir/SPIRV-Cross"
c++ -O0 -std=c++17 -I "$source_dir" "$script_dir/spirv-cross.cpp" "$script_dir/tests/native-cross.cpp"   "$source_dir/spirv_cross.cpp" "$source_dir/spirv_parser.cpp" "$source_dir/spirv_cross_parsed_ir.cpp"   "$source_dir/spirv_cfg.cpp" "$source_dir/spirv_glsl.cpp" "$source_dir/spirv_msl.cpp" -o "$work_dir/cross/native-spirv-cross"
for shader in "$work_dir/native-output/"*.spv; do
  "$work_dir/cross/native-spirv-cross" "$shader" > "${shader%.spv}.pinned.metal"
done
SHADER_TEST_CROSS=1 bun "$script_dir/tests/browser.test.mjs"
