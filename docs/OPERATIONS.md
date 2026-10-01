# Operations and release checks

## Runtime

Node 24 container/service behind HTTPS, with a managed PostgreSQL database and secret manager. `DATABASE_URL` must use provider-required TLS settings; never disable certificate verification. Local PGlite is deliberately forbidden with `NODE_ENV=production`. Dockerfile builds/tests code and starts as an unprivileged user; container build still needs verification where Docker is available.

Prefer an independent assistant PostgreSQL instance. Sharing Kooqie Loyalty's instance is conditional on measured capacity and a separate logical database with independent assistant roles. In either case, this app uses the fixed `sales_agent` schema and separate runtime/migration credentials. Both adapters set `search_path` only to `sales_agent`; migrations and retention queries do not resolve public/Loyalty tables. The adapter pins this even when a connection URL supplies a different search-path option. Namespace isolation complements database permissions. Do not reuse Loyalty's database owner role, grant assistant write privileges to Loyalty/public tables, or implicitly move existing data.

Provision `sales_agent` under a dedicated owner/migration role. Creating a missing schema requires database `CREATE`; after provisioning, migrations need schema `USAGE`/`CREATE` and ownership of this app's tables for `ALTER`/index operations. Run a separate deployment job with `MIGRATION_DATABASE_URL` and `MIGRATION_EXPECTED_DATABASE` set privately. After building, run `pnpm db:migrate`; the production container command is `node dist/apps/server/src/migrate.js`. The command accepts no credential arguments and never falls back to `DATABASE_URL`. It verifies `current_database()` against the exact expected logical database name before any DDL. Serialize this job before starting/updating service replicas.

The runtime receives only `DATABASE_URL` for a restricted role: database `CONNECT`, schema `USAGE`, `SELECT`/`INSERT`/`UPDATE`/`DELETE` on operational tables, and `SELECT` on `sales_agent.schema_migrations`. Startup reads the schema version and performs retention DML; it never creates/alters PostgreSQL schema objects. It rejects superuser, database/role-creation and row-security-bypass privileges, schema/table owner membership and schema `CREATE`. Production runtime also rejects `MIGRATION_DATABASE_URL` in its environment. Missing migration/access fails startup with a fixed diagnostic. Apply scoped grants for new tables during deployment. Never alter Loyalty's grants. Hosted poolers must support startup `options`/`search_path` or use a compatible endpoint; verify in staging.

Migrations are additive/idempotent; the version is recorded only after every statement succeeds. Repair/retry failed migrations before rollout; automatic schema rollback is not provided. Local PGlite auto-migrates and remains forbidden in production. Enable database backups and verify a restore in staging before launch.

For the first deployment of the new independent database, run the one-time bootstrap after migration: `pnpm db:provision-runtime` or `node dist/apps/server/src/provision-runtime.js` in the isolated migrator. It requires `MIGRATION_DATABASE_URL`, exact `MIGRATION_EXPECTED_DATABASE=sales_agent_production`, `RUNTIME_ROLE_BOOTSTRAP=true`, and `RUNTIME_DATABASE_PASSWORD` generated independently as 32–256 random URL-safe ASCII characters. Supply these through private job environment variables only. The fixed login is `sales_agent_runtime`; the script does not print its password, connection URL, SQL or verifier. Only a locally computed SCRAM-SHA-256 verifier is sent to PostgreSQL, never the plaintext password. Treat that verifier as sensitive too and keep database statement/error logging restricted in the hosting environment.

Bootstrap verifies the current logical database, the completed migration version and schema ownership; it refuses names outside the dedicated `sales_agent` naming family, unrelated application tables/views/sequences, or an already-existing runtime role. Role creation and grants run in one transaction, so an error rolls back the new role. It grants database `CONNECT`, assistant schema `USAGE`, operational-table DML and migration-version `SELECT`; it also removes public schema-creation privileges only in this checked new database. The role has no elevated flags or memberships, cannot create app/public tables, and has a six-connection role limit for deployment overlap. Future tables need explicit reviewed grants. Repeating bootstrap does not rotate a password or change an existing role.

After successful bootstrap, remove `RUNTIME_ROLE_BOOTSTRAP` and `RUNTIME_DATABASE_PASSWORD` from the migrator, restore its ordinary migration command, and suspend it between deliberate runs. Construct the runtime URL privately using the new independent database host/name, `sales_agent_runtime` and that password; inject it only as the web service's `DATABASE_URL`. Production runtime rejects bootstrap secrets/mode. Password rotation is a separate deliberate operation. The script never provisions or modifies a Loyalty target.

Password storage follows [PostgreSQL 16 SCRAM authentication](https://www.postgresql.org/docs/16/auth-password.html) and [CREATE ROLE's precomputed verifier support](https://www.postgresql.org/docs/16/sql-createrole.html); SCRAM key derivation follows [RFC 5802](https://www.rfc-editor.org/rfc/rfc5802).

The small pilot defaults to **2 pooled connections per process** (`DB_POOL_MAX`, range 1–10). `DB_CONNECTION_TIMEOUT_MS` defaults to 5,000 (range 1,000–30,000); `DB_QUERY_TIMEOUT_MS` defaults to 10,000 (range 1,000–60,000), applied to client queries and PostgreSQL statements. The migration job uses one connection. Include all replicas, CLI tasks and migration jobs in the connection budget. These limits do not establish that the existing instance has enough CPU/memory/storage; inspect shared usage before loading or scaling the pilot.

Missing credentials keep `/readyz` at 503. `/healthz` is process liveness. Neither means a store is installed or OpenAI requests have passed. Synthetic test credentials must never be used in production. Full OAuth URLs, response bodies, API keys and conversation text must be excluded from reverse-proxy/hosting request logs as well as app logs.

## Limits and failure behavior

- Body 32 KB, message 2,000 characters, up to 30 submitted turns per conversation, 30-minute conversation/token expiry.
- Up to two structured model requests per normal shopping turn, each with 1,000 output-token cap and 12-second timeout. 2,000 turns/shop/UTC day cap is up to 4,000 model requests, not a currency spending limit. Set the OpenAI project's monetary budget separately before pilot.
- PostgreSQL atomically controls per-shop budget and conversation concurrency across replicas. Per-process IP throttling is supplementary; a hosting edge/WAF should provide shared IP protections at scale. Proxy forwarded IPs are not blindly trusted.
- Provider failure produces a fixed unavailable message. No made-up fallback catalog, discounts or claims.
- Cart operations are serialized, never blindly retried, and reread Shopify state. When mutation result is ambiguous, ask the shopper to refresh the cart before trying again.

## Knowledge approvals

Every fact has shop, product ID or null (brand-level), locale, exact approved text, source, approver, approval timestamp, status and optional expiry. Approval is an editorial/merchant action; adding a source URL alone does not approve claims. Keep claims supported for the relevant market and locale. Source records are for traceability, not model instructions. Pilot product images are withheld until text inside the images is approved. Live availability is not a nutrition approval.

## Consent and measurement

The widget waits for Shopify Customer Privacy state. Denied/unknown analytics consent yields operational ephemeral sessions without experiment enrollment or analytics collection. A/B uses a consented anonymous visitor ID, shop and experiment version. Both arms publish exposure. On revocation, stop sending events, revoke server session measurement and erase the visitor ID.

Pixel collector credential is public and permits analytics ingestion only; it is not merchant authentication. Client telemetry is susceptible to spoofing/ad blockers. Collector payloads are allowlisted, bounded, and duplicate IDs/order observations are ignored. Unlinked checkouts are discarded. Public collector health and shared quota must be monitored. Do not treat browser telemetry as accounting evidence.

Before A/B enablement, verify control and treatment on the same consent basis, sample-ratio mismatch, refresh persistence, Shopify checkout domain/clientId continuity, duplicates, consent withdrawal and no-consent coverage. Pixel `checkout_completed` is mapped to `purchase`, but it does not guarantee payment settlement. Delayed order-webhook reconciliation is outside this release.

Conversation history is encrypted and short-lived. Analytics contains no transcript or health-intent field. Customer ID, customer email and logged_in_customer_id are not stored. Retention cleanup runs at startup and every minute; monitor failures. Events are retained 90 days, pixel assignments one day, webhook dedup records seven days. Complete the merchant's privacy review and retention decision before launch.

## Go-live evidence

- Complete real app OAuth, reinstall and uninstall; webhook HMAC delivery and privacy redaction.
- Verify live Storefront catalog publication/access for this app and GR/CY price/currency. Translate follow-up queries EL/EN.
- Enable embed only in a dedicated unpublished Nutri Tiger theme. Check desktop/mobile, keyboard, focus, Escape, theme cart/drawer count, supported variants and unsupported subscriptions/bundles.
- Verify sold-out/backorder behavior against true Shopify inventory. For positive add/update/checkout use an agreed real/test product; never add fake inventory to production.
- Verify one real provider call and adversarial prompts with approved knowledge; install missing facts deliberately gives no factual nutrition answer.
- Verify standard checkout_started/checkout_completed plus custom widget events with Shopify test payment mode and merchant coordination. Do not perform an actual charged purchase as a smoke test.
- Exercise outage, price change between card/action, session expiry, signature tampering and repeated click; confirm usable ordinary storefront when disabled.
- Deploy a rollback image and restore DB backup in staging, then explicitly approve live embed enablement.

## Rollback

Disable the app embed in theme settings immediately. Alternatively set `config.enabled=false` and sync that tenant file; new proxy requests fail closed. Roll back backend image without destructive migrations. Deleting app installation revokes credentials and operational conversations. Never publish an unrelated theme to roll back this assistant.
