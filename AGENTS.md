# Working on AUN

This repository is an early, local personal-context interview prototype. Read `docs/CURRENT_STATE.md` before describing its capabilities and `docs/DESIGN_REQUEST.md` before proposing the broader design.

Preserve the separation between raw statements, model interpretations, user-confirmed context, and action permissions. Never treat a confidence score, model state, silence, or navigation as confirmation. Do not use real personal records or credentials in fixtures, commits, logs or examples.

Keep `.local/`, `vendor/`, native binaries and account state untracked. Do not introduce networked tests or read a developer's existing auth directory as part of ordinary verification. The optional sign-in SDK has its own noncommercial license.

Run `npm test` and `npm run check:public` for relevant changes. Native builds require macOS and Swift; do not claim another platform works without evidence. Question changes should be evaluated for usefulness, scope, burden and non-leading wording, not only JSON validity. Document remaining gaps instead of describing this prototype as production-ready.
