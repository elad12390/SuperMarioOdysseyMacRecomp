Feature: Fast local browser conversion
  Scenario: Scratch storage coalesces Python file operations
    Given real Pyodide and an owned OPFS scratch store
    When Python writes and rereads multi-megabyte files in small chunks
    Then the bytes including sparse holes and reused blocks are exact
    And physical storage calls are coalesced within a bounded memory cache

  Scenario: Optimized graphics retains the original game output
    Given the user's original Odyssey base game
    When independent shaders are converted locally in bounded workers
    Then all source, reflection and generated tables match the original rules
    And paired vertex shaders consume their completed pixel shader sources
    And no private game data is uploaded

  Scenario: Complete browser build meets the time target
    Given the original local NSP and keys on this M4 Pro
    When the real website builds and downloads the disk image
    Then all six stages and a relocated native gameplay check pass
    And the measured time until the DMG is ready is reported against a 3 minute target
