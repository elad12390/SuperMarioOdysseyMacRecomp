Feature: Native Finder installer layout
  Scenario: Open the browser-generated Odyssey disk image
    Given the browser has produced a signed Odyssey app from local inputs
    When it writes the disk image
    Then the volume contains the app and an Applications shortcut
    And Finder uses a fixed icon view with the app on the left and Applications on the right
    And the background includes a visible drag-to-install arrow and instructions
    And the volume opens its installer window when mounted normally
    And the background is sealed inside the app rather than appearing as a root folder
    And metadata files are hidden under the normal Finder hidden-file policy
    And user-enabled Finder bars do not clip the title, icons or instructions
    And the app remains byte-identical and its signature validates after relocation

  Scenario: Keep conversion local and within Firefox storage
    Given a normal nonpersistent Firefox profile with its natural storage quota
    When the complete local game conversion creates the styled disk image
    Then the image is mountable with valid checksums
    And only the final image remains in the browser job
    And no selected input files or Player saves are changed
