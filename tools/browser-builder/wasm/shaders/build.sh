#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/../../../.." && pwd)
work_dir="$repo_dir/tmp/odyssey/browser-shaders"
mkdir -p "$work_dir"
bun "$script_dir/verify-sources.mjs"
# MAIN installs the SDK/workload. This script intentionally never installs them.
dotnet publish "$script_dir/ShaderTranslator.csproj" -c Release --artifacts-path "$work_dir/dotnet" -o "$work_dir/publish" -p:GeneratePackageOnBuild=false
cp "$script_dir/shader-translator.mjs" "$work_dir/publish/wwwroot/shader-translator.mjs"
cp "$script_dir/shader-worker.mjs" "$work_dir/publish/wwwroot/shader-worker.mjs"
cp "$repo_dir/external/nxnative/LICENSE" "$work_dir/publish/wwwroot/nxnative.LICENSE"
cp "$repo_dir/external/nxnative/dm/third_party/ryujinx/LICENSE.txt" "$work_dir/publish/wwwroot/Ryujinx.LICENSE.txt"
bun "$script_dir/verify-publish.mjs" "$work_dir/publish/wwwroot"
