#!/bin/bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
app="$root/release/Super Mario Odyssey.app"
mkdir -p "$app/Contents/MacOS"
xcrun clang -arch arm64 -O2 -Wall -Wextra -Werror "$root/scripts/macos/odyssey-launcher.c" -o "$app/Contents/MacOS/Launcher"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Launcher</string>
<key>CFBundleIdentifier</key><string>local.switchrecomp.odyssey</string>
<key>CFBundleName</key><string>Super Mario Odyssey</string>
<key>CFBundleDisplayName</key><string>Super Mario Odyssey</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$app"
printf 'Ready to play: %s\n' "$app"
