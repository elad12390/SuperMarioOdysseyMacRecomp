Feature: Browser WASM extraction of the supported Odyssey base NSP
  All package parsing, key derivation, decryption and integrity checking run in
  .NET WASM inside a dedicated worker. Input and output stay on this device.

  Scenario: Preserve the user's optional control icon
    Given the supported base NSP contains an American English control icon
    When the browser worker extracts control metadata and ExeFS
    Then the output manifest includes icon.jpg
    And the OPFS icon matches the existing native extraction byte for byte
    And the same bounded copy path is used before RomFS

  Scenario: Parse and decrypt the user's base NSP with bounded reads
    Given the user's selected base NSP and prod.keys Files
    When a dedicated worker opens the package with LibHac 0.19.0 in WASM
    Then it validates the decrypted Odyssey title ID and supported main build ID
    And it extracts ExeFS to OPFS with a maximum 1 MiB input slice
    And the main file starts with NSO0 and has the supported build ID
    And no game bytes or keys are sent over the network

  Scenario: Reject damaged or wrong-key input
    When the worker opens truncated input or an NSP with incorrect keys
    Then it reports an actionable sanitized error
    And it removes the job's OPFS outputs

  Scenario: Cancel a running extraction
    Given a worker copying decrypted RomFS data to OPFS
    When the caller cancels the job
    Then the worker is terminated and synchronous handles are released
    And the job's OPFS directory is removed
