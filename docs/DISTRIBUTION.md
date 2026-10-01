# Shopify distribution and pilot registration

Updated 1 October 2026. The pilot app registration has been created through Shopify CLI and verified in the Dev Dashboard. Distribution has not been selected; extensions have not been deployed and the app has not been installed on the store.

## Verified pilot registration

| Field | Value |
| --- | --- |
| App name | Nutri Tiger Sales Pilot |
| Client ID | `780164aa2eacd46fa59c4ae3275643a6` |
| Dev Dashboard organization | `227248842` — KOOQIE IKE |
| App ID | `430277591041` |
| Dashboard | [Nutri Tiger Sales Pilot](https://dev.shopify.com/dashboard/227248842/apps/430277591041) |

The same Dev Dashboard organization contains the existing Kooqie Loyalty app. This is a separate Sales Pilot registration. The earlier `5058807` value is a legacy Partner identifier; it is not the verified Dev Dashboard organization ID, and using it in a Dev Dashboard organization URL returned 403. Do not use it to identify this app's verified ownership.

## Decision

Keep one reusable codebase and tenant architecture. For an immediate pilot on the actual Nutri Tiger store, use a **separate custom-distributed pilot app registration**. The eventual registration that independent merchants install must use **public distribution** and pass Shopify review. A custom registration cannot later be converted into a public one. [Distribution capabilities](https://shopify.dev/docs/apps/launch/distribution)

The pilot registration is owned by the verified KOOQIE IKE Dev Dashboard organization above. Organization `236813359` is the merchant organization observed in the session; its identity was not used for this registration. Collaborator access to a store and permission to manage apps in an organization are distinct. [Dev Dashboard permissions](https://shopify.dev/docs/apps/build/dev-dashboard/user-permissions)

## Registration choices

| Registration | Distribution | Intended installation |
| --- | --- | --- |
| Nutri Tiger Sales Pilot — created | Not selected; Custom recommended | `ym5fhx-fa.myshopify.com` only; real storefront pilot after integration verification |
| Sales Agent platform | Public | Owned dev store before review; independent merchant stores after approval |
| Development identity, if needed | Development only | Isolated dev store and development environment |

Custom distribution permits one merchant store, or stores belonging to one Plus organization, and needs no App Store approval. It cannot use Shopify app billing. This is not a shortcut for one custom app to serve unrelated merchants. In the pilot's custom installation settings, restrict the target to Nutri Tiger and leave the Plus multi-store option disabled. Shopify's current flow is the app's Distribution card in the Dev Dashboard, followed by generation of the store-specific installation link. [Select distribution](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method)

Do not select custom distribution on an app identity intended to become the public platform. The choice is permanent. The older unreviewed “unpublished public app” route is deprecated, and new legacy admin-created custom apps are unavailable. [Distribution capabilities](https://shopify.dev/docs/apps/launch/distribution)

## What can be tested before review

A public app can be installed and tested on an owned development store before submission. Shopify documents this installation flow as part of preparing for review. The production Nutri Tiger store requires either the separate custom pilot registration or the approved public registration; do not plan around installing an unapproved public app on the production store. [Pre-submission development-store testing](https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review), [public approval requirement](https://shopify.dev/docs/apps/launch/distribution)

A development store can exercise the assistant, extensions, live test catalog and test checkouts. It cannot process real transactions, remove its password page, become a production store or be transferred to the merchant. It is therefore useful integration evidence but cannot satisfy the requested real Nutri Tiger storefront pilot by itself. [Dev-store limitations](https://shopify.dev/docs/apps/build/stores/development-stores)

An unlisted public app still undergoes review. Limited visibility changes discoverability, not the approval requirement. [Shopify's public app types](https://help.shopify.com/en/manual/apps/about-apps)

## Consequences for this repository

The platform remains reusable with shop-specific configuration and approved knowledge. A Shopify registration adds a distinct client ID/secret, extension identity, OAuth installation and signed proxy/webhook boundary. Reusing source does not make these identities interchangeable.

The current server configuration accepts one `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` pair per deployment. Initially deploy the custom pilot identity. Do not place a second app's credentials into the same running deployment and expect existing installs to continue working. Concurrent custom/public operation needs either separate service deployments or an explicit, tested app-identity routing and storage design. This is an implementation constraint observed in `apps/server/src/config.ts`, not a Shopify distribution restriction.

When the public app is approved, moving Nutri Tiger is a planned new installation: preserve approved tenant configuration, obtain the new app's authorization, release its extensions, verify proxy/pixel behavior, enable the new embed and disable the old one. Protect against duplicate widgets and events. Public and custom access tokens cannot be substituted. Do not promise a zero-step conversion.

## Public-release gate

Before public submission, complete merchant-facing onboarding/configuration, fresh-install and reinstall behavior, theme-extension activation instructions, privacy/support material and review test instructions. The reviewer must be able to evaluate a finished application. This repository's manually configured pilot and successful local tests do not by themselves establish public-review readiness. Run the Shopify App Store review skill when preparing that submission; review the current requirements again then. [Preparing for app review](https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review)

The pilot registration already exists. Remaining steps are selecting its distribution, replacing the CLI scaffold defaults after the real HTTPS backend is available, deploying configuration/extensions, and completing the store installation and unpublished-theme verification. The public identity can be created separately when its development/review workflow starts; the same reusable platform code and per-store configuration remain the basis for both registrations.
