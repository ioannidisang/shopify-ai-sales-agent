# Shopify distribution and pilot registration

Updated 13 October 2026. **Bionera Sales Pilot is installed and active** on the existing backend/database, following the merchant's choice to retain Nutri Tiger for later. Bionera's separate registration, single-store custom distribution, extension release, backend cutover and OAuth provisioning are complete. The widget is enabled only in unpublished theme `200088715651`; live theme `199350681987` was verified with its embed disabled. The store-wide pixel remains consent-gated. See `BIONERA-PILOT.md` and the latest entry in `PROGRESS.md` for verified checks and remaining rollout requirements.

## Verified active pilot registration

| Field | Value |
| --- | --- |
| App name | Bionera Sales Pilot |
| Client ID | `6eba3e1d30cecfb04b13698e8b055416` |
| Dev Dashboard organization | `227248842` — KOOQIE IKE |
| App ID | `435011715073` |
| Dashboard | [Bionera Sales Pilot](https://dev.shopify.com/dashboard/227248842/apps/435011715073) |

The same Dev Dashboard organization contains the existing Kooqie Loyalty app. This is a separate Sales Pilot registration. The earlier `5058807` value is a legacy Partner identifier; it is not the verified Dev Dashboard organization ID, and using it in a Dev Dashboard organization URL returned 403. Do not use it to identify this app's verified ownership.

## Decision

Keep one reusable codebase and tenant architecture. Each immediate pilot uses its own **custom-distributed pilot app registration**, restricted to its approved store; Bionera is the current active pilot. The eventual registration that independent merchants install must use **public distribution** and pass Shopify review. A custom registration cannot later be converted into a public one. [Distribution capabilities](https://shopify.dev/docs/apps/launch/distribution)

The pilot registration is owned by the verified KOOQIE IKE Dev Dashboard organization above. Organization `236813359` is the merchant organization observed in the session; its identity was not used for this registration. Collaborator access to a store and permission to manage apps in an organization are distinct. [Dev Dashboard permissions](https://shopify.dev/docs/apps/build/dev-dashboard/user-permissions)

## Registration choices

| Registration | Distribution | Intended installation |
| --- | --- | --- |
| Nutri Tiger Sales Pilot — preserved | Custom; single-store, Plus multi-store off | `ym5fhx-fa.myshopify.com`; installed/preview verified on 1 October; excluded from the current backend allowlist |
| Bionera Sales Pilot — installed and active | Custom; single-store, Plus multi-store off | `bionera-gr.myshopify.com`; widget enabled only in unpublished theme `200088715651` |
| Sales Agent platform | Public | Owned dev store before review; independent merchant stores after approval |
| Development identity, if needed | Development only | Isolated dev store and development environment |

Custom distribution permits one merchant store, or stores belonging to one Plus organization, and needs no App Store approval. It cannot use Shopify app billing. This is not a shortcut for one custom app to serve unrelated merchants. Each pilot registration is restricted to its own target store with Plus multi-store disabled. Shopify's current flow is the app's Distribution card in the Dev Dashboard, followed by generation of the store-specific installation link. [Select distribution](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method)

Bionera's verified app ID is `435011715073`, client ID `6eba3e1d30cecfb04b13698e8b055416`, in Dev Dashboard organization `227248842`. Version `bionera-sales-pilot-3` / `1165651968001` is active with the shared theme and pixel extensions after successful CLI validation/build/release. Its callback is `/auth/bionera/callback`. The store-specific install link and client secret remain private and ignored.

The current Render deployment is `dep-db75iuou01pc73cbcmqg`, source `9e02f8239b3ff0d1b2f22f1219a6fc951aa81c50`, Live on 13 October at 16:18:13.583859 UTC. Hosted installation checks confirm an installed/active/enabled Bionera tenant, 10 approved facts and the approved Greek conversation profile. A/B/C remains disabled. Real preview chat/cart, corrected packaging and card-price dialogue, consent refusal, analytics-only consent, withdrawal and a `checkout_started` event passed; no order or payment occurred. Shopify's real Reject all UI left all optional preferences unchecked, and the hosted audit confirmed deletion of test analytics events while retaining operational usage aggregates without shopper identifiers. The released cookie-preferences UI passed desktop and real Chrome 390 × 844 checks after a CSS compatibility fix applied only to the unpublished theme. The latest full check passed 329 tests / 20 suites, typecheck and build. Purchase attribution, Mistral, A/B/C and public rollout remain pending. See `PROGRESS.md` for bounded usage/event counts and evidence.

A final real query after consent withdrawal still produced correct grounded Greek dialogue with the live product card. The hosted audit remained `events: []`; final operational usage was 20/20 successful calls, 31,407 input / 1,992 output tokens and zero unknown records at that snapshot. The final full `pnpm check` after all changes passed at 19:27:42 Europe/Athens (26.04s for tests). No shopper identifiers were added to these operational aggregates.

Do not select custom distribution on an app identity intended to become the public platform. The choice is permanent. The older unreviewed “unpublished public app” route is deprecated, and new legacy admin-created custom apps are unavailable. [Distribution capabilities](https://shopify.dev/docs/apps/launch/distribution)

## What can be tested before review

A public app can be installed and tested on an owned development store before submission. Shopify documents this installation flow as part of preparing for review. The production Nutri Tiger store requires either the separate custom pilot registration or the approved public registration; do not plan around installing an unapproved public app on the production store. [Pre-submission development-store testing](https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review), [public approval requirement](https://shopify.dev/docs/apps/launch/distribution)

A development store can exercise the assistant, extensions, live test catalog and test checkouts. It cannot process real transactions, remove its password page, become a production store or be transferred to the merchant. It is therefore useful integration evidence but cannot satisfy the requested real Nutri Tiger storefront pilot by itself. [Dev-store limitations](https://shopify.dev/docs/apps/build/stores/development-stores)

An unlisted public app still undergoes review. Limited visibility changes discoverability, not the approval requirement. [Shopify's public app types](https://help.shopify.com/en/manual/apps/about-apps)

## Consequences for this repository

The platform remains reusable with shop-specific configuration and approved knowledge. A Shopify registration adds a distinct client ID/secret, OAuth installation and signed proxy/webhook boundary. Extension UIDs are source-defined, deterministic and app-scoped: shared handles can yield the same UIDs in separate registrations without sharing the app identity. The public Bionera registration manifest and local staging script preserve the correct client boundary and restore its verified extension UIDs. Reusing source does not make credentials interchangeable. [Shopify extension UID semantics](https://shopify.dev/docs/apps/build/dev-dashboard/migrate-from-partners).

The current server configuration accepts one `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` pair per deployment and one configured OAuth callback path. Bionera is the active identity. Do not place a second app's credentials into the same running deployment and expect existing installs to continue working. Concurrent custom/public operation needs either separate service deployments or an explicit, tested app-identity routing and storage design. This is an implementation constraint observed in `apps/server/src/config.ts`, not a Shopify distribution restriction.

When the public app is approved, moving Nutri Tiger is a planned new installation: preserve approved tenant configuration, obtain the new app's authorization, release its extensions, verify proxy/pixel behavior, enable the new embed and disable the old one. Protect against duplicate widgets and events. Public and custom access tokens cannot be substituted. Do not promise a zero-step conversion.

## Public-release gate

Before public submission, complete merchant-facing onboarding/configuration, fresh-install and reinstall behavior, theme-extension activation instructions, privacy/support material and review test instructions. The reviewer must be able to evaluate a finished application. This repository's manually configured pilot and successful local tests do not by themselves establish public-review readiness. Run the Shopify App Store review skill when preparing that submission; review the current requirements again then. [Preparing for app review](https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review)

Nutri Tiger's 1 October registration and installation remain preserved: app `430277591041`, client `780164aa2eacd46fa59c4ae3275643a6`. Bionera's separate registration is now installed. The merchant authorized one active pilot at a time, and the completed Bionera cutover changed the existing service's app credentials and explicit shop allowlist. Nutri is excluded from the current runtime without deleting its configuration or installation records. Both live themes remain read-only until explicit publication approval. The public identity can be created separately when its development/review workflow starts; the same reusable platform code and per-store configuration remain the basis for all registrations.
