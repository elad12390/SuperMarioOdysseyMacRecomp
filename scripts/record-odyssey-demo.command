#!/bin/bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root/tools/game-harness"
if [[ ! -d node_modules/playwright-core ]]; then bun install --frozen-lockfile; fi
exec bun run demo "$@"
