# Shopify AI Sales Agent

- Build a reusable multi-tenant platform; Nutri Tiger is the first configuration, not a fork.
- Pilot store: `ym5fhx-fa.myshopify.com`. The Shopify merchant connector belongs to a different project; do not use it for store operations.
- Never put API keys, tokens, customer messages or authenticated URLs in commits/logs.
- Shopify CLI `app info --json` includes the loaded `.env`; capture and allowlist safe fields before displaying output. Never print the raw result or use `--web-env` in logged commands.
- Product prices, availability and variants must come from live Shopify reads. Product claims require versioned merchant-approved evidence. No inferred medical, nutrition or discount claims.
- Model output is untrusted. Allow only grounded product/fact IDs and fixed response templates; never execute model-supplied code or cart mutations.
- Cart changes require an explicit shopper action and use the existing theme Ajax cart.
- Default to unpublished theme preview. The live Nutri Tiger theme is read-only until explicit publication approval.
- Run `pnpm check` before handoff. Record verified results and remaining external dependencies in `docs/PROGRESS.md`.
