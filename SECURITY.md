# Security and privacy

This is a single-user loopback application, not a remote multi-tenant service. Report problems using synthetic reproductions; never attach credentials, real transcripts, vaults or backups to an issue.

## Assets and threat boundaries

The protected assets are raw answers, interpretations, review decisions, scopes, drafts, derived packs and recovery material. Untrusted inputs include model output, documents, browser requests and imported backups. The application separates source data, proposed knowledge, explicit review and export permission. A model cannot change consent, approve an item, reopen a refusal or execute an external action.

HTTP binds only to `127.0.0.1`, validates Host and Origin, and requires a per-browser HttpOnly SameSite cookie and CSRF token. Unlock leases expire after 30 minutes of private inactivity. The last expired lease or explicit lock zeroes the key buffer and cancels inference/audio. Separate browsers must unlock individually. Restore revokes other browser leases. Cookies are HTTP loopback cookies, not suitable for remote deployment.

The same OS account, malware, browser extensions, debugger, malicious dependencies or compromised Node process are outside this boundary. A hostile local process may access unlocked memory or intercept loopback traffic. Use OS account protection and disk encryption. There is no claim of protection against a compromised host.

## Encryption and persistence

A random 256-bit vault key encrypts the complete JSON state using AES-256-GCM, fresh 96-bit nonces and authenticated format/vault identity. SQLite stores only ciphertext and the key envelope; no plaintext FTS index or journal column exists. A passphrase-derived scrypt key (N=32768, r=8, p=1, 16-byte salt) wraps the vault key. An optional random recovery code creates a separate wrap. Backups have their own random key and passphrase envelope. KDF parameters are fixed rather than accepted from imported data.

The server keeps decrypted data in memory while unlocked. Key buffers are overwritten on lock; JavaScript strings, runtime copies, swap, crash dumps and OS snapshots cannot be reliably zeroed by this application. No transcript or provider credential is logged intentionally. Native SIWC credentials remain in the separate Keychain-backed adapter.

Writes use `BEGIN IMMEDIATE`, revision comparison and `synchronous=FULL`. Retry identities bind payloads. Process-kill tests cover before-commit rollback and after-ACK recovery, not physical power-loss behavior on every filesystem. Record size, source length, operation history, sessions, body size, generation time and authentication attempts are bounded. At the operation-history ceiling new operations stop; recovery mutations remain possible without adding cached results.

## Use, correction and deletion

Only active or matching unexpired task-local assertions are eligible. Purpose, structured conditions, time, provenance revision, AI permission and external disclosure permission are checked. Missing conditions and free-text exceptions fail closed. Hard constraints are not silently dropped by a top-k limit. Raw documents with unknown speakers cannot become the user's knowledge. Explicit user-marked conflicts stop pack generation and inference when both sides apply, before top-k selection. Contradictions in unrelated free text are not automatically detected in full.

Source corrections invalidate dependent knowledge and generated artifacts. Deletion removes managed source text and dependent material, retaining opaque deletion tombstones. A known-lineage restore replays current and incoming tombstones, preserves current corrections, resets imported knowledge for review and revokes model consent. Foreign backups require explicit acknowledgement that prior deletion history is unknown. This does not prove an independently restored old backup contains the latest deletion ledger.

Logical deletion and future-use prevention are guaranteed only within the managed current store. SQLite checkpoint/compaction is best effort; SSD wear levelling, old encrypted pages, Time Machine and independent backups are not forensic-erasure targets. Export receipts distinguish external copies that cannot be recalled. The app does not delete arbitrary filesystem paths or contact recipients.

## Model and voice adapters

Cloud inference requires explicit global consent, current provider identity and permitted sources. Input contains the current source, at most two recent same-purpose/topic sources, eligible knowledge and a small question candidate list. Prior generated questions and assistant histories are not resent as source evidence. Requests are epoch checked before egress and before commit, including after cancellation. A send-attempt receipt is conservative evidence that external copies may exist, not proof of successful delivery.

Exact UTF-16 evidence spans, sentence boundaries and speaker checks prevent several malformed proposals. They do not prove semantic entailment, correct inference, diagnosis or universally valid questions; human review remains necessary. Prompt injection is handled as untrusted data with no tool/authority capabilities, but language quality and interpretation errors remain possible.

Mac recognition requests on-device Japanese support and stores no audio recording. Partial recognition remains a draft; final recognition does not equal confirmed knowledge. Physical microphone, interruptions, permissions and full speech round trips require real-device verification.

The optional DevKit has separate noncommercial terms. Core operation does not import it when unavailable. See [licenses](LICENSES/README.md). Repository ignores and source scans protect packaging; they do not protect a running unlocked application.
