#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/../../../.." && pwd)
work_dir="$repo_dir/tmp/odyssey/browser-shaders"
mkdir -p "$work_dir"
publish_dir=$(bun -e 'const p = require("node:path"); const root = p.resolve(process.argv[1]); const out = p.resolve(process.env.SHADER_PUBLISH_DIR || p.join(root, "publish")); if (!out.startsWith(root + p.sep)) throw new Error("Shader publish must stay under tmp/odyssey/browser-shaders"); console.log(out);' "$work_dir")
lock_dir="$work_dir/maxwell-build.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "Another Maxwell build owns $lock_dir; inspect its pid before building." >&2
  exit 1
fi
printf '%s\n' "$$" > "$lock_dir/pid"
trap 'rm -f "$lock_dir/pid"; rmdir "$lock_dir"' EXIT
export DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE=true DOTNET_CLI_TELEMETRY_OPTOUT=1
bun "$script_dir/verify-sources.mjs"
# MAIN installs the SDK/workload. This script intentionally never installs them.
# Opt into cache-only restore for local work without changing clean CI restores.
if [ "${SHADER_OFFLINE:-0}" = 1 ]; then
  mkdir -p "$work_dir/offline-packages"
  dotnet restore "$script_dir/ShaderTranslator.csproj" --artifacts-path "$work_dir/dotnet" --source "$work_dir/offline-packages" -p:NuGetAudit=false -p:GeneratePackageOnBuild=false
else
  dotnet restore "$script_dir/ShaderTranslator.csproj" --artifacts-path "$work_dir/dotnet" -p:GeneratePackageOnBuild=false
fi
dotnet publish "$script_dir/ShaderTranslator.csproj" -c Release --no-restore --artifacts-path "$work_dir/dotnet" -o "$publish_dir" -p:GeneratePackageOnBuild=false
cp "$script_dir/shader-translator.mjs" "$publish_dir/wwwroot/shader-translator.mjs"
cp "$script_dir/shader-worker.mjs" "$publish_dir/wwwroot/shader-worker.mjs"
cp "$repo_dir/external/nxnative/LICENSE" "$publish_dir/wwwroot/nxnative.LICENSE"
cp "$repo_dir/external/nxnative/dm/third_party/ryujinx/LICENSE.txt" "$publish_dir/wwwroot/Ryujinx.LICENSE.txt"
bun "$script_dir/verify-publish.mjs" "$publish_dir/wwwroot"
