# Browser disk image writer

Produce a real mountable macOS disk image from local browser files. The product
writer is portable TypeScript: no native helper, process, server, or Node API.
HFSX (case-sensitive HFS+) retains POSIX modes and supports forks larger than
4 GiB. An uncompressed UDIF container supplies block and image CRC32 checksums.

Input entries have a relative path, byte size, POSIX mode, and lazy open/read
source. A preflight plan resolves directories, contiguous extents and B-trees
before opening payloads. Payload and padding are emitted sequentially through a
bounded reusable chunk to an awaited sink, including OPFS. Memory scales with
file metadata and the allocation bitmap, not total payload bytes.

Acceptance:
- The same module runs in an isolated headless-shell browser worker and Bun.
- Browser OPFS output passes hdiutil verify and readonly attach on macOS.
- A signed genuine ARM64 fixture survives mount, copy to another directory,
  signature verification and execution with mode 0755; resource bytes match.
- A real browser run streams more than 4 GiB, including a single file larger
  than 4 GiB, without constructing a whole-file buffer.
- Invalid paths, duplicate normalized names, unsupported modes, unsafe sizes,
  short/long sources, cancellation and failed sink writes reject. OPFS failure
  removes incomplete job output; no download is reported as ready.
- Corrupt payload and corrupt container metadata are rejected by validation.
- Await `onFileWritten` once per file only after payload/padding and reader close,
  so private job inputs can be removed without changing image bytes or CRCs.
  Callback failure or cancellation stops output and removes incomplete OPFS files.
- OPFS writes retain explicit safe-integer offsets and retry positive partial
  writes; zero/invalid counts fail with the byte position and pending length.
- A regular root `.VolumeIcon.icns` automatically sets the root folder's
  `kHasCustomIcon` and the icon file's `kIsInvisible` Finder flags. A real readonly
  mount exposes both flags and preserves the supplied ICNS bytes. Without this
  file, the existing writer's complete fixed-timestamp output stays identical.

Bounded symbolic links are supported through `entryFromSymlink(path, target)`.
The helper returns a `DmgEntry` with type `symlink`, UTF-8 byte size, target,
mode 0777 and no external reader. Preflight validates even manually built entries:
targets must be nonempty well-formed Unicode, at most 1023 UTF-8 bytes (the macOS
MAXPATHLEN limit excluding its terminator), with no NUL, control or backslash.
Targets may be absolute or relative, including dot segments; their bytes are
preserved without HFS name normalization, resolution, dereferencing or a NUL
terminator. Size must match the target and external readers are not accepted.
Normal rwx permissions and matching optional BSD type bits are allowed; setuid,
setgid, sticky and mismatched file types reject before any sink write.

A link uses an HFS catalog file record with BSD S_IFLNK (0120000), Finder type
`slnk`, creator `rhap`, and the target bytes in its ordinary data fork. It counts
as a file, cannot be a parent directory, and cannot opt into volume-icon flags.
Its bounded internal reader follows the existing awaited write/padding/close,
cancellation and exactly-once `onFileWritten` contract, passing the original
entry. OPFS retains explicit offsets and incomplete-output cleanup. Existing
fixed-timestamp output without links or an icon remains byte-identical.

Acceptance examples:

- Root `Applications` -> `/Applications` mounts as a real BSD symlink; readlink
  returns the exact target, lstat reports a symlink, and fsck_hfs is clean.
- Relative `Fixture.app/Link` -> `../Caf\u00e9` retains its exact UTF-8 target;
  dangling links are valid and never traversed while packaging.
- Invalid targets, inconsistent size/readers, conflicting parent paths and
  unsafe/mismatched modes fail preflight. Callback rejection and cancellation
  stop before the next entry. Link payload bytes and UDIF CRCs independently
  validate. Native acceptance uses readonly hdiutil mounts without Finder UI,
  a native game launch, or native conversion.

Hard links, resource forks, general xattrs and Finder layout customization are
outside this API. The volume icon does not set host-file custom-icon xattrs on
a downloaded DMG. Callers may supply explicit bounded links when packaging
frameworks. The caller supplies
already compiled, signed, relocatable app bytes; image creation does not compile
or sign the game. Native fixture compilation is test-only.

Finder opening intent:

- `DmgOptions.openFolder?: string` selects an existing planned directory by its
  relative HFS path; the empty string selects the volume root. Selection happens
  after all entries and implicit directories exist. Invalid/missing paths and
  regular files or symlinks reject in preflight. The option never creates a folder.
- The selected folder CNID is stored big-endian in volume Finder info field 2
  at header byte 88, in both matching primary and alternate headers. Omission
  leaves existing bytes unchanged. `planDmg.items` continues exposing directory
  CNIDs, and `planDmg.time` remains the caller's shared HFS creation timestamp.
- Independent readonly device-header inspection verifies field 2 equals the
  intended CNID; no Finder UI is launched for this acceptance.
