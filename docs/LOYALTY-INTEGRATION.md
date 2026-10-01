# Reusing Kooqie Loyalty infrastructure

Research date: 1 October 2026. The user asked us to reuse existing infrastructure where practical. This document records read-only findings and a deployment recommendation; it does not authorize or record a deployment, database change, credential change, or modification of Kooqie Loyalty.

## Evidence and limits

The root agent inspected the authenticated GitHub repository and Render dashboard. Repository evidence below is based on that direct UI inspection, relayed to this research agent. The GitHub connector returned 404 for the repository, and noninteractive local Git had no usable GitHub credentials. Those errors indicate unavailable access through those routes, not missing source files. This agent did not read `.env`, credentials, connection URLs, customer rows, or secret values.

Repository: [ioannidisang/kooqie-loyalty](https://github.com/ioannidisang/kooqie-loyalty). Render's deployed revision and the inspected current source matched `541365d4b9d453ec077ba4eaa6797c43cc20eb25`.

| Item | Root-verified finding | What it establishes |
| --- | --- | --- |
| Application stack | README describes Node 24, TypeScript, React Router, Prisma, PostgreSQL 16 | The projects share the Node/TypeScript/PostgreSQL foundation; their HTTP frameworks and persistence layers differ. |
| Web service | Docker, Render Starter, Frankfurt; automatic deployment off; `/healthz` | Existing deployment and operational patterns are suitable references for the assistant. |
| Application database identity | `DATABASE_URL` is configured separately with `sync: false`; intended runtime role `kooqie_loyalty_app` | The Loyalty runtime is designed to avoid using its migration owner connection. |
| Migrator | Separate Render cron resource runs `npm run migrate:render:production`; receives `DIRECT_DATABASE_URL` from the database connection reference and a restricted `DATABASE_URL` | Migration privileges and normal application access are intentionally separated. |
| Database guard | `EXPECTED_DATABASE_NAME=kooqie_loyalty_production` | Loyalty's migration workflow has an explicit target-database guard. |
| Tenant protection | README documents forced row-level security and `withTenant` | RLS is a documented design requirement. Actual policies and grants were not inspected in the live database. |
| Database resource | PostgreSQL 16, Basic 256 MB, 0.1 CPU, Frankfurt; logical database `kooqie_loyalty_production`; owner `kooqie_loyalty_owner` | The current resource is a small existing production instance, not unused dedicated assistant capacity. |
| Storage/network configuration | 1 GB, storage autoscaling off, configured connection pool `none`, external IP allowlist empty | Storage is bounded; the Blueprint does not provision a separate connection pool and limits external access. Actual application pool settings were not read. |
| Dashboard observation | Storage usage 8.57%; database compute displayed as $6/month | This is a point-in-time storage observation and price reference. It does not establish CPU, memory, I/O or connection headroom. |
| Metrics | The last-12-hour view did not provide captured workload data during inspection | Missing displayed metrics are not evidence of an idle or empty database. |

Source references: [README at inspected revision](https://github.com/ioannidisang/kooqie-loyalty/blob/541365d4b9d453ec077ba4eaa6797c43cc20eb25/README.md), [production Blueprint at inspected revision](https://github.com/ioannidisang/kooqie-loyalty/blob/541365d4b9d453ec077ba4eaa6797c43cc20eb25/render.production.yaml). These links require repository access.

The complete Loyalty Prisma models, table list, applied migration history, live grants, RLS policies, runtime connection count and database load remain unverified. No assumption about those details is needed to integrate through separate application infrastructure.

## Recommended deployment boundary

Reuse the Render workspace, Frankfurt region, GitHub/Docker delivery workflow, operational conventions and private network. Give the sales assistant its own web service, Shopify app identity, credentials, configuration, deployment lifecycle and rollback. Do not insert it into the running Loyalty web process or reuse Loyalty's Shopify OAuth identity: that would couple two applications and require changes to the Loyalty application.

For the first production pilot, prefer a separate assistant PostgreSQL instance. The observed reference cost is approximately $6.30/month for a database with the same compute/storage size ($6 compute plus $0.30 storage); this is a planning comparison, not a quote or a newly created charge. It excludes assistant web-service compute and OpenAI usage. Verify the displayed price when provisioning. Independent database compute avoids consuming unmeasured headroom on the existing 256 MB Loyalty production instance and makes maintenance and recovery independent.

If the user chooses to reuse the existing physical PostgreSQL instance, use a **separate logical database and dedicated assistant roles**, subject to measured headroom and a successful staging exercise. Render supports additional logical databases within one instance. Such databases share host resources and failure/recovery boundaries, so logical separation does not provide compute isolation. [Render database configuration](https://render.com/docs/postgresql-creating-connecting#adding-multiple-databases-to-a-single-instance)

## What can be reused safely

- Node 24 Docker build/deploy conventions, health checks, explicit deployment control and the existing region.
- The runtime/migrator separation pattern and an explicit expected-database-name check, implemented for this repository's SQL migrations.
- Render private networking between same-account services in the same region. The assistant should use its own database credentials over the internal connection. [Render private network](https://render.com/docs/private-network)
- Operational practices for backups, health monitoring and rollback, with separate assistant ownership and recovery checks.

Prisma migrations and `withTenant` are Loyalty-specific implementations. Do not copy or execute them against the assistant database. The assistant currently uses `pg`/PGlite and its own `sales_agent` schema. Its tenant predicates and lifecycle controls need their own tests; Loyalty's RLS documentation does not establish protection for assistant tables.

## Separation required even when sharing a physical instance

1. Create a new logical assistant database with an explicit name and database-name guard. Keep the `sales_agent` application schema inside it. Never point assistant migration tooling at `kooqie_loyalty_production`.
2. Use independent assistant runtime and migration identities. The runtime gets access only to assistant objects and normal application operations. Migration credentials are available only to the assistant migration job. Neither identity inherits the Loyalty application/owner roles.
3. Preserve Loyalty's existing database, users, grants, RLS policies, migration workflow and connection configuration. Verify denial of cross-application object access rather than relying only on `search_path`.
4. Keep application secrets and encrypted token stores independent. Sharing a PostgreSQL host does not imply sharing Shopify tokens, encryption keys, knowledge, conversations, events or customer identities.
5. Bound assistant connections and workload. The local implementation is being adjusted to a default pool of two connections per replica. Budget for overlapping deployments, migration connections, Loyalty's existing pools and operational access. Query actual connection limits and usage before deciding capacity; do not infer them from storage occupancy. [Render connection pooling](https://render.com/docs/postgresql-connection-pooling)
6. Test migrations, retention, tenant deletion, backup and restore on isolated assistant data before enabling real traffic. An instance-level restore or outage still affects both applications if the host is shared.

Do not use Render's **New default credential** flow merely to obtain an isolated assistant role. Render-managed credential creation changes the database's default user and can update Blueprint-referenced connection values on synchronization. Directly created PostgreSQL roles are managed separately and do not replace that default. Role creation and grants require a deliberate provisioning step; none were performed during this review. [Render credential management](https://render.com/docs/postgresql-credentials)

## Current decision

The common platform and deployment practices are reusable now. Shared physical database capacity is not yet established. Prepare the assistant for independent runtime/migrator roles and bounded connection usage, then provision either a separate database instance by default or an isolated logical database on the existing instance after headroom verification. Keep the Loyalty application unchanged throughout this pilot preparation.
