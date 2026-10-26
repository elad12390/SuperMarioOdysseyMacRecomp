# Finder installer presentation

- Generate the backdrop, TIFF density, AliasRecord and .DS_Store in portable browser code. No native packager, AppleScript or upload service in the product.
- Add the backdrop under Resources/game/installer before resource sealing. Keep the locally extracted Game.icns and volume icon intact. Never publish those game images or visual-test captures.
- Finder bounds describe the outer window. Keep the safe artwork region visible with the user's tab/path/status bars; do not alter global Finder preferences for a screenshot. Hidden-file display may reveal the normally invisible volume icon.
- Build background aliases from the planned HFS file IDs and the exact shared volume timestamp. Verify using macOS's real alias resolver at a different mount location and with a same-name volume already present.
- Test previews use the actual public runtime template, optionally with a private local icon. Do not present a generic executable fixture as proof of the game app's icon.
- Each browser test run owns a unique output/profile folder; a previous same-size DMG must never satisfy a new download check. Close the owned browser and remove its profile.
- Budget disk space before full game tests. Browser output plus a download can require two image-sized copies. The test-only --retain-opfs option may retain the already browser-written file with a same-volume hard link; record this as an OPFS export, never a browser download.
