#!/bin/zsh
set -eu
repo="$(cd "$(dirname "$0")/../../../.." && pwd)"
scratch="$repo/tmp/odyssey/browser-dmg"
app="$scratch/fixture/BrowserFixture.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$scratch/compiler-tmp"
export TMPDIR="$scratch/compiler-tmp/"
export CLANG_MODULE_CACHE_PATH="$scratch/clang-cache"
clang -arch arm64 -Os -Wl,-rpath,@executable_path/../Frameworks "$repo/tools/browser-builder/dmg/test/fixture.c" -o "$app/Contents/MacOS/BrowserFixture"
cat >"$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>BrowserFixture</string>
<key>CFBundleIdentifier</key><string>org.switchrecomp.browserfixture</string>
<key>CFBundleName</key><string>BrowserFixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>
PLIST
print -r -- 'browser-dmg-resource-ok' >"$app/Contents/Resources/message.txt"
codesign --force --sign - "$app"
codesign --verify --deep --strict --verbose=2 "$app"
file "$app/Contents/MacOS/BrowserFixture"
"$app/Contents/MacOS/BrowserFixture"
