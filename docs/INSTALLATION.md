# Installation and preview runbook

Shopify CLI has created **Nutri Tiger Sales Pilot**, client ID `780164aa2eacd46fa59c4ae3275643a6`, app ID `430277591041`, in the verified Dev Dashboard organization `227248842` (KOOQIE IKE). Open the [pilot app](https://dev.shopify.com/dashboard/227248842/apps/430277591041). The same organization contains the existing Kooqie Loyalty app; the pilot is a separate registration.

Custom distribution is selected and restricted to `ym5fhx-fa.myshopify.com` only, with the Plus multiple-store option disabled. Shopify app version **`nutri-tiger-sales-pilot-2`**, version ID `1151060279297`, has been released with the configuration and theme/web pixel extensions. The standalone app retains authorization-code token acquisition while Shopify manages installation/scopes. OAuth completed successfully and displayed **AI Sales Agent connected**, confirming Storefront token/pixel provisioning and tenant persistence. Dedicated unpublished preview theme **`202204184923`** has been created; at the latest 13:48 Europe/Athens check on 1 October 2026, Shopify was still processing it and the editor was disabled. Wait for that same theme to finish before enabling the embed. Widget/storefront verification remains pending; the live theme has not been enabled or published.

The backend serves `https://shopify-ai-sales-agent-smka.onrender.com` with schema v2 and the restricted database role. The initial live deployment used an incorrect runtime `APP_URL` despite passing health checks; that value was corrected and deployment **`dep-dav3j0ojo6nc73fbqor0`** started its server at **13:44:50 Europe/Athens** on 1 October 2026. HTTP 200 from `/healthz` and `/readyz`, the exact OAuth callback/client/Shopify redirect target, and the successful OAuth round trip are now verified. Render's final deployment badge may still be settling; a healthy endpoint alone does not validate configuration. After explicit user approval, a restricted OpenAI key with Responses Write permission and a 30-day expiration was stored privately in the ignored local environment and Render. A real OpenAI smoke test passed three calls using 1,898 input tokens and 75 output tokens in 8,954 ms. This verifies provider access and the response contract, not storefront behavior or Greek sales effectiveness. Mistral is not configured and A/B/C remains disabled.

The reusable `.example` configuration remains a template. The pilot allowlist contains only `ym5fhx-fa.myshopify.com`; the merchant connector is unrelated and must never be used for this pilot. The earlier `5058807` identifier is a legacy Partner ID, not this app's verified Dev Dashboard organization ID. See `PROGRESS.md` for the latest installation evidence and remaining dependencies.

## Local environment

Use Node 24 and the pnpm version pinned by `packageManager`. Run `pnpm install --frozen-lockfile`, `pnpm run doctor`, then `pnpm check`. Copy `.env.example` to `.env` and populate values locally. API secrets must never enter source, screenshots, command arguments, HTTP access logs or error reports. The service must suppress query strings on `/auth` and `/auth/callback` at both the reverse proxy and application logger.

`ENCRYPTION_KEY` must decode to 32 random bytes; `SESSION_SECRET` must be independently generated and at least 32 random characters. Use the host's secret manager in production. Preserve encryption keys through redeploys; losing them makes stored Shopify credentials unreadable. `DATABASE_URL` selects PostgreSQL with a restricted runtime role; local PGlite is development-only and auto-migrates. Keep `MIGRATION_DATABASE_URL` and the exact `MIGRATION_EXPECTED_DATABASE` name only in the separate migration job. Pilot defaults use two runtime connections with bounded timeouts; see `docs/OPERATIONS.md` for grants/tuning.

## Backend and Shopify app are separate deployments

Deploy the backend as a persistent Node service/container behind HTTPS with managed PostgreSQL, environment secrets and health monitoring. Prefer an independent assistant database instance; any shared instance needs capacity review, a separate logical database and independent assistant roles. Run `pnpm build`, then `pnpm db:migrate` as a separate job with its owner URL and expected database name set privately. It verifies the database name before creating/updating `sales_agent`. Provision restricted runtime grants, then start with `pnpm start` and only the scoped `DATABASE_URL`. Runtime verifies migration readiness without DDL. The production Docker image supports `node dist/apps/server/src/migrate.js` as a one-off job. `APP_URL` is an HTTPS origin with no path. Verify readiness before Shopify setup.

On the new dedicated `sales_agent_production` database, provision the initial `sales_agent_runtime` login with `pnpm db:provision-runtime` (container: `node dist/apps/server/src/provision-runtime.js`) after migration. Its isolated job needs the owner URL, expected database, `RUNTIME_ROLE_BOOTSTRAP=true` and a privately generated `RUNTIME_DATABASE_PASSWORD`; see `OPERATIONS.md` for its password format and safety checks. It accepts no secrets in command arguments and outputs no credentials. Remove the bootstrap password/mode after success and populate the restricted web `DATABASE_URL` privately. Existing roles are never modified by this one-time command.

Shopify CLI deploy uploads app configuration and extensions. **It does not host the Node API or database.** A CLI development tunnel exists only while the developer process runs and cannot serve a production installation. Use distinct developer/staging and production app credentials. Backend and tunnel URLs, OAuth redirect URLs, app proxy destination and pixel endpoint must refer to the same environment.

## Configure the created pilot app

Use the existing Nutri Tiger Sales Pilot identity above rather than creating another pilot app. Follow `DISTRIBUTION.md` to select the intended pilot distribution; a future public platform registration remains separate from a custom pilot registration while reusing the same codebase. Once the backend has a real HTTPS origin, replace the CLI draft's application URL, redirect URLs, app-proxy destination and remaining scaffold settings using the checked-in example as the implementation contract. Confirm the client ID remains `780164aa2eacd46fa59c4ae3275643a6`.

Keep `embedded = false` and `use_legacy_install_flow = false`. Shopify manages installation and scope approval from the deployed configuration; this standalone app separately acquires its offline access token through the official SDK's authorization-code flow using `/auth` and `/auth/callback`. Managed installation does not require a standalone app to become embedded or use ID-token exchange. Retain the state-cookie, callback HMAC/timestamp, allowlist and granted-scope checks. App creation or a successful deploy alone does not verify the real OAuth round trip.

App-specific webhook subscriptions require managed installation. Enabling `use_legacy_install_flow` while keeping `[[webhooks.subscriptions]]` causes deployment validation to fail, including for the compliance topics. Keep these subscriptions in the configuration; do not remove uninstall or privacy delivery to work around that validation error. The alternative legacy path would require separately provisioning shop-specific operational webhooks and configuring compliance delivery outside the Admin API, adding unnecessary installation and maintenance work.

Required scopes are `unauthenticated_read_product_listings`, `read_pixels`, `write_pixels`, `read_customer_events`, `write_app_proxy`. `write_pixels` implies pixel reads; the explicit read entry documents the lookup. Product inventory quantity scopes are unnecessary when only `availableForSale` is used. No order/customer Admin API read or product/theme write scopes are required. Adding a scope requires a deliberate configuration change and merchant reauthorization.

Use `shopify app config validate --json` against the real linked configuration. This may initiate CLI authentication if needed. The `.example` file is intentionally not an executable app configuration and is not evidence of successful CLI schema validation. Review the exact target and side effects before commands that authenticate, link or deploy.

The app proxy is `/apps/sales-agent` → backend `/proxy`. The merchant can customize the public proxy prefix/subpath, so keep the widget's configured proxy path aligned. `app/uninstalled`, `customers/data_request`, `customers/redact` and `shop/redact` are routed to `/webhooks`; root webhook handling must verify raw-body HMAC and apply shop-scoped deletion/disable behavior.

Deploy the app configuration and web pixel/theme extensions before installation. The pixel's settings schema must expose `endpoint`, `shop` and `ingestKey`; Shopify rejects settings that do not match the deployed extension. Do not enable the embed on the live theme.

## OAuth and provisioning

Open `/auth?shop=ym5fhx-fa.myshopify.com` on the configured backend origin in a normal browser and authorize the app. The server accepts only the explicit allowlist. Shopify's SDK creates a secure signed state cookie, verifies callback HMAC/state/timestamp and exchanges the code for an offline session. The server checks returned shop, offline mode, access token and granted scopes.

After OAuth, the server looks for its named app-scoped Storefront access token and reuses it when its scopes suffice; otherwise it creates one. It queries the app's existing pixel and updates it or creates the first pixel. The pixel uses the configured collector endpoint plus a scoped ingestion key. This client-visible key is only an ingestion/routing control; it is not proof that a purchase occurred, and must not authorize administrative or storefront operations.

Pilot installation registers the app pixel store-wide, even while the assistant widget is enabled only in an unpublished theme preview. The pixel sends checkout events only when Shopify reports analytics processing consent, but those requests can also originate from the live storefront. The backend discards checkout events without a valid, unexpired and unambiguous assignment mapping; preview-only widget activation does not restrict the pixel's network traffic to that preview.

Only after all provisioning succeeds does `saveInstallation` transactionally persist the encrypted offline session (`session.toObject()`), encrypted Storefront token and pixel ID. The callback returns no credentials. A failed step returns a fixed stage (`oauth`, `scopes`, `storefront_access`, `web_pixel` or `persistence`) without raw Shopify error bodies. Repair the failed step and restart OAuth; existing tokens/pixels are recovered after interrupted setup. Pixel/schema failure must never be reported as a successful complete installation. Concurrent installations across multiple API replicas need a shared per-shop provisioning lock before general distribution; pilot setup should have one installation worker at a time.

## Unpublished Nutri Tiger preview

Use a dedicated unpublished theme copy. Enable the theme app embed there, point it to the matching proxy path and verify the complete shopper flow against live product and variant reads. Products must be published to the app's relevant Storefront API channel/context to appear. Missing products are an installation/catalog visibility issue; never substitute invented products or stale prices. Merchant-approved evidence and approved media must be supplied in the tenant configuration before claims or claim-bearing packshots can appear.

Verify initial installation, reinstall, invalid OAuth state/HMAC, wrong-shop rejection, webhook signature handling and uninstall disablement. Verify assistant/control exposure, consent refusal/revocation, live price/availability changes, Ajax cart add/update, product clicks and checkout attribution. Use only merchant-coordinated test orders for checkout completion. Record actual evidence and outstanding dependencies in `docs/PROGRESS.md`. Publication or enabling the embed in the live Nutri Tiger theme requires explicit publication approval.

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
