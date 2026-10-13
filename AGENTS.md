# Shopify AI Sales Agent

- Build a reusable multi-tenant platform; Nutri Tiger is the first configuration, not a fork.
- Active pilot selected on 13 October 2026: `bionera-gr.myshopify.com` (`bionera.gr`). Preserve the Nutri Tiger configuration (`ym5fhx-fa.myshopify.com`) for later; the merchant chose one active pilot on the existing infrastructure. The Shopify merchant connector belongs to a different project; do not use it for store operations.
- Never put API keys, tokens, customer messages or authenticated URLs in commits/logs.
- Shopify CLI `app info --json` includes the loaded `.env`; capture and allowlist safe fields before displaying output. Never print the raw result or use `--web-env` in logged commands.
- Product prices, availability and variants must come from live Shopify reads. Product claims require versioned merchant-approved evidence. No inferred medical, nutrition or discount claims.
- Model output is untrusted. Following the merchant's 1 October 2026 direction, ordinary conversation is generated naturally from tenant-approved evidence and versioned merchant guidance. Validate references and check claim support before display; schema validity alone does not establish truth. Keep deterministic medical/outage fallbacks. Never execute model-supplied code or cart mutations.
- Cart changes require an explicit shopper action and use the existing theme Ajax cart.
- Default to unpublished theme preview. The live Bionera and Nutri Tiger themes are read-only until explicit publication approval.
- Run `pnpm check` before handoff. Record verified results and remaining external dependencies in `docs/PROGRESS.md`.
