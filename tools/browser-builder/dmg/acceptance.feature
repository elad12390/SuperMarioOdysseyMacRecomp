Feature: Browser-created macOS disk image
  Scenario: Preserve an executable app through the real browser and macOS
    Given a signed original ARM64 fixture app and lazy resource entries
    When the browser worker writes HFSX and UDIF sequentially into OPFS
    Then hdiutil verifies and mounts the downloaded image readonly
    And the relocated app retains executable mode and its valid signature
    And its executable reads its relative resource and exits successfully

  Scenario: Stream a file above the FAT32 limit
    Given a generated resource larger than 4 GiB
    When the browser writes the disk image with bounded chunks
    Then macOS reads the exact size and the beginning and end markers

  Scenario: Reject invalid or incomplete output
    Given invalid metadata or a corrupt image or an interrupted source
    Then validation fails and incomplete OPFS output is removed

  Scenario: Write a real drag-to-Applications symlink
    Given a local app payload and Applications pointing to /Applications
    When the portable TypeScript writer emits the image with bounded chunks
    Then hdiutil verifies and mounts it readonly without opening Finder
    And readlink and lstat identify Applications as a BSD symbolic link
    And fsck validates the catalog and the link target and resource bytes match
    And the data fork contains UTF-8 target bytes and Finder slnk and rhap metadata

  Scenario: Bound and validate symbolic-link input before writing
    Given empty malformed overlong or control-containing targets or invalid modes
    Then preflight rejects before opening a payload or writing output
    And symbolic links cannot be catalog parents or select the custom-volume icon

  Scenario: Preserve streaming lifecycle and legacy image bytes
    Given symlink and regular entries using awaited callbacks and explicit OPFS offsets
    Then each original file or symlink entry completes only after payload padding and close
    And callback failure or cancellation stops before the next source
    And images without symlinks or an icon retain their complete legacy bytes

  Scenario: Select an existing Finder folder without changing default images
    Given openFolder is the root or an existing explicit or implicit directory
    Then both volume headers contain that directory CNID at Finder info field 2
    And readonly device-header inspection independently confirms the selection
    But missing folders files symlinks and invalid paths reject before writing
    And omission retains the existing complete image bytes
