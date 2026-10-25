#!/bin/bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# This named playthrough persists independently of the original Player save.
export GAME_INSTANCE_ROLE=player DM_AUDIO=1
exec "$root/scripts/play-odyssey.command" --slot FreshStart "$@"
