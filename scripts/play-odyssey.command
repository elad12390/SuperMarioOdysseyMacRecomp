#!/bin/bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
build="$root/game-data/super-mario-odyssey"
scratch="$root/tmp/odyssey"
host="$build/tools/dmhost"

slot="Player"
headless=0
while [[ $# -gt 0 ]]; do
case "$1" in
  --help|-h)
    echo "Usage: $0 [--headless] [--slot NAME]"
    echo "Player uses the existing save; named slots use build/run/saves/NAME."
    echo "WASD: move; arrows: camera; J: confirm; K: jump; I: throw cap."
    echo "Return: pause; Space: shake; Command-Q: quit."
    exit 0
    ;;
  --headless)
    headless=1
    ;;
  --slot)
    if [[ $# -lt 2 || ! "$2" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$ ]]; then
      echo "Slot names must be 1-32 letters, digits, underscores or hyphens, starting with a letter or digit." >&2
      exit 2
    fi
    slot="$2"
    shift
    ;;
  *)
    echo "Unknown option: $1 (use --help)" >&2
    exit 2
    ;;
esac
shift
done

case "${GAME_INSTANCE_ROLE:-player}" in
  player|Player) export GAME_INSTANCE_ROLE=player ;;
  tests|Tests) export GAME_INSTANCE_ROLE=tests ;;
  *) echo "GAME_INSTANCE_ROLE must be Player or Tests" >&2; exit 2 ;;
esac
if [[ "$GAME_INSTANCE_ROLE" == tests ]]; then
  [[ "$slot" == Player ]] || { echo "Tests cannot select a player slot" >&2; exit 2; }
  # The bridge supplies fresh private paths; missing test configuration must fail closed.
  : "${DM_SAVE:?Tests require a private DM_SAVE}"
  : "${DM_TEMP:?Tests require a private DM_TEMP}"
  : "${DM_NATIVE_OPTIONS:?Tests require private renderer preferences}"
  : "${DM_RUN_DIRECTORY:?Tests require a private run directory}"
  : "${DM_NATIVE_SOCKET:?Tests require a private native socket}"
  for path in "$DM_SAVE" "$DM_TEMP" "$DM_NATIVE_OPTIONS" "$DM_RUN_DIRECTORY" "$DM_NATIVE_SOCKET"; do
    case "$path" in
      "$scratch/runtime/"*|"$scratch/game-temp"|"$scratch/game-temp/"*|"$scratch/native.sock"|"$scratch/player-"*)
        echo "Tests cannot use Player paths: $path" >&2; exit 2 ;;
      "$scratch/"*) ;;
      *) echo "Test paths must be under $scratch: $path" >&2; exit 2 ;;
    esac
  done
  export DM_AUTOMATED_INPUT=1 DM_INSTANCE_LABEL=Tests
  if [[ -n "${DM_NATIVE_HOST:-}" ]]; then
    case "$DM_NATIVE_HOST" in
      "$scratch/"*) host="$DM_NATIVE_HOST" ;;
      *) echo "Test native hosts must be under $scratch" >&2; exit 2 ;;
    esac
    [[ -f "$host" && -x "$host" ]] || { echo "Test native host is not executable: $host" >&2; exit 2; }
  fi
  run="$DM_RUN_DIRECTORY"
else
  export DM_AUTOMATED_INPUT=0 DM_INSTANCE_LABEL=Player
  run="$build/run"
  if [[ "$slot" == Player ]]; then
    export DM_SAVE="${DM_SAVE:-$build/run/save}"
    export DM_TEMP="${DM_TEMP:-$scratch/game-temp}"
    export DM_NATIVE_OPTIONS="${DM_NATIVE_OPTIONS:-$build/run/native-options.ini}"
    export DM_NATIVE_SOCKET="${DM_NATIVE_SOCKET:-$scratch/native.sock}"
  else
    export DM_SAVE="$build/run/saves/$slot"
    export DM_TEMP="$scratch/player-slots/$slot/game-temp"
    export DM_NATIVE_OPTIONS="$build/run/native-options-$slot.ini"
    export DM_INSTANCE_LABEL="Player / $slot"
    # A short, stable socket name also fits macOS's 104-byte Unix socket limit.
    read -r slot_id _ < <(printf '%s' "$slot" | cksum)
    export DM_NATIVE_SOCKET="$scratch/player-$slot_id.sock"
  fi
fi
if [[ "$headless" == 1 ]]; then
  unset DM_WINDOW
  export DM_AUDIO=0
else
  export DM_WINDOW=1
  export DM_AUDIO="${DM_AUDIO:-1}"
fi

for file in tools/dmhost patched_v0/main.patched.bin patched_v0/subsdk0.patched.bin patched_v0/sdk.patched.bin shader/cache/b-dec5ee141a9f/inputs.tsv; do
  if [[ ! -f "$build/$file" ]]; then
    echo "The native Odyssey build is incomplete: $build/$file" >&2
    echo "See $root/docs/local-odyssey-setup.md" >&2
    exit 1
  fi
done

export DM_ROOT="$build"
export DM_ROMFS="$build/extract/v0/RomFS"
export DM_MSL_DIR="$build/shader/cache"
export DM_FONT_DIR="$build/font"
export DM_NVN_SHMAP="$build/profile/0100000000010000/shader_map.tsv"
export DM_LANG="${DM_LANG:-en-US}"
export DM_ARROW_CAMERA="${DM_ARROW_CAMERA:-1}"

log="${DM_LAUNCH_LOG:-$scratch/play${slot/Player/}.log}"
mkdir -p "$run" "$DM_SAVE" "$DM_TEMP" "$(dirname -- "$log")" "$(dirname -- "$DM_NATIVE_OPTIONS")" "$(dirname -- "$DM_NATIVE_SOCKET")"
echo "Starting native Super Mario Odyssey ($DM_INSTANCE_LABEL). Save: $DM_SAVE. Log: $log"
echo "Native host: $host"
echo "WASD move | arrows camera | J/K confirm/jump | I cap | Return pause | Command-Q quit"
cd "$run"
exec "$host" "$build/patched_v0" >>"$log" 2>&1
