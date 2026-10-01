# Shopify AI Sales Agent

Reusable Shopify shopping assistant; first pilot: Nutri Tiger (`ym5fhx-fa.myshopify.com`). TypeScript backend, Shopify theme app extension, grounded product cards, existing theme cart, consent-aware analytics and experiment assignment. Voice and avatar are extension interfaces; text is implemented first.

**Status: local implementation under verification. Not installed or live on Shopify yet.** Real Shopify app credentials, OpenAI API project, HTTPS backend deployment and merchant-approved product knowledge are required. The application contains no fake product catalog and will not invent data when configuration is missing.

## Start locally

Requirements: Node 24, pnpm 11, Git. Shopify CLI is pinned in this repo. Docker is optional locally: PGlite provides a PostgreSQL development database.

```powershell
pnpm install --frozen-lockfile
node scripts/init-env.mjs
pnpm run doctor
pnpm check
pnpm dev
```

Open http://localhost:3000. A healthy but unconfigured server returns 200 at `/healthz` and 503 at `/readyz`. Add credentials in ignored `.env`, never in chat or source. After OAuth and a real HTTPS endpoint, the storefront widget calls the same-origin Shopify app proxy. A separate mock storefront is not part of the app.

## Structure

| Path | Responsibility |
|---|---|
| `apps/server` | Proxy/session authentication, persistence, install, limits, analytics, privacy webhooks |
| `apps/widget` | Accessible text shopping panel and serialized Ajax cart |
| `packages/core` | Strict model decisions, approved evidence, policy, transport interfaces |
| `packages/shopify` | Live Storefront queries pinned to 2026-07 |
| `extensions/sales-assistant` | Shopify theme app embed and compiled assets |
| `extensions/sales-analytics` | Privacy-gated Shopify web pixel |
| `config/stores` | Separate reviewed configuration and evidence per shop |
| `tests` | Security, grounding, catalog, cart, consent, OAuth and analytics regressions |

Read [architecture](docs/ARCHITECTURE.md), [installation](docs/INSTALLATION.md), [operations](docs/OPERATIONS.md), and [progress](docs/PROGRESS.md).

## Grounding contract

The model returns typed intent and identifiers, never a factual answer string. The server combines fixed templates, exact approved facts, and fresh Shopify products. Unknown IDs, wrong-shop facts, draft/revoked evidence and stale approvals are rejected. Medical suitability is outside the assistant's response scope. Prices, options and stock come from Shopify; real cart results are authoritative.

Changing a model, prompt, approval rules, API version, or cart behavior requires passing the relevant regression suite and live pilot checks. Test fixtures are explicitly isolated from application data.

## Store configuration

Nutri Tiger starts with `facts: []` and `approvedImageUrls: []`: historical product text/packshots are not automatically approved. Add source-backed, merchant-reviewed fact records in the store JSON; use `pnpm config:sync ym5fhx-fa.myshopify.com` after installation. For a second store add a separate config file and allowlist entry, then install through OAuth. Do not copy Nutri Tiger knowledge into another brand.

Run `pnpm analytics:report ym5fhx-fa.myshopify.com` for aggregate event counts. A/B is off until the real pixel attribution/consent checks pass. Analytics measures observed checkout completion, not payment settlement.
