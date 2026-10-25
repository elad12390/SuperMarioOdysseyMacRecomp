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
