# Independent Render deployment

Status: approved independent hosting setup, 1 October 2026. The private repository `ioannidisang/shopify-ai-sales-agent` and the assistant PostgreSQL resource below have been created. This document and the concrete `deploy/render.production.yaml` prepare the remaining service setup; they do not establish successful migrations, role provisioning or a healthy API deployment. No credentials are stored in either deployment file. `deploy/render.production.yaml.example` remains a reusable example with intentional placeholders.

The pilot uses an independent assistant web service, its own PostgreSQL instance and a separate migration job in Frankfurt. Nutri Tiger remains the only allowed shop. No resource reference points to Kooqie Loyalty; that application, its database and its grants remain independent.

## Selected resources

| Resource | Selected identity |
| --- | --- |
| Private repository | `https://github.com/ioannidisang/shopify-ai-sales-agent` |
| Release branch | `codex/shopify-ai-sales-agent` |
| Web service | `shopify-ai-sales-agent` |
| Migrator | `shopify-ai-sales-agent-migrator` |
| Existing Render database | `shopify-ai-sales-agent-db` |
| Verified database resource ID | `dpg-dauvg4o473hc73crqerg-a` |
| Logical database / owner | `sales_agent_production` / `sales_agent_owner` |

The database already exists: PostgreSQL 16, Frankfurt, `basic-256mb`, 1 GB, with external IP access removed. **Reuse this resource; do not create a second database.** The concrete Blueprint deliberately omits a `databases` block and references the existing database by name only from the migrator. Confirm that Render resolves the name to the verified resource ID before applying it. If services were created through the UI, import/reconcile those exact services rather than creating duplicates. The reusable `.example` file describes a fresh deployment and must not be applied unchanged to this setup.

## Resources and cost

| Resource | Proposed configuration | Monthly baseline |
| --- | --- | ---: |
| Assistant API | One paid Starter Docker web instance, Frankfurt | $7.00 |
| Assistant PostgreSQL | `basic-256mb`, PostgreSQL 16, Frankfurt | $6.00 |
| PostgreSQL storage | 1 GB; storage autoscaling disabled | $0.30 |
| Isolated migrator | Starter Docker cron; occasional short executions | $1.00 minimum |
| Total | Pilot baseline | **$14.30** |

This is the approved planning baseline for this setup, excluding taxes, workspace charges, overages and OpenAI API usage. Confirm billed plans match the selected resources. Cron charges increase with active runtime above the monthly minimum. [Render pricing](https://render.com/pricing), [cron billing](https://render.com/docs/cronjobs#compute-plans-and-billing).

The current Render schema accepts `starter` and `basic-256mb`; newer documentation also shows numeric compute identifiers. The example pins PostgreSQL 16 and 1 GB explicitly. An empty database `ipAllowList` blocks public database connections; the service and migrator use same-region internal connectivity. No persistent web disk or Redis service is required. [Blueprint reference](https://render.com/docs/blueprint-spec), [database connectivity](https://render.com/docs/postgresql-creating-connecting).

## Runtime and migration separation

| Process | Docker command | Database credential |
| --- | --- | --- |
| Web service | `node dist/apps/server/src/index.js` | `DATABASE_URL`: dedicated assistant runtime role, DML only |
| Migrator | `node dist/apps/server/src/migrate.js` | `MIGRATION_DATABASE_URL`: owner of this new assistant database/schema |

The concrete Blueprint references the existing assistant database owner connection only from the migrator. It intentionally prompts for the web service's separately provisioned runtime connection. Do not copy the owner connection into `DATABASE_URL`, attach a shared owner environment group to the web service, or pass credentials as command-line arguments.

Production startup verifies the existing `sales_agent.schema_migrations` version; it does not perform schema DDL. It rejects owner/elevated runtime roles, schema creation privileges, and a migration URL in the runtime environment. The migration entry point uses a pool of one and explicitly initializes/migrates `sales_agent`. The application pins `search_path` to that schema. Database privileges must independently enforce the boundary: runtime needs `CONNECT`, schema `USAGE`, and the necessary `SELECT/INSERT/UPDATE/DELETE` rights on assistant objects; it must not own the database/schema or have schema creation privileges. Future tables need explicit reviewed grants; the bootstrap does not grant blanket access to future objects.

The concrete migration guard is `MIGRATION_EXPECTED_DATABASE=sales_agent_production`; the migrator checks it against `current_database()` before any schema creation. Verify `current_database()` and `current_user` using a controlled provider session before migration, with the selected assistant identities. Never target `kooqie_loyalty_production`. The migration command does not itself provision the runtime role or its password; use the separate one-time command below after migration.

## Intentional deployment sequence

1. Use `deploy/render.production.yaml` for the selected repository/branch. Confirm every proposed change refers only to the selected assistant services and that the database reference resolves to `dpg-dauvg4o473hc73crqerg-a`. Do not submit the fresh-deployment `.example` or create another database. Coordinate any Blueprint import with the services already created through the UI.
2. Run `pnpm check` and build the Docker image on a Docker-capable host. The Dockerfile also runs the checks. The local Windows environment has not established a successful production Docker build or Render deployment.
3. Validate the concrete Blueprint with Render's current schema and provider validator. Reuse the existing assistant database and keep external access denied. The web service fails closed until its schema and restricted connection are ready; do not route store traffic to that initial attempt. Even with the database ready, `/readyz` returns 503 until the required Shopify/OpenAI and application secrets are supplied, so an initially unhealthy Render deployment is expected during incomplete setup.
4. Supply only the migrator's database owner credential and the exact expected database name. Build its approved release and trigger one migration run. Verify completion, then run the one-time runtime-role bootstrap below. Ensure there is no other active migration process. Repeated migrations are additive/idempotent, but deployment coordination remains required.
5. Supply the web secrets listed below and manually deploy the same reviewed revision. Check `/healthz` for process liveness and `/readyz` for database readiness. Startup/readiness does not prove Shopify installation, OpenAI access or product grounding are working.
6. Configure the Shopify application URLs/proxy for the deployed HTTPS origin, install only on the pilot store, and follow `INSTALLATION.md`. Verify real catalog reads, approved knowledge, privacy, both experiment arms and the actual theme Ajax cart in an unpublished theme preview. A live theme still requires explicit publication approval.
7. After each future approved revision: build/run the isolated migrator, verify grants/schema readiness, then manually deploy the web service. Retain the previous compatible image/revision and a tested database recovery path.

Automatic code deployment is disabled using `autoDeployTrigger: off`. That does **not** disable cron execution. The example includes a required annual UTC cron expression because Render has no manual-only schedule in the Blueprint schema. Suspend scheduled migrator execution between intentional releases; resume/trigger only as required and suspend afterward. Do not leave an owner-privileged migration schedule running unattended. Triggering a cron run while one is active cancels the active run, so inspect job state first. [Cron scheduling and manual runs](https://render.com/docs/cronjobs).

## One-time runtime-role bootstrap

After a successful migration on the selected new database, temporarily configure the isolated migrator with `RUNTIME_ROLE_BOOTSTRAP=true` and `RUNTIME_DATABASE_PASSWORD` set through Render's secret environment to a separately generated random value of 32–256 URL-safe ASCII characters (`A–Z`, `a–z`, digits, `_`, `-`). Retain its `MIGRATION_DATABASE_URL` and `MIGRATION_EXPECTED_DATABASE=sales_agent_production`. Do not add the temporary password/mode to the Blueprint or the web service.

Run this command once in the migration environment:

```sh
node dist/apps/server/src/provision-runtime.js
```

The local package-script equivalent is `pnpm db:provision-runtime`. The command creates the fixed `sales_agent_runtime` role and grants access only to the current assistant tables, with read-only schema-version access and a six-connection role limit. It refuses existing roles, incorrect target names and unrelated application tables. It sends a SCRAM verifier to PostgreSQL and does not print the plaintext password, connection URL or SQL. Do not interpret refusal of an existing role as authorization to drop/recreate it.

After success, set the web service's `DATABASE_URL` to the **internal endpoint of this same database**, using `sales_agent_runtime` and the generated password. Remove `RUNTIME_ROLE_BOOTSTRAP` and `RUNTIME_DATABASE_PASSWORD` from the migrator. Restore its Docker command to `node dist/apps/server/src/migrate.js` if temporarily changed, and suspend scheduled execution again. Confirm runtime startup accepts the restricted role before serving traffic. This provisioning step has not been marked complete by the presence of these files.

## Environment values

`.env.example` is the application contract. The web service needs `APP_URL` set to its exact HTTPS origin, the Shopify app key/secret, scoped runtime `DATABASE_URL`, `ENCRYPTION_KEY`, `SESSION_SECRET` and `OPENAI_API_KEY`. The template supplies the shop allowlist, scopes, model choice, production mode, port and bounded database settings. Confirm model access with a real API request before enabling the pilot.

Generate `ENCRYPTION_KEY` as 32 random bytes encoded in base64 and `SESSION_SECRET` independently with at least 32 random characters. Preserve encryption keys across deployments and back up their recovery procedure separately; changing the encryption key makes existing encrypted credentials unreadable. Store all values in Render's secret configuration, never source control, build arguments, screenshots or logs. The migrator receives no Shopify, session, encryption or OpenAI secret.

The `sync: false` fields prompt for secret values during initial Blueprint creation; later additions require deliberate service configuration. Blueprint values do not support variable interpolation, so do not write `${...}` connection strings expecting Render to substitute them. [Environment variable behavior](https://render.com/docs/blueprint-spec#environment-variables).

## Pilot capacity and release limits

The runtime pool is capped at two connections per replica, with a five-second connection timeout and ten-second SQL query/statement timeout; the migrator uses one. The initial migrator also has a ten-second query timeout. A future longer migration requires a deliberately reviewed override within the application's 60-second maximum, or a revised migration strategy; do not raise runtime limits automatically. Budget at least five application connections for old/new web instances overlapping during a deploy plus a migrator, then reserve operational headroom. A small pool does not establish that the 256 MB database can handle the workload. Measure CPU, memory, connection wait, query latency, storage, model latency and error rates before increasing traffic.

Current application limits include 30 conversation turns per 30-minute session, at most 2,000 accepted conversation turns per shop per UTC day (up to two OpenAI planner requests per turn), 300 bootstraps per shop per minute and 3,000 collector attempts per shop per minute. These are application guards, not an OpenAI spend cap or a capacity guarantee. Expired conversations are purged on startup and each minute while the service runs; analytics events retain 90 days, webhook deduplication seven days. Monitor growth and retention performance within the explicit 1 GB allocation; storage does not autoscale.

This pilot configuration provides one web replica and one database instance, with no configured high-availability replica. Verify provider backups, restore an isolated staging copy, and establish storage/health alerting before relying on it for production availability. Shopify deployment publishes application configuration/extensions; it does not deploy this backend.

A shared existing database instance is a later alternative only after verifying its real connection headroom, memory/CPU/storage, query load, recovery impact and privileges. Use an independently named assistant logical database and separate runtime/migration roles. Namespace separation alone is insufficient, and this example intentionally provides no reference to the existing Loyalty database.

## Validation evidence

Both deployment files pass local YAML 1.2 parsing and Ajv 8.20 validation against Render's published JSON Schema (draft 2020-12), fetched on 1 October 2026. The reusable example defines two services and one new database; the concrete configuration defines two services and only references the existing database, with no database creation block. Checks also confirm no owner connection reference or `MIGRATION_DATABASE_URL` in the web service and the correct guarded migration target. Schema SHA-256: `57aa0a1ff9c3b2d0fcb91b790b7b285aef6397adb0c92930e6e601054444cfe5`.

Local validation is not provider validation, a Docker build result, role provisioning or a successful web-service deployment. Those checks remain separate from the database creation already verified. [Validated schema source](https://render.com/schema/render.yaml.json).
