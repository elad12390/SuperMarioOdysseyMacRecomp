#!/bin/zsh
# Verification only: never creates, converts, or repairs an image.
set -eu
repo="$(cd "$(dirname "$0")/../../../.." && pwd)"
scratch="$repo/tmp/odyssey/browser-dmg"
variant="${1:-small}"
[[ "$variant" == small || "$variant" == large ]] || exit 2
image="$scratch/downloads/browser-$variant.dmg"
mount="$scratch/mount-$variant"
relocated="$scratch/relocated-$variant"
mkdir -p "$mount" "$relocated"
hdiutil verify -verbose "$image"
hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mount" -plist "$image" >"$scratch/attach-$variant.plist"
trap 'hdiutil detach "$mount"' EXIT
diskutil info "$mount"
diskutil verifyVolume "$mount"
stat -f '%Sp %z %N' "$mount/BrowserFixture.app/Contents/MacOS/BrowserFixture" "$mount/empty-directory"
[[ "$(stat -f '%Lp' "$mount/BrowserFixture.app/Contents/MacOS/BrowserFixture")" == 755 ]]
[[ "$(stat -f '%Lp' "$mount/empty-directory")" == 750 ]]
ditto "$mount/BrowserFixture.app" "$relocated/BrowserFixture.app"
codesign --verify --deep --strict --verbose=2 "$relocated/BrowserFixture.app"
otool -L "$relocated/BrowserFixture.app/Contents/MacOS/BrowserFixture"
"$relocated/BrowserFixture.app/Contents/MacOS/BrowserFixture"
cmp "$scratch/fixture/BrowserFixture.app/Contents/MacOS/BrowserFixture" "$relocated/BrowserFixture.app/Contents/MacOS/BrowserFixture"
cmp "$scratch/fixture/BrowserFixture.app/Contents/Resources/message.txt" "$relocated/BrowserFixture.app/Contents/Resources/message.txt"
mountedFiles="$(find "$mount/catalog" -type f | wc -l | tr -d ' ')"
[[ "$mountedFiles" == 1600 ]]
[[ "$(cat "$mount/catalog/f01599")" == record-1599 ]]
[[ "$(cat "$mount/unicode/Café")" == unicode-ok ]]
[[ "$(cat "$mount/unicode/Å")" == unicode-ok ]]
[[ "$(cat "$mount/unicode/日本語")" == unicode-ok ]]
[[ "$(cat "$mount/unicode/한글")" == unicode-ok ]]
[[ "$(cat "$mount/unicode/🚀")" == unicode-ok ]]
if [[ "$variant" == large ]]; then
  [[ "$(stat -f '%z' "$mount/large-resource.bin")" == 4294967333 ]]
  [[ "$(head -c 17 "$mount/large-resource.bin")" == 'BROWSER-DMG-HEAD!' ]]
  [[ "$(tail -c 17 "$mount/large-resource.bin")" == 'BROWSER-DMG-END!!' ]]
  print -r -- 'Verified >4GiB file: 4294967333 bytes, both markers match'
fi
print -r -- "MACOS_ACCEPTANCE_OK variant=$variant catalogFiles=$mountedFiles"
