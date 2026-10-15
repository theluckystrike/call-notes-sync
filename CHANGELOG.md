# call-notes-sync

## 1.1.3

### Patch Changes

- 928a3e2: Use a fixed clock and UTC in the app tests. Check the 48 hour sync window from the Fathom created time and test a meeting that is not ready yet.

## 1.1.2

### Patch Changes

- 85e6f8b: Treat a GitHub sponsorship reply without an amount as a failed check, not a refusal, and stop the GitHub sign in when the settings close or the plugin unloads.

## 1.1.1

### Patch Changes

- 46a768e: A sync that stops at the page limit now continues from the Fathom created time, so a meeting at the page edge is not skipped, and the README states the retry and forget rules correctly.

## 1.1.0

### Minor Changes

- a6c393e: Add Pro tags and extra note properties, with wiki links to the attendees, in the front matter of each new note.

## 1.0.2

### Patch Changes

- efdff8f: Correct the GitHub Sponsors payment, check and token storage text in the README.

## 1.0.1

### Patch Changes

- 2e4396c: Make the Fathom-only source test work in the standalone repository.
