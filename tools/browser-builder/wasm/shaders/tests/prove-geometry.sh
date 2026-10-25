#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/../../../.." && pwd)
work_dir="$repo_dir/tmp/odyssey/browser-shaders"
sh "$script_dir/tests/prove.sh"
uv run --no-project "$script_dir/tests/geometry-native.py"
bun "$script_dir/tests/geometry.test.mjs"
