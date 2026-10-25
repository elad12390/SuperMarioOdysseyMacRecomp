# Intent: tools/browser-builder/INTENT.md
Feature: Browser-only personal game conversion
  Scenario: Build a playable standalone disk image
    Given the supported base NSP and correct user-supplied keys
    When I start conversion on the GitHub website
    Then extraction and translation run in browser WASM workers
    And the browser downloads a self-contained macOS DMG
    And the relocated app reaches controllable gameplay with native audio
    And no private input was uploaded
  Scenario Outline: Reject an unusable input
    Given <input>
    When I start conversion
    Then the browser reports <reason> without exposing keys
    And no ready DMG is offered
    Examples:
      | input | reason |
      | a different title | unsupported title |
      | an unsupported update | unsupported build |
      | an incomplete NSP | damaged input |
      | incorrect keys | decryption failed |
  Scenario: Cancel conversion
    Given a running browser conversion
    When I cancel
    Then its workers and file handles are released
    And only that job temporary output is removed
