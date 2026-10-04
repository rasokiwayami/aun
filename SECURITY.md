# Security and privacy status

This is a local prototype undergoing design review, not a hardened service for sensitive personal records. Do not put credentials, real transcripts or private files in issues or pull requests. Report a problem with a minimal synthetic reproduction; privately contact a maintainer before disclosing any real exposed data.

## Current boundaries

- HTTP listens on `127.0.0.1`. Host and Origin checks, a browser session cookie and CSRF tokens restrict browser requests. This is not isolation from another process or person controlling the same operating-system account.
- The server checks verified sign-in and plan-sharing permission before inference, record access or microphone capture. The UI receives no access or refresh token.
- Credentials use the Mac Keychain helper; interview records are plaintext JSON with restrictive file/directory modes. There is no encryption-at-rest policy for answers, multi-user authorization model or remote deployment support.
- Raw text is saved before inference. State updates require a known question ID and exact quote from a raw message. These checks prove a reference exists, not that an interpretation is correct.
- Model output never marks a profile or action permission as confirmed. Summaries remain `ai_suggested`.
- Microphone capture starts through a user action. Recognition requests on-device Japanese support. The app pauses recognition while reading a reply. Actual permission and audio behavior need verification on each supported environment.
- The full question design, draft states, older raw user answers and recent dialogue are sent to the selected service. Granular consent, data minimization per task and provider-independent local inference are not implemented.

## Unresolved design work

Priorities include scoped consent and disclosure, user review of transcription and abstractions, deletion and retention across derivatives/backups/exports, correction and revocation propagation, protections against source and prompt injection, recoverable writes under crashes/multiple processes, session expiry, resource limits, dependency updates, privacy-preserving export and measurable context usefulness.

Git ignores and a source scan are publication safeguards, not privacy controls for a running application. Keep all real `.local/` contents out of source control, archives, screenshots and bug reports.
