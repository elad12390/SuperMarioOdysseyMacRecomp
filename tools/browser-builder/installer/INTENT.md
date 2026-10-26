# Native Finder installer

Produce a native drag-to-Applications window in the browser-generated Odyssey DMG.
Everything is generated in the browser; no native packager, game upload or public game asset.

Acceptance:
- Volume contains a signed Odyssey app, an Applications symlink and hidden .DS_Store. The background is a sealed resource inside Resources/game/installer, so it adds no root folder even when hidden files are shown.
- Finder uses a 777x604-point outer window with a 760x480-point safe artwork region, accommodating the observed user-enabled tab/path/status bars. Icons are 104 points centered at (190,250) and (570,250), with labels below. Request hidden sidebar/toolbar/bars in metadata and disable automatic sorting; preserve user global Finder preferences if they override those requests.
- Background shows a readable title, arrow and drag-to-install instructions without drawing fake application icons. It uses original vector shapes and system fonts only.
- The layout background alias resolves to the generated volume's real file ID/date/path, including after a renamed mount directory or a same-name volume collision.
- Normal mounting requests opening the volume root. Read-only verification mounts stay hidden.
- Add the original vector background before sealing. The signed app resources/signatures survive image creation and relocation; preserve all existing game artwork, code and resources.
- Firefox natural-quota full browser build stays within 10 GiB and retains only the final DMG.

Verify with independent DS_Store/mac-alias/plist parsers, real CoreFoundation alias resolution, readonly hdiutil mount/fsck, the actual source-built runtime template and browser output. Visual proof uses the generated background plus an explicitly authorized actual Finder window. A normally hidden .VolumeIcon.icns may be revealed by the user's global hidden-files preference; do not change that preference to conceal this fact.
