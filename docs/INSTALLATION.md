# Installation and preview runbook

**13 October 2026 update:** Bionera is installed and active on the existing backend/database. Nutri Tiger configuration and stored records are preserved for later; one Shopify app identity is active per deployment. This runbook records the verified installation, while `PROGRESS.md` records later fixes and deployment evidence.

## Current Bionera installation

- App: **Bionera Sales Pilot**, app ID `435011715073`, client ID `6eba3e1d30cecfb04b13698e8b055416`, Dev Dashboard organization `227248842` (KOOQIE IKE).
- Custom distribution: only `bionera-gr.myshopify.com`, Plus multi-store disabled. Shopify release **`bionera-sales-pilot-3` / `1165651968001`** is active with theme/pixel extensions, app proxy and privacy webhooks; CLI validation/build/release passed and the public manifest is updated.
- Backend: `https://shopify-ai-sales-agent-smka.onrender.com`, Render `srv-dav36517lnhs73akj8fg`, deployment **`dep-db75iuou01pc73cbcmqg`**, source **`9e02f8239b3ff0d1b2f22f1219a6fc951aa81c50`**, verified Live on **13 October 2026 at 16:18:13.583859 UTC / 19:18:13 Europe/Athens**. Existing database/session/encryption/OpenAI settings were preserved.
- OAuth and provisioning succeeded with `/auth/bionera/callback`. The hosted tenant is installed/active/enabled with **10/10 approved facts** and the approved Greek conversation profile. A/B/C is disabled; approved images remain empty.
- Assistant embed is saved and enabled only in unpublished **`200088715651`**, with selected colors `#1E3D70` / `#FAF9F2`. The live theme **`199350681987`** was inspected read-only and its embed is disabled, with screenshot evidence. No theme was published.

Real preview checks passed for Greek product dialogue, live Shopify product/variant data and **€29.90** Magnesium pricing, Ajax add **1 → update 2 → remove**, correct approved Cyprus shipping information, and deterministic medical refusal. The final cart is empty; no order or stock change was made. At quantity two, Shopify returned line amount **€59.80** and cart total **€53.82**. These are observed Shopify values; no discount cause was inferred.

With analytics consent refused, the initial hosted database audit returned **`events: []`**. After analytics-only consent was selected through Shopify's real UI, the last bounded audit before withdrawal recorded `add_to_cart:1`, `assistant_open:4`, `cart_updated:2`, `checkout_started:1`, `conversation_started:2`, `experiment_exposure:5`, `product_clicked:1`, `recommendation_shown:2`. Aggregate usage at that point was **16/16 successful calls, 25,082 input / 1,564 output tokens and zero unknown usage records**; this is not a final session total. Checkout was reached without contact details, an order or payment; the cart was emptied after returning. Purchase attribution remains unverified. The pixel is installed store-wide and consent-gated, even though the widget is preview-only.

A packaging-count false positive was corrected and verified with a real answer containing the approved 90-capsule/composition information and the live €29.90 card. A subsequent inconsistency—text claiming an unknown price while displaying the card—was addressed by supplying `productCards` UI metadata to composition and grounded verification guidance. The final real replay on release 3 passed: natural Greek text correctly directs the shopper to the current card for price/availability, without falsely claiming that the price is unknown.

The released cookie-preferences button opens Shopify's existing preferences UI without setting consent directly. A theme-wide header rule distorted that modal; `deploy/bionera/preview-cookie-preferences.css` was applied only to the unpublished theme's Custom CSS, preserving existing CSS, and the saved desktop result was verified. The assistant layout passed the Shopify editor's mobile viewport check. After a button-text wrapping fix, the cookie modal also passed a real Chrome **390 × 844** viewport check; the viewport was reset afterward. Evidence: `.data/evidence/bionera-mobile-cookies-2026-10-13.png`. The live theme was not modified.

Consent withdrawal passed through Shopify's actual **Reject all** UI. Reopening preferences confirmed analytics, marketing and personalization unchecked. The subsequent read-only production audit returned **`events: []`**, confirming deletion of the test analytics events while operational usage aggregates remained without shopper identifiers. Another real query after withdrawal returned correct natural Greek composition/90-capsule information and directed the shopper to the €29.90 card. The final audit still returned **`events: []`**, with **20/20 successful calls, 31,407 input / 1,992 output tokens and zero unknown records** in the final usage snapshot. Chat therefore remained functional with tracking off. Final preview evidence: `.data/evidence/bionera-working-preview-2026-10-13.png`.

The latest full **`pnpm check` after all changes passed 329 tests / 20 suites, typecheck and production build**, at **19:27:42 Europe/Athens**, with tests taking **26.04s**. Mistral credentials, A/B/C, comparative Greek evaluation, purchase attribution and public rollout remain pending.

The public registration manifest and `node scripts/stage-shopify-pilot.mjs bionera` restore a separate ignored Shopify deployment workspace without reading or copying environment files. Use named configuration `bionera` there; keep the root Nutri Tiger app configuration intact. The Shopify merchant connector belongs to another project and must not be used for either pilot.

## Preserved Nutri Tiger history

The 1 October Nutri Tiger installation used app `430277591041`, client `780164aa2eacd46fa59c4ae3275643a6`, release `nutri-tiger-sales-pilot-3` / `1151079350273` and unpublished theme `202204184923`. Chat/catalog/cart checks passed then; the temporary inventory test was restored to zero. Its private-preview catalog exception expired on **8 October 2026** and was not renewed. The current Bionera allowlist excludes Nutri Tiger. These historical checks do not establish current Nutri runtime availability. See the dated history in `PROGRESS.md`.

## Local environment

Use Node 24 and the pnpm version pinned by `packageManager`. Run `pnpm install --frozen-lockfile`, `pnpm run doctor`, then `pnpm check`. Copy `.env.example` to `.env` and populate values locally. API secrets must never enter source, screenshots, command arguments, HTTP access logs or error reports. The service must suppress query strings on `/auth` and every configured OAuth callback, including `/auth/bionera/callback`, at both the reverse proxy and application logger.

`ENCRYPTION_KEY` must decode to 32 random bytes; `SESSION_SECRET` must be independently generated and at least 32 random characters. Use the host's secret manager in production. Preserve encryption keys through redeploys; losing them makes stored Shopify credentials unreadable. `DATABASE_URL` selects PostgreSQL with a restricted runtime role; local PGlite is development-only and auto-migrates. Keep `MIGRATION_DATABASE_URL` and the exact `MIGRATION_EXPECTED_DATABASE` name only in the separate migration job. Pilot defaults use two runtime connections with bounded timeouts; see `docs/OPERATIONS.md` for grants/tuning.

## Backend and Shopify app are separate deployments

Deploy the backend as a persistent Node service/container behind HTTPS with managed PostgreSQL, environment secrets and health monitoring. Prefer an independent assistant database instance; any shared instance needs capacity review, a separate logical database and independent assistant roles. Run `pnpm build`, then `pnpm db:migrate` as a separate job with its owner URL and expected database name set privately. It verifies the database name before creating/updating `sales_agent`. Provision restricted runtime grants, then start with `pnpm start` and only the scoped `DATABASE_URL`. Runtime verifies migration readiness without DDL. The production Docker image supports `node dist/apps/server/src/migrate.js` as a one-off job. `APP_URL` is an HTTPS origin with no path. Verify readiness before Shopify setup.

On the new dedicated `sales_agent_production` database, provision the initial `sales_agent_runtime` login with `pnpm db:provision-runtime` (container: `node dist/apps/server/src/provision-runtime.js`) after migration. Its isolated job needs the owner URL, expected database, `RUNTIME_ROLE_BOOTSTRAP=true` and a privately generated `RUNTIME_DATABASE_PASSWORD`; see `OPERATIONS.md` for its password format and safety checks. It accepts no secrets in command arguments and outputs no credentials. Remove the bootstrap password/mode after success and populate the restricted web `DATABASE_URL` privately. Existing roles are never modified by this one-time command.

Shopify CLI deploy uploads app configuration and extensions. **It does not host the Node API or database.** A CLI development tunnel exists only while the developer process runs and cannot serve a production installation. Use distinct developer/staging and production app credentials. Backend and tunnel URLs, OAuth redirect URLs, app proxy destination and pixel endpoint must refer to the same environment.

## Configure the created pilot app

Use the existing **Bionera Sales Pilot** identity above rather than creating another app. Follow `BIONERA-PILOT.md` and `DISTRIBUTION.md`; a future public platform registration remains separate while reusing the same codebase. Build shared assets, then run `node scripts/stage-shopify-pilot.mjs bionera` and use `shopify.app.bionera.toml` in `.data/bionera-shopify`. Confirm the client ID is `6eba3e1d30cecfb04b13698e8b055416`. The public registration manifest restores this identity and its app-scoped extension UIDs; staged identity conflicts fail closed. Preserve the root Nutri Tiger TOMLs and never copy its `.env` into the Bionera workspace.

Keep `embedded = false` and `use_legacy_install_flow = false`. Shopify manages installation and scope approval from the deployed configuration; this standalone app separately acquires its offline access token through the official SDK's authorization-code flow using `/auth` and the configured `SHOPIFY_AUTH_CALLBACK_PATH` (Bionera: `/auth/bionera/callback`). Exactly one callback is active per deployment. Managed installation does not require a standalone app to become embedded or use ID-token exchange. Retain the state-cookie, callback HMAC/timestamp, allowlist and granted-scope checks. App creation or a successful deploy alone does not verify the real OAuth round trip.

App-specific webhook subscriptions require managed installation. Enabling `use_legacy_install_flow` while keeping `[[webhooks.subscriptions]]` causes deployment validation to fail, including for the compliance topics. Keep these subscriptions in the configuration; do not remove uninstall or privacy delivery to work around that validation error. The alternative legacy path would require separately provisioning shop-specific operational webhooks and configuring compliance delivery outside the Admin API, adding unnecessary installation and maintenance work.

Required scopes are `unauthenticated_read_product_listings`, `read_pixels`, `write_pixels`, `read_customer_events`, `write_app_proxy`. `write_pixels` implies pixel reads; the explicit read entry documents the lookup. Product inventory quantity scopes are unnecessary when only `availableForSale` is used. No order/customer Admin API read or product/theme write scopes are required. Adding a scope requires a deliberate configuration change and merchant reauthorization.

Use `shopify app config validate --config bionera --json` from the Bionera staging directory against the real linked configuration. This may initiate CLI authentication if needed. The `.example` file is intentionally not an executable app configuration and is not evidence of successful CLI schema validation. Review the exact target and side effects before commands that authenticate, link or deploy.

The app proxy is `/apps/sales-agent` → backend `/proxy`. The merchant can customize the public proxy prefix/subpath, so keep the widget's configured proxy path aligned. `app/uninstalled`, `customers/data_request`, `customers/redact` and `shop/redact` are routed to `/webhooks`; root webhook handling must verify raw-body HMAC and apply shop-scoped deletion/disable behavior.

Deploy the app configuration and web pixel/theme extensions before installation. The pixel's settings schema must expose `endpoint`, `shop` and `ingestKey`; Shopify rejects settings that do not match the deployed extension. Do not enable the embed on the live theme.

## OAuth and provisioning

For a deliberate installation/reinstallation, open `/auth?shop=bionera-gr.myshopify.com` on the configured backend origin in a normal browser and authorize the app. The current Bionera installation has already succeeded; do not repeat it merely to resume preview testing. The server accepts only the explicit allowlist. Shopify's SDK creates a secure signed state cookie, verifies callback HMAC/state/timestamp and exchanges the code for an offline session. The server checks returned shop, offline mode, access token and granted scopes.

After OAuth, the server looks for its named app-scoped Storefront access token and reuses it when its scopes suffice; otherwise it creates one. It queries the app's existing pixel and updates it or creates the first pixel. The pixel uses the configured collector endpoint plus a scoped ingestion key. This client-visible key is only an ingestion/routing control; it is not proof that a purchase occurred, and must not authorize administrative or storefront operations.

Pilot installation registers the app pixel store-wide, even while the assistant widget is enabled only in an unpublished theme preview. The pixel sends checkout events only when Shopify reports analytics processing consent, but those requests can also originate from the live storefront. The backend discards checkout events without a valid, unexpired and unambiguous assignment mapping; preview-only widget activation does not restrict the pixel's network traffic to that preview.

Only after all provisioning succeeds does `saveInstallation` transactionally persist the encrypted offline session (`session.toObject()`), encrypted Storefront token and pixel ID. The callback returns no credentials. A failed step returns a fixed stage (`oauth`, `scopes`, `storefront_access`, `web_pixel` or `persistence`) without raw Shopify error bodies. Repair the failed step and restart OAuth; existing tokens/pixels are recovered after interrupted setup. Pixel/schema failure must never be reported as a successful complete installation. Concurrent installations across multiple API replicas need a shared per-shop provisioning lock before general distribution; pilot setup should have one installation worker at a time.

## Unpublished Bionera preview

Use the dedicated unpublished theme `200088715651`. Its embed is already enabled and saved with the matching proxy path. Verify the complete shopper flow against live product and variant reads. Products must be published to the app's relevant Storefront API channel/context to appear. Missing products are an installation/catalog visibility issue; never substitute invented products or stale prices. Merchant-approved evidence and approved media must be supplied in the tenant configuration before claims or claim-bearing packshots can appear.

Verify initial installation, reinstall, invalid OAuth state/HMAC, wrong-shop rejection, webhook signature handling and uninstall disablement. Verify assistant/control exposure, consent refusal/revocation, live price/availability changes, Ajax cart add/update, product clicks and checkout attribution. Use only merchant-coordinated test orders for checkout completion. Record actual evidence and outstanding dependencies in `docs/PROGRESS.md`. Publication or enabling the embed in either live Bionera or Nutri Tiger theme requires explicit publication approval.

## Privacy and measurement operations

Conversation context expires after 30 minutes and is encrypted separately from analytics. Medical-classified input is replaced by a fixed safety marker before persistence; the actual health disclosure is not retained in that turn. Other free-form input can still include volunteered identifiers, so encrypted context remains personal data and must be covered by the merchant's privacy notice. The model receives operational input; configure the provider's applicable data controls before a public rollout.

Consented visitor and pixel client identifiers use shop-scoped HMACs. Purchase deduplication stores an HMAC of the normalized Shopify order ID, never the raw order number. Pixel assignment expires after one day; events after 90 days. Consent withdrawal revokes all known sessions/mappings for the visitor/client. A signed expired conversation token can be used for revocation for 90 additional days, matching the retained exposure window; it cannot resume chat, commerce or event recording.

Customer erasure conservatively deletes all short-lived context, pixel mappings and analytics events for the tenant because this MVP intentionally has no customer-account-to-conversation linkage. A `customers/data_request` webhook is authenticated and acknowledged, but cannot resolve anonymous context to a particular customer account. The merchant needs a documented process to answer access requests and describe the data held; acknowledgment is not fulfillment of that process. Do not claim GDPR compliance or automated customer-specific exports from this MVP.

The collector applies shared limits of 3,000 pixel events per minute and 50,000 per day per shop. Client-side purchase observation and a public ingestion key do not prove a paid order, and a determined sender can poison browser analytics. Revenue-grade analytics would require an independently authenticated server order source and a separately approved data scope. Test experiment attribution and consent behavior in the real checkout before interpreting conversion rates.

## References

- [Shopify SDK OAuth guide](https://github.com/Shopify/shopify-app-js/blob/main/packages/apps/shopify-api/docs/guides/oauth.md)
- [Managed installation and standalone token acquisition](https://shopify.dev/docs/apps/build/authentication-authorization/app-installation)
- [Standalone app authorization-code grant](https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps)
- [App-specific and shop-specific webhook subscriptions](https://shopify.dev/docs/apps/build/webhooks/subscribe)
- [App configuration](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration)
- [CLI web process structure](https://shopify.dev/docs/apps/build/cli-for-apps/app-structure)
- [App proxy configuration and scopes](https://shopify.dev/docs/apps/build/online-store/app-proxies)
- [Storefront access token](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/StorefrontAccessToken)
- [Web pixel query](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/webPixel)
- [Web pixel create/update settings](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/WebPixel)
