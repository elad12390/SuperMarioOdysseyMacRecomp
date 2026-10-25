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
- A regular root `.VolumeIcon.icns` automatically sets the root folder's
  `kHasCustomIcon` and the icon file's `kIsInvisible` Finder flags. A real readonly
  mount exposes both flags and preserves the supplied ICNS bytes. Without this
  file, the existing writer's complete fixed-timestamp output stays identical.

Only regular files and directories are supported. Symlinks, hard links,
resource forks, general xattrs and Finder layout customization are outside this
API. The volume icon does not set host-file custom-icon xattrs on a downloaded DMG.
Callers must flatten framework symlinks before packaging. The caller supplies
already compiled, signed, relocatable app bytes; image creation does not compile
or sign the game. Native fixture compilation is test-only.
