# Shopify AI Sales Agent — architecture decision record

Status: implementation baseline, 1 October 2026. The active Bionera private pilot and verified integration results are recorded in BIONERA-PILOT.md and PROGRESS.md. The 13 October extension proposal below is researched design, not implemented functionality.

## Product boundary

One installable Shopify app, with per-shop configuration and approved knowledge. Nutri Tiger is the first tenant. Text is the first transport; realtime voice and avatar implement separate interfaces later. No theme fork and no second cart.

## Request flow

Theme app embed → same-origin `/apps/sales-agent` proxy → Node/TypeScript API → tenant lookup and fixed experiment arm → policy and tenant knowledge retrieval → structured intent/ranking → live Shopify product read → natural-language composition → reference and evidence checks → response and authoritative product cards. A shopper click executes Shopify Ajax cart operations in the browser. The model cannot mutate carts.

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

Merchant decision, 1 October 2026: ordinary dialogue must use natural generated language, with updatable store knowledge and merchant guidance. This supersedes the earlier template-only design. Intent/ranking still returns bounded IDs; a separate provider-neutral composer writes short segments citing the selected evidence. Reference membership, source status and commercial values are checked in code, followed by a separate semantic support check. Unverified drafts are not displayed. Valid JSON or a real citation does not prove a claim is true; the semantic checker is also probabilistic, and real Greek evaluation is a release requirement. Stable medical/outage messages remain fallbacks. Prices and cart state are rendered by application code from fresh Shopify data, not generated prose.

Knowledge and merchant guidance belong to the tenant, independent of provider. Source imports start as drafts with canonical public provenance, content hash and source version. Explicit review/approval, revocation and source replacement control availability. Local UTF-8 site exports and merchant files are the first ingestion path; unrestricted web crawling and a merchant administration UI are not implied. Versioned instructions and example dialogues guide composition without becoming new factual evidence. Customer messages do not automatically train the shared agent. Retrieval, guidance and evaluation are used first; fine-tuning is not a launch dependency. Structured short-lived history retains displayed IDs/order for references such as “the second one”, but commercial values are read again.

Approved knowledge is versioned per shop, locale and product ID, with approver, approval timestamp and source reference. Draft or expired facts are unusable. Raw product descriptions and prior theme imagery are not approval evidence. Missing knowledge produces a clear limitation. Health/diagnosis/treatment/pregnancy/medication questions route to a fixed medical-boundary response without personalized supplement selection. Policy and adversarial tests cover prompt injection and cross-tenant references; lexical screening is only an extra guard, never the grounding guarantee.

Catalog reads use pinned Shopify API `2026-07` and market context. Prices and availability are read on every recommendation and immediately before cart action. No fabricated catalog in the application. Test fixtures stay in tests. Images require approved media selection because Nutri Tiger's historical packshots contain unapproved claims. An image-free real product card is acceptable until approved media exists.

## Cart

Use the Online Store Ajax cart with locale-aware paths and existing shopper cookies. Read before update, identify existing lines by line key, and show exact variant and quantity. Text requests produce a confirmation proposal; buttons are explicit commands. Disable duplicate submits; do not automatically retry ambiguous cart mutations. Refresh authoritative cart after mutation. Prices, discounts, stock rejection and final checkout totals remain Shopify-controlled. Never create discounts, orders or payment transactions.

## Analytics and experiments

Required events: assistant_open, conversation_started, recommendation_shown, product_clicked, add_to_cart, checkout_started, purchase. Also record experiment exposure separately from assistant opening and cart_updated separately from add_to_cart. Persist only allowlisted metadata; never send conversation content or health intent to analytics.

Versioned deterministic assignment is shop + experiment + consented anonymous visitor ID. The target experiment has OpenAI, Mistral and control arms; legacy assistant/control configuration remains readable. Both AI arms share knowledge, guidance and presentation but compose their own wording. Arm weights, model names and knowledge/guidance versions are fixed within an experiment ID. Routing is server-side, bound to the signed session; provider failure never silently switches an assigned visitor to the other model. Exposures are measured before opening the assistant and counted by eligible visitor, not by conversation. Consent denied: assistant may function with an ephemeral session, but no analytics persistence or experiment enrollment. Withdrawn consent stops tracking and clears identifiers and attribution. Server and Web Pixel extension deduplicate by event ID. Standard Shopify checkout_started/checkout_completed provide funnel events; completed checkout is reported as observed purchase, not financial settlement. Do not claim measured conversion uplift until real assignment-to-checkout correlation and data quality are verified. Web pixels can be blocked; report coverage and sample ratio mismatch. Aggregate operational provider usage records tokens, model calls, failures and latency without message content. Prior two-call cost estimates must be remeasured for composition and verification; these token records are not a provider invoice or hard monetary spending cap.

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

## 13 October 2026 proposal — learning loop and digital person

**15 October implementation update:** the merchant selected Tavus for the first Bionera trial. Full CVI now uses our verified custom LLM callback; session-specific PALs, authenticated short rooms, encrypted checked results and the lazy Daily widget are implemented. Real test-mode creation and cleanup passed, but production deployment and real Greek media acceptance remain pending. The earlier options below are retained as design history. The knowledge workbench and GSL remain proposals. See [Tavus pilot](TAVUS-PILOT.md) for the selected design, safeguards, release sequence and verified limits.

The merchant prioritizes a visible digital person with optional spoken or written interaction, alongside continuous improvement and expansion of approved knowledge. This changes the next product milestone: knowledge administration and a controlled speaking-avatar prototype should advance together. It does not authorize buying a new provider plan, publishing the live theme, or treating generated claims as merchant-approved facts.

### Controlled knowledge growth

Existing source revisions/hashes, draft/approve/revoke operations, merchant guidance, and runtime evidence checks remain the foundation. Add a merchant-authenticated knowledge workbench with tenant-scoped source registry, revisions, extracted candidates, approval audit, evaluations and release manifests. Review actions must use an authenticated merchant identity rather than a client-provided approver name.

Allowlisted public store pages, official product labels, supplier documents and merchant uploads become inputs to a bounded asynchronous ingestion job. Fetches require URL/redirect/size/type limits and protection against internal-network targets. Source text is untrusted data, never executable instructions. Extraction produces a candidate, exact supporting passage, source revision, product association and proposed category. It does not approve itself. Detect conflicts and missing evidence explicitly.

Approval can cover a reviewed collection of evidence-backed candidates or a versioned source section under an explicit merchant policy; it need not require hand-authoring every FAQ. New wording may be generated from approved facts without constituting a new factual claim. New claims or materially changed passages require review; a published webpage alone is not approval. Normalize formatting and match stable passages so harmless whitespace edits do not needlessly revoke every fact, while substantive changes invalidate affected evidence. Prices, discounts, variants and availability remain outside this knowledge pipeline and come from live Shopify.

Extend lexical retrieval with Greek-aware hybrid retrieval as volume grows. Apply shop, product, locale, approval and validity filters before selecting results. The current lexical implementation and 1,000-fact cap are not a scalable retrieval design.

### Learning from experience

Keep the current short-lived encrypted conversation context separate from any learning dataset. Do not silently retain transcripts, recordings or health disclosures. The first learning signal design uses bounded categories such as missing evidence, rejected grounding, unresolved product comparison and explicit merchant correction; avoid raw text, health categories and identifiers. Establish purpose, consent and retention separately from commerce analytics. A shopper statement identifies a possible gap, never supplies authoritative product evidence.

Aggregate gaps into a merchant review queue. Search only permitted sources; propose a sourced answer or ask a specific question when evidence is absent. Merchant corrections and approved synthetic examples may improve versioned guidance. Keep a frozen Greek evaluation set (including Greeklish, ambiguous references, comparisons, budget, unsupported claims and clinical boundaries), with human ratings for naturalness and usefulness. Fine-tuning is a later option using a reviewed dataset, not the mechanism for changing current product facts.

Validate candidate knowledge/guidance releases offline, then publish a version that can be rolled back. Any experiment-affecting change requires a new experiment version; do not mutate prompts or knowledge midway through an A/B/C measurement. More purchases alone do not establish factual accuracy or causal improvement.

### One conversation, optional face and voice

Proposed first integration: typed input or speech transcription → existing commerce/evidence pipeline → fully checked response → the same displayed text and synthesized speech → modular avatar renderer. The chained path allows inspection before speech and replacement of individual components. It is supported in [OpenAI voice-agent guidance](https://developers.openai.com/api/docs/guides/voice-agents). The current transport/avatar interfaces are extension points only; no live audio or avatar runtime is implemented.

Do not send provisional model tokens to speech. Associate verified text, audio and product cards with a turn ID; interruption cancels generation and buffered playback, and stale output cannot resume. For initial voice delivery, price remains on the authoritative card; reading it aloud would require a separate deterministic formatter using fresh Shopify values. Cart changes still require a visible, explicit shopper confirmation. An avatar must never acquire independent tools, store credentials or authority to alter commerce.

A small clearly labelled AI person opens an expandable panel with Write/Speak, microphone state, mute/stop, captions and product cards. Start media only after a shopper action; do not autoplay sales speech. No shopper camera is required. Keep one conversation across text/voice switches and fall back to text when media fails. Native interruption, short relevant replies, Greek pronunciation and response delay must be tested; visual realism alone is not sales quality. [OpenAI TTS](https://developers.openai.com/api/docs/guides/text-to-speech) lists Greek, but describes voices as optimized for English; supported language is not verified quality on our product names.

First candidate for a bounded private prototype: [LiveAvatar Avatar Only/LITE](https://docs.liveavatar.com/docs/lite-mode/overview), which renders supplied audio while we own STT, reasoning and TTS. Its [events](https://docs.liveavatar.com/docs/lite-mode/events) support supplied audio and interruption. Tavus Echo is a second visual comparison candidate, using [external text/audio](https://docs.tavus.io/sections/event-schemas/conversation-echo). Neither candidate has been integrated or evaluated with Bionera Greek speech.

Research snapshot, 13 October: [LiveAvatar pricing](https://docs.liveavatar.com/docs/faq/credits) lists a free tier with 10 credits and Essential at $99/month with 1,100 + 10 credits. LITE consumes one credit per session minute, including listening time; STT/TTS/model/hosting are separate. These are vendor list terms, not a purchase or total cost estimate. Require lazy sessions, idle shutdown, concurrency/time limits and a measured cost per completed conversation before selecting a paid plan. Existing Responses-only API permissions must not be assumed to authorize audio endpoints.

### Greek Sign Language is a separate accessibility track

A speaking avatar's lip synchronization or generic gestures are not Greek Sign Language (GSL/ΕΝΓ). EASIER demonstrates an actual Greek signing avatar but describes work in progress; [its public evidence](https://www.project-easier.eu/the-easier-avatar/) does not establish a production API for arbitrary Bionera conversation.

Keep text and captions available. A first scoped GSL pilot can use clips translated and reviewed by qualified GSL specialists and Deaf users for stable approved intents, linked to the knowledge version and invalidated when it changes. Do not embed live prices/stock in fixed clips. The signing view must expand to show hands, upper body and facial expressions. Arbitrary text-to-GSL generation and understanding shopper signing through a camera are distinct future systems requiring separate evidence and evaluation. Captions are useful access, not a claim of GSL equivalence.

### Next implementation and release evidence

1. Merchant knowledge workbench and bounded source ingestion; verify authorization, source grounding, tenant isolation, conflict handling and revision/revocation behavior.
2. Small Greek evaluation corpus and private digital-person prototype using the same approved knowledge. Compare pronunciation, understandable dialogue, lip synchronization, interruption, latency, mobile reliability and total session cost using identical scenarios.
3. Explicitly scoped learning signals and candidate guidance releases, evaluated before promotion. Preserve the existing no-transcript-analytics behavior.
4. GSL content/partner assessment with actual comprehension testing; no unsupported live-GSL claims.

The live Bionera and Nutri themes remain read-only. Provider accounts/keys, a selected persona, audio endpoint access, cost limits and separately reviewed GSL material are external dependencies; none was provisioned during this research.
