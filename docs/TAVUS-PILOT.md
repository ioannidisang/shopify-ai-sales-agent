# Tavus private Bionera trial

Implementation, provider setup, schema v3 migration and the enabled production backend were verified on 15 October 2026. One real private storefront call displayed Brooke and a checked Greek response to typed input with a live Shopify product card. Local session cleanup and provider-object absence were independently verified; Tavus usage rose from 0 to 0.5 of 20 minutes. Human evaluation of spoken Greek and microphone input remain pending. The public themes remain unchanged.

## Selected design and limits

Use Tavus full CVI for recognition, turn-taking, speech and face rendering, with our server as its custom LLM. Every conversational response passes through the same tenant-approved knowledge, live Shopify reads and claim checks as text chat. Only a fully verified reply is returned to Tavus. Product cards use the checked server response; cart changes retain the existing explicit shopper action.

The initial stock face is Brooke (`rc8992fe8e8e`, Phoenix 4.5). This is a trial selection, not a claim about Greek voice quality. Greek is configured explicitly. Camera and perception are off. Microphone starts off and needs the shopper's action. The widget identifies the person as AI and explains Tavus processing before starting.

The feature requires the enabled pilot shop, a valid app session, a separate private access code and an unpublished theme. Experiments must be disabled. The server permits one active/starting/ending avatar session per shop, three start attempts per UTC day, and 180 seconds per call. These are local safeguards, not a vendor billing cap. Provider absent/left timeouts are 30 seconds. The SDK loads before a room is allocated, and joining must complete before the private-room token expires.

Each session creates its own PAL with a unique callback credential. Credentials are hashed in the database; join material is never put in analytics or logs. The client accepts only the approved Tavus Daily room origin. Verified result payloads are encrypted. Normal end, expiry, backgrounding, configuration revocation and privacy cleanup terminate the room, delete its conversation and delete its session PAL. Cleanup failures retain known IDs for retry. A timed-out creation with no returned ID requires manual provider reconciliation; bounded duration does not remove orphaned provider data.

## Verified evidence

- Latest `pnpm check`: 427 tests across 24 files, typecheck and production build passed for correction commit `30acb4b`. The original sandbox attempt failed with temporary-file `ENOENT`; the approved execution outside the sandbox with a stable temporary directory passed.
- Bionera staged app configuration validation, app build and Theme Check passed with both existing Bionera extension identities preserved.
- Implementation commit `a088047` was pushed. Bionera extension version `bionera-tavus-preview-a088047` / `1168669835265` was released and read back as active. No theme settings/publication changed.
- Correction commit `30acb4b` was released as `bionera-tavus-preview-30acb4b` / `1168709615617` at 16:11:44 UTC. Shopify CLI readback confirmed active, with both extension UIDs unchanged. This is the current extension release recorded in the registration manifest.
- The migrator built source `39bb40a` at 15:48:16 UTC, including a passing `pnpm check` (409 tests / 23 files, typecheck and build). Run `crn-dav1af7pn0mc739l6cf0-1792079337` succeeded at 15:49:25.925 UTC. Render verified the migrator was suspended again at 15:50:53 UTC.
- Web deployment `dep-db8fe6rrjlhs73fqaer0` became Live at 15:56:14 UTC. The five Tavus variables were privately merged into the web service and removed from the suspended migrator, preserving its six migration variables. Changing `TAVUS_ENABLED` to `true` triggered deployment `dep-db8ffmbl550s738vfet0`, verified Live at 15:57:59 UTC. Both deployments used source `39bb40a`.
- At 16:01:45 UTC, the safe deployment check returned HTTP 200 for `/healthz`, `/readyz` and bootstrap. Readiness confirmed the required schema v3/runtime grants. Brand and knowledge version matched the local Bionera configuration; bootstrap advertised the valid Tavus private-preview contract, with experiments off, untracked assignment and `no-store`. This check did not start a provider room or make a model call.
- Actual Tavus key authentication and stock-face reads: HTTP 200. No key was printed or committed.
- Actual `test_mode: true` preflight with this adapter and Brooke: PAL creation 200; private conversation creation 200 with `ended` status and meeting token; end 200; conversation hard-delete 204; PAL delete 204. No known test resources remain.
- Test mode never launches the avatar and does not test the real callback, speech quality, interruption, latency or production cost.
- The merchant confirmed the account's Free plan includes 20 conversational-video minutes, stock faces and 42+ languages. The actual Tavus Billing UI showed Free and CVI minutes **0 / 20** before the live trial, then **0.5 / 20** after the single call (19.5 minutes remaining in the displayed allowance). No paid plan purchase is authorized or was made.

## Current storefront checkpoint

The backend is enabled for the private Bionera pilot. In the actual unpublished theme `200088715651`, an empty Liquid `theme.role` hid the avatar entry point. A read-only inspection of the rendered `Shopify.theme` assignment in the preview DOM verified exactly `id: 200088715651` and `role: unpublished`. Correction `30acb4b` removes the unsupported Liquid attribute and checks the runtime role together with a positive theme ID, failing closed when the metadata is absent or invalid. After its release, the avatar entry point appeared in the actual private preview. The live theme `199350681987` is unchanged.

The read-only database baseline at 16:08:02 UTC showed zero avatar sessions and zero model usage in the checked daily window. One real call started at **16:12:45 UTC**. After joining, a single synthetic typed question about the approved magnesium product produced a checked Greek answer using the approved magnesium/glycine composition and 90-capsule packaging, with a live Shopify card showing **EUR 29.90 / available**. No transcript is recorded here. Screenshot `.data/evidence/tavus-bionera-live-2026-10-15.jpg` shows Brooke. The video element was 640 × 356, with `readyState=4`, `paused=false`, `muted=false` and `currentTime=30.624834`. This verifies browser media rendering/progress, not heard speech or Greek pronunciation quality.

End was clicked at **16:13:25 UTC**. The start button returned and the text conversation remained available. Microphone and camera stayed off throughout. No additional live calls were made. The read-only audit at **16:13:44 UTC** showed one session, one verified reply, zero unresolved sessions and zero active leases; its state was `ended`, the callback credential was revoked and the stored response was cleared. Model usage was four successful requests out of four, 6,231 input / 394 output tokens and zero unknown-usage records.

The independent read-only audit at **16:17:11.033 UTC** reconfirmed local DB cleanup and zero active sessions. Authenticated Tavus lists for conversations and user PALs each returned **HTTP 200**, with one fully inspected page, `total_count: 0`, `inspected: 0`, `complete: true`, `targetPresent: false` and `absent: true`. The provider UI also showed **“No conversations yet”** and **“Create your first PAL”**. Direct GET requests for the deleted objects still returned an unrecognized **400** (`errorClass: other`), so the strict helper's `cleanupVerified` flag remained **false**: it additionally requires a recognized direct-GET absence response. Provider-object absence is established independently by the complete empty authenticated lists and matching UI, not by a passing helper flag.

Commit `30acb4b` is pushed. The existing private preview is prepared with its access code prefilled and no ongoing call. Human evaluation of Greek pronunciation/naturalness and an explicit microphone/STT trial remain pending. Interruptions, mobile behavior and the full 180-second timeout also remain untested.

## Release sequence

The migration, backend deployment, secret configuration and backend activation below have been completed as recorded above. Retain this sequence for future releases; do not repeat the migration or start another deployment merely because these procedural steps remain listed.

1. Use the existing Bionera app and Render resources; do not create a new service, database or app. Keep `TAVUS_ENABLED=false` until the following checks finish.
2. Build the reviewed revision on `shopify-ai-sales-agent-migrator` (`crn-dav1af7pn0mc739l6cf0`). Its command must remain `node dist/apps/server/src/migrate.js`. Run one migration with the existing owner credential and `MIGRATION_EXPECTED_DATABASE=sales_agent_production`, then suspend the migrator again. Schema v3 adds `avatar_sessions` and grants that table to the existing restricted runtime role. Do not rerun role bootstrap.
3. Verify schema version 3 and runtime table grants. Deploy the same revision to `shopify-ai-sales-agent` (`srv-dav36517lnhs73akj8fg`), with automatic deployment still off. Verify `/healthz` and `/readyz`. The old web revision remains usable during the additive migration; deploying the new web revision before migration fails closed.
4. Set secrets privately in Render: `TAVUS_API_KEY`; set `TAVUS_FACE_ID=rc8992fe8e8e`, `TAVUS_PILOT_SHOP=bionera-gr.myshopify.com`, and `TAVUS_PREVIEW_CODE_SHA256` to the SHA-256 hash of a newly generated private code. The code itself is never stored in a public theme or repository. Do not replace unrelated environment variables.
5. Stage with `node scripts/stage-shopify-pilot.mjs bionera`. Validate/build/release only from `.data/bionera-shopify` with the named Bionera config. Its client and extension IDs must match `deploy/bionera/registration.json`, not the root Nutri Tiger app.
6. After confirming Tavus trial minutes, set `TAVUS_ENABLED=true` and deploy the web service. Test only the existing unpublished theme `200088715651`. Keep the live theme `199350681987` unchanged and the A/B/C experiment disabled.

## Real-call acceptance

Use synthetic shopping questions, not personal health data. Start with typed input while hearing/seeing the avatar; then explicitly enable the microphone. Check a greeting, an approved product question, a comparison, an unsupported claim, an unavailable product and a medical question. Confirm that spoken answers match checked captions and authoritative product cards, and that a cart change requires a visible action.

Check Greek pronunciation, product names, response delay, interruptions, stopping playback, microphone mute, reconnect/error fallback, close/background cleanup and the three-minute limit on desktop and mobile. Confirm that the same conversation continues in text after ending video. Inspect only aggregate status/usage and cleanup IDs; do not export shopper transcripts to logs.

Confirm provider minutes used before and after the short test. A test-mode pass and unit tests do not establish these acceptance results. Recording is disabled, but provider transcript retention is not proven to be zero. Review provider processing/retention terms before exposing the avatar to ordinary visitors. `policy: eu` is a disclosure/emotion setting, not a guarantee of EU data residency. Greek Sign Language is not implemented.

## Stop and recovery

Turn `TAVUS_ENABLED=false` and redeploy to remove new starts. Retain `TAVUS_API_KEY` temporarily so cleanup can complete. Existing end requests remain accepted after disabling. Verify there are no active/ending sessions or unexplained provider objects before removing the key. If creation times out with an unknown provider ID, inspect the Tavus account before starting another trial.

Before broader rollout, harden retries for partial provider cleanup. The adapter currently recognizes only 404 as an already-absent resource. The observed Tavus GET 400 responses do not establish DELETE endpoint behavior: if conversation deletion succeeds but PAL deletion fails, a retry could stall if the already-missing conversation then returns 400. Use endpoint-specific, proven absence handling or persist separate cleanup stages; do not treat generic 400 responses as success. This is a future reliability task, not an unresolved cleanup from this trial: the trial ended and complete provider lists showed no remaining objects.

See [API contract](TAVUS-API-NOTES.md) and [progress](PROGRESS.md) for the verified external release state.
