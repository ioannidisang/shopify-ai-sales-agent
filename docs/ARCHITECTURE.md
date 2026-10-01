# Shopify AI Sales Agent — architecture decision record

Status: implementation baseline, 1 October 2026. Live launch remains gated on real integration verification.

## Product boundary

One installable Shopify app, with per-shop configuration and approved knowledge. Nutri Tiger is the first tenant. Text is the first transport; realtime voice and avatar implement separate interfaces later. No theme fork and no second cart.

## Request flow

Theme app embed → same-origin `/apps/sales-agent` proxy → Node/TypeScript API → tenant lookup → policy → OpenAI structured decision → live Shopify product read → deterministic grounded response → product cards. A shopper click executes Shopify Ajax cart operations in the browser. The model cannot mutate carts.

Use a theme app extension so merchants can enable/disable the assistant and upgrade it without editing theme source. A shadow-root widget isolates CSS, supports keyboard and mobile, and lazily loads conversation UI. Locale and country originate in Liquid localization, are validated against shop configuration, and are passed to Storefront API `@inContext`.

## App and security

- Non-embedded OAuth app using the official `@shopify/shopify-api` library. Install callback persists encrypted offline credentials and provisions Storefront access. A future embedded administration UI can be added without changing the commerce service.
- Shopify-signed app proxy parameters determine shop identity. Validate signature, timestamp and the installed shop allowlist. Never accept tenant identity from JSON body.
- Proxy requests cannot depend on cookies. Bootstrap returns a short-lived signed token bound to shop, conversation and experiment assignment. Subsequent requests carry it in JSON; every database lookup is shop-scoped.
- PostgreSQL in production; PGlite provides the same SQL contract for local development, without Docker. SQL values are parameterized. Local mode is forbidden in production. Both adapters pin all application SQL to the dedicated `sales_agent` schema. Prefer an independent assistant database instance. A common PostgreSQL instance with Kooqie Loyalty requires measured capacity, a separate logical database and independent runtime/migration roles. Public/Loyalty tables are outside assistant migrations and retention. Existing public-schema data is never migrated implicitly.
- Network database startup verifies schema version and a restricted runtime role without DDL. An explicit migration command uses only `MIGRATION_DATABASE_URL`, checks `MIGRATION_EXPECTED_DATABASE` before creating objects, and runs outside the web service. Runtime rejects owner/elevated roles and a migration credential in its environment. The default runtime pool is two connections, with bounded connection/query timeouts; migration uses one. Local PGlite alone auto-migrates. Real hosted role/network/backup verification remains a release gate.
- Encrypt shop credentials at rest with AES-256-GCM and shop ID as associated data. Secret keys live in environment/secret manager. Logs omit prompts, API keys, cart tokens and PII.
- Shared database limits constrain calls per conversation and shop. Limit body size, messages, products, model output, request duration and daily usage. Per-process burst limiting adds defense in depth.
- Verify raw-body webhook HMAC and deduplicate delivery IDs. Uninstall revokes tenant access; mandatory privacy endpoints support deletion without preserving conversation text.

## Grounding and supplement policy

The language model is an intent/ranking layer. Its schema returns intent, search term, product IDs and fact IDs. It has no free-form customer-facing factual answer field. Unknown IDs are discarded. Server templates plus exact approved facts construct customer-facing text. No generated price, discount, stock count, ingredients, dosage or medical claim reaches the widget.

Approved knowledge is versioned per shop, locale and product ID, with approver, approval timestamp and source reference. Draft or expired facts are unusable. Raw product descriptions and prior theme imagery are not approval evidence. Missing knowledge produces a clear limitation. Health/diagnosis/treatment/pregnancy/medication questions route to a fixed medical-boundary response without personalized supplement selection. Policy and adversarial tests cover prompt injection and cross-tenant references; lexical screening is only an extra guard, never the grounding guarantee.

Catalog reads use pinned Shopify API `2026-07` and market context. Prices and availability are read on every recommendation and immediately before cart action. No fabricated catalog in the application. Test fixtures stay in tests. Images require approved media selection because Nutri Tiger's historical packshots contain unapproved claims. An image-free real product card is acceptable until approved media exists.

## Cart

Use the Online Store Ajax cart with locale-aware paths and existing shopper cookies. Read before update, identify existing lines by line key, and show exact variant and quantity. Text requests produce a confirmation proposal; buttons are explicit commands. Disable duplicate submits; do not automatically retry ambiguous cart mutations. Refresh authoritative cart after mutation. Prices, discounts, stock rejection and final checkout totals remain Shopify-controlled. Never create discounts, orders or payment transactions.

## Analytics and experiments

Required events: assistant_open, conversation_started, recommendation_shown, product_clicked, add_to_cart, checkout_started, purchase. Also record experiment exposure separately from assistant opening and cart_updated separately from add_to_cart. Persist only allowlisted metadata; never send conversation content or health intent to analytics.

Versioned deterministic assignment is shop + experiment + consented anonymous visitor ID, with separate assistant/control arms. Both arms record exposure and checkout events. Consent denied: assistant may function with an ephemeral session, but no analytics persistence or experiment enrollment. Withdrawn consent stops tracking and clears browser identifiers. Server and Web Pixel extension deduplicate by event ID. Standard Shopify checkout_started/checkout_completed provide funnel events; completed checkout is reported as observed purchase, not financial settlement. Do not claim measured conversion uplift until real assignment-to-checkout correlation and data quality are verified. Web pixels can be blocked; report coverage and sample ratio mismatch.

## Voice and avatar extension points

Transport contract accepts user input and emits grounded response, cards and pending action. A future Realtime WebRTC adapter gets ephemeral client credentials from authenticated backend, applies the same server policy and calls the same shopping tools; all cart writes still need a visible explicit confirmation. Voice must not read unchecked model prose. Avatar receives approved speech/audio and presentation state only; it never owns commerce logic or secrets. Both features are off for the text MVP.

## Deployment and release

Long-running container/service + managed PostgreSQL + HTTPS. Shopify CLI deploy distributes app configuration/extensions; it does not host this backend. Maintain separate dev/staging/production app credentials. Build the backend, run its isolated migration job, verify scoped runtime grants, deploy the backend, link the app, install only on Nutri Tiger, enable embed in a dedicated unpublished preview, test with real catalog and shopper cart, then approve live enablement. Rollback: disable embed or tenant feature flag, retain last backend image and migration compatibility. The Render deployment example is reviewable local configuration only; it has not provisioned resources or passed provider validation.

Release evidence required: OAuth reinstall/uninstall; bad proxy signatures denied; cross-tenant denial; missing/unapproved facts; stock/price changes; successful and sold-out Ajax cart paths; keyboard/mobile; consent revoked; control-arm checkout attribution; duplicate purchase; provider outage; concurrency/rate budget; deployed health checks. Real checkout/purchase verification needs Shopify test payment setup and explicit merchant coordination.

## Official references

- https://shopify.dev/docs/apps/build/online-store/theme-app-extensions
- https://shopify.dev/docs/apps/build/online-store/app-proxies
- https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps
- https://shopify.dev/docs/api/ajax/reference/cart
- https://shopify.dev/docs/api/storefront/2026-07
- https://shopify.dev/docs/api/web-pixels-api
- https://shopify.dev/docs/api/customer-privacy
- https://developers.openai.com/api/docs/guides/structured-outputs
- https://developers.openai.com/api/docs/guides/voice-webrtc
