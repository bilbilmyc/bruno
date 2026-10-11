# Chinese patch maintenance context

This fork's `zh-cn` default branch maintains an offline, reversible patch for official Bruno releases. Upstream application source is retained at the supported release tag. `main` remains the upstream tracking branch. Upstream workflows are preserved under `.github/upstream-workflows/`; only the Chinese patch workflow runs in this fork.

Runtime boundaries: archive.mjs reads/rebuilds ASAR without unpacking native modules; operations.mjs owns Windows backup and restore; mac.mjs stages and signs a full Mac app and preserves the original signature in a complete bundle backup; cli.mjs checks processes, version and platform. plans.json pins original archive and per-file hashes. Only reviewed static UI literals are changed, never user data, payloads, authentication semantics or license logic.

Update flow: examine upstream changes, update upstream-lock.json and supported version, download official Windows x64 / Mac arm64 ZIPs and verify GitHub SHA256 digests, regenerate plans, translate new UI strings, inspect changes, run tests and Windows/Mac Electron smoke tests, compile native patchers, then create a release. A new upstream release does not authorize blindly relaxing hash checks. Installation on a user's computer is separate from publishing a tested patch.

Validation map: test.mjs covers archive correctness and transactional safety; ci/smoke.cjs compares original and patched UI/request behavior; ci/verify.mjs exercises native apply, ad-hoc signing, repeated apply and complete restore on the actual target OS. macOS runners must report arm64. CI cannot certify Gatekeeper handling of downloaded/notarized files; communicate that separately.

No local profiles, credentials, installation backups, raw app logs or machine-specific paths may be committed. Artifacts contain only the compiled tool, public source, documentation and checksums.
