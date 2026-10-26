# Native Finder installer

The generated DMG opens a native Finder icon view with the Odyssey app on the
left, an Applications shortcut on the right and an original drag-to-install
backdrop. It preserves the app and mounted-volume artwork extracted from the
user's local game. No game artwork is bundled in this source or the website.

`createInstallerResource()` renders the background in the browser and wraps its
RGB pixels in a 144-DPI TIFF. Add it under
`Contents/Resources/game/installer/background.tiff` before calling `sealApp`.
`addFinderInstaller()` then adds `/Applications` as an HFSX symlink and creates
the volume's `.DS_Store` outside the signed app. Pass its returned timestamp to
the DMG writer, with `openFolder: ""`. This keeps the background's volume/file
identity consistent with the filesystem that contains it.

The original vector artwork uses system fonts, a light gradient, a restrained
red accent and a centered arrow. Finder supplies the real icons and labels.
Icons occupy 104-point boxes at (190,250) and (570,250). The 777x604-point outer
window reserves a 760x480-point safe artwork area for machines with Finder's
tab, path and status bars enabled. Those global user preferences are preserved.
The background lives inside the app so there is no extra background folder at
the volume root. A user who enables hidden files may see `.VolumeIcon.icns`, as
with other custom-icon volumes; it remains marked invisible.

The small format writers cover only this installer's needs:

- One-page Buddy/DSDB file with `bwsp`, `icvp`, `icvl`, `vSrn` and icon positions.
- Binary property-list dictionaries with strings, numbers, booleans and data.
- Version-2 AliasRecord with actual planned file IDs, creation date, Unicode,
  Carbon and volume-relative POSIX paths.
- Uncompressed RGB TIFF with explicit Retina density.

They are portable TypeScript and use no native packager or browser uploads.
Primary format references are the
[ds_store implementation](https://github.com/dmgbuild/ds_store),
[mac_alias implementation](https://github.com/dmgbuild/mac_alias) and
[dmgbuild's Finder settings](https://github.com/dmgbuild/dmgbuild/blob/main/src/dmgbuild/core.py).
The test-only independent Python readers are pinned to ds-store 1.3.3 and
mac-alias 2.2.3 through uv; they are not product dependencies.

## Verification

Run commands as captured background jobs:

```sh
bun run --cwd tools/browser-builder typecheck
bun run --cwd tools/browser-builder test
# Assemble the complete release before using the native runtime fixture:
bun run --cwd tools/browser-builder build:release --reuse-tools --reuse-runtime
bun tools/browser-builder/installer/test/browser.ts
# Optionally use the actual private game artwork in the fixture:
bun tools/browser-builder/installer/test/browser.ts --icon /private/path/Game.icns
```

The browser fixture uses the real source-built runtime template, seals its new
background, writes OPFS in a dedicated headless browser, downloads the actual
DMG and records a unique run directory under `tmp/odyssey/dmg-layout/browser`.
It cannot launch gameplay because it contains no game data.

`test/native-metadata.m` is a read-only test helper. Compile it with Apple clang
and Cocoa, then pass the mounted TIFF, the run's `background.alias`, and its
expected resolved path. It verifies native image size and real CoreFoundation
alias resolution without UI or automatic mounting. Independent `hdiutil`,
`fsck_hfs`, `readlink`, strict `codesign` and relocation checks cover the image.
Actual Finder-window inspection needs explicit permission under project rules.
No native helper is shipped in the website or generated app for installation.

Full private-input acceptance remains
`tools/browser-builder/tests/firefox-build.mjs`. Its optional `--retain-opfs`
mode hard-links the completed browser-written image from the owned test profile
before closing and removing that profile. It avoids a second 7 GB disk copy on
the test Mac and records `downloaded: false`; it is not browser-download proof.
The normal mode exercises the real download. Both check free disk space before
starting. Neither changes the product's file selection or download behavior.
