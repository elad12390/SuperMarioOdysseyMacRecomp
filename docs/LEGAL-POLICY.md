# Legal Use and Asset Separation Policy

This project is a preservation-focused research effort. Its public repository,
website, reusable runtime templates and tool downloads contain no proprietary
game assets, encryption keys, personal saves or game executables.

The browser builder creates a separate, private output on the user's device.
That user-generated DMG may contain their own extracted game data, rewritten
game modules and translated shaders so the app can run without the source
checkout. Those files must never enter the project's public release artifacts.

## Legal Acquisition
- Users must obtain any inputs (binaries, assets, metadata) through lawful means.
- The project does not provide instructions for bypassing protections or extracting data from hardware.
- Inputs must be accompanied by provenance metadata that records their supplied
  source and the supported title/build identity. A tool must not claim to have
  verified ownership from a filename, hash or build identifier.

## Asset Separation
- Public runtime/compiler distributions must not include proprietary payloads.
- Private browser-generated apps keep reusable runtime code in `Contents/MacOS`
  and user-derived payloads in `Contents/Resources/game`.
- Build and packaging artifacts must clearly distinguish reusable source/tools
  from per-user game code, assets, shaders, saves and keys.

## Prohibited Content
- Do not publish or link to encryption-key collections, firmware/game downloads,
  or instructions for bypassing hardware protections. Supported conversion uses
  the user's own lawfully obtained files and keys, supplied locally.
- Do not publish proprietary game binaries, assets or copyrighted media in
  repository, website, template, source-bundle or CI artifacts.
- Links to hosted proprietary assets or piracy resources.

## Provenance Guardrails
- The exploratory Rust pipeline requires its validated `provenance.toml` before
  building and checks inputs against that declared metadata.
- The browser pipeline records local input provenance and verified title/build
  identifiers, retains NCA integrity checks, and rejects unsupported, damaged
  or incorrectly decrypted input before producing a ready DMG.
- The browser must not upload private inputs or include key contents in generated
  provenance, the app, logs or public build artifacts.
- Missing or mismatched required identity/integrity data causes the build to fail.

## Contributor Responsibilities
- Do not attach proprietary payloads or keys to issues, code, documentation or
  public CI jobs. Refer to source/build hashes and compact diagnostic metadata.
- Keep inputs and outputs strictly separated in specs and tooling.
- Prefer primary, public sources when documenting technical research.
