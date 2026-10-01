# Shopify AI Sales Agent

Reusable Shopify shopping assistant; first pilot: Nutri Tiger (`ym5fhx-fa.myshopify.com`). TypeScript backend, Shopify theme app extension, grounded product cards, existing theme cart, consent-aware analytics and experiment assignment. Voice and avatar are extension interfaces; text is implemented first.

**Status: local implementation; not installed or live on Shopify yet.** Shopify app credentials exist locally; provider keys/billing, HTTPS backend deployment, installation and merchant-approved product knowledge remain external dependencies. The application contains no fake product catalog. Natural generated responses are checked against evidence; probabilistic verification does not guarantee zero mistakes.

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
| `packages/core` | OpenAI/Mistral decisions, natural composition, evidence checks, tenant knowledge and policy |
| `packages/shopify` | Live Storefront queries pinned to 2026-07 |
| `extensions/sales-assistant` | Shopify theme app embed and compiled assets |
| `extensions/sales-analytics` | Privacy-gated Shopify web pixel |
| `config/stores` | Separate reviewed configuration and evidence per shop |
| `config/training` | Draft merchant conversation profiles; never loaded automatically |
| `tests` | Security, grounding, catalog, cart, consent, OAuth and analytics regressions |

Read [architecture](docs/ARCHITECTURE.md), [knowledge workflow](docs/KNOWLEDGE.md), [AI providers](docs/AI-PROVIDERS.md), [installation](docs/INSTALLATION.md), [operations](docs/OPERATIONS.md), and [progress](docs/PROGRESS.md).

## Grounding contract

The model returns typed intent/identifiers, followed by naturally composed dialogue using selected approved evidence and reviewed merchant guidance. The server checks reference scope and numeric values, rejects generated prices/cart-success claims, and runs a separate semantic evidence check before display. Unknown IDs, wrong-shop facts, draft/revoked evidence and stale approvals are rejected. Semantic checking is probabilistic and still requires reviewed Greek evaluations. Medical suitability is outside the assistant's response scope; medical and outage replies use fixed fallbacks. Prices, options and stock come from Shopify; real cart results are authoritative.

Changing a model, prompt, approval rules, API version, or cart behavior requires passing the relevant regression suite and live pilot checks. Test fixtures are explicitly isolated from application data.

## Store configuration

Nutri Tiger starts with `facts: []` and `approvedImageUrls: []`: its storefront is still closed/under construction and historical text/packshots are not automatically approved. The `pnpm knowledge` workflow imports local UTF-8 source snapshots as drafts, records explicit approval/revocation, and accepts reviewed conversation profiles. A changed source invalidates older approvals. Source snapshots currently require manual export; automatic crawling and a merchant graphical editor are not implemented. Retrieval is bounded lexical matching with Greek normalization; it can miss paraphrases and Greeklish. Use `pnpm config:sync ym5fhx-fa.myshopify.com` after review and installation. For a second store add a separate config file and allowlist entry, then install through OAuth. Do not copy Nutri Tiger knowledge into another brand.

Run `pnpm analytics:report ym5fhx-fa.myshopify.com` for consented unique visitor cohorts, observed checkout values and aggregate model usage. A/B/C is prepared at 33% OpenAI / 33% Mistral / 34% control and remains off until real provider and pixel attribution/consent checks pass. Model, prompt, fact or guidance changes require a new experiment ID. Analytics measures observed checkout completion, not payment settlement or profit; results are descriptive rather than a statistical winner decision.

Schema version 2 adds experiment enrollment, immutable specifications and aggregate model usage. The separate migration deployment must run before deploying this backend against an existing production database. No remote migration or deployment is triggered by `pnpm check`.
