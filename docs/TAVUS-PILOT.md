# Tavus private Bionera trial

Implementation and provider setup verified on 15 October 2026. Real Greek speech, storefront media and the production callback remain untested. The public themes remain unchanged.

## Selected design and limits

Use Tavus full CVI for recognition, turn-taking, speech and face rendering, with our server as its custom LLM. Every conversational response passes through the same tenant-approved knowledge, live Shopify reads and claim checks as text chat. Only a fully verified reply is returned to Tavus. Product cards use the checked server response; cart changes retain the existing explicit shopper action.

The initial stock face is Brooke (`rc8992fe8e8e`, Phoenix 4.5). This is a trial selection, not a claim about Greek voice quality. Greek is configured explicitly. Camera and perception are off. Microphone starts off and needs the shopper's action. The widget identifies the person as AI and explains Tavus processing before starting.

The feature requires the enabled pilot shop, a valid app session, a separate private access code and an unpublished theme. Experiments must be disabled. The server permits one active/starting/ending avatar session per shop, three start attempts per UTC day, and 180 seconds per call. These are local safeguards, not a vendor billing cap. Provider absent/left timeouts are 30 seconds. The SDK loads before a room is allocated, and joining must complete before the private-room token expires.

Each session creates its own PAL with a unique callback credential. Credentials are hashed in the database; join material is never put in analytics or logs. The client accepts only the approved Tavus Daily room origin. Verified result payloads are encrypted. Normal end, expiry, backgrounding, configuration revocation and privacy cleanup terminate the room, delete its conversation and delete its session PAL. Cleanup failures retain known IDs for retry. A timed-out creation with no returned ID requires manual provider reconciliation; bounded duration does not remove orphaned provider data.

## Verified evidence

- `pnpm check`: 409 tests across 23 files, typecheck and production build passed.
- Bionera staged app configuration validation, app build and Theme Check passed with both existing Bionera extension identities preserved.
- Actual Tavus key authentication and stock-face reads: HTTP 200. No key was printed or committed.
- Actual `test_mode: true` preflight with this adapter and Brooke: PAL creation 200; private conversation creation 200 with `ended` status and meeting token; end 200; conversation hard-delete 204; PAL delete 204. No known test resources remain.
- Test mode never launches the avatar and does not test the real callback, speech quality, interruption, latency or production cost.
- The merchant confirmed the account's current Free plan includes 20 conversational-video minutes, stock faces and 42+ languages. This establishes the plan allowance, not a measured remaining balance. Verify usage before/after the first bounded live trial. No paid plan purchase is authorized.

## Release sequence

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

See [API contract](TAVUS-API-NOTES.md) and [progress](PROGRESS.md) for the verified external release state.
