import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface Database {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  purpose?: 'runtime' | 'migration' | 'provision';
  expectedDatabase?: string;
  poolMax?: number;
  connectionTimeoutMs?: number;
  queryTimeoutMs?: number;
}

export const DATABASE_SCHEMA_VERSION = 3;

function boundedInteger(name: string, value: string | number | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
}

export function readDatabaseOptions(env: NodeJS.ProcessEnv = process.env): DatabaseOptions {
  return {
    poolMax: boundedInteger('DB_POOL_MAX', env.DB_POOL_MAX, 2, 1, 10),
    connectionTimeoutMs: boundedInteger('DB_CONNECTION_TIMEOUT_MS', env.DB_CONNECTION_TIMEOUT_MS, 5000, 1000, 30000),
    queryTimeoutMs: boundedInteger('DB_QUERY_TIMEOUT_MS', env.DB_QUERY_TIMEOUT_MS, 10000, 1000, 60000),
  };
}

export async function verifyDatabaseReady(db: Database): Promise<void> {
  try {
    const role = await db.query<{ elevated: boolean }>(`SELECT (
      rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR
      EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='sales_agent' AND pg_has_role(current_user,nspowner,'MEMBER')) OR
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='sales_agent' AND pg_has_role(current_user,c.relowner,'MEMBER')) OR
      has_schema_privilege(current_user,'sales_agent','CREATE')
    ) AS elevated FROM pg_roles WHERE rolname=current_user`);
    if (!role.rows.length || role.rows[0]!.elevated) throw new Error('Runtime role must be restricted');
    const result = await db.query<{ version: number }>('SELECT version FROM sales_agent.schema_migrations WHERE version=$1', [DATABASE_SCHEMA_VERSION]);
    if (!result.rows.length) throw new Error('Schema version missing');
    const access = await db.query<{ ready: boolean }>(`SELECT bool_and(has_table_privilege(current_user,'sales_agent.'||table_name,'SELECT') AND has_table_privilege(current_user,'sales_agent.'||table_name,'INSERT') AND has_table_privilege(current_user,'sales_agent.'||table_name,'UPDATE') AND has_table_privilege(current_user,'sales_agent.'||table_name,'DELETE')) AS ready FROM unnest(ARRAY['shops','conversations','usage_buckets','events','pixel_assignments','webhooks','experiment_specs','eligible_exposures','model_usage','avatar_sessions']) AS table_name`);
    if (!access.rows[0]?.ready) throw new Error('Runtime grants missing');
  } catch {
    throw new Error('sales_agent schema is not ready or runtime role is not restricted; verify scoped grants and run the separate migration deployment first');
  }
}

export async function openDatabase(url?: string, localPath = '.data/postgres', options: DatabaseOptions = {}): Promise<Database> {
  const defaults = readDatabaseOptions();
  const poolMax = boundedInteger('DB_POOL_MAX', options.poolMax ?? defaults.poolMax, 2, 1, 10);
  const connectionTimeoutMs = boundedInteger('DB_CONNECTION_TIMEOUT_MS', options.connectionTimeoutMs ?? defaults.connectionTimeoutMs, 5000, 1000, 30000);
  const queryTimeoutMs = boundedInteger('DB_QUERY_TIMEOUT_MS', options.queryTimeoutMs ?? defaults.queryTimeoutMs, 10000, 1000, 60000);
  if (url) {
    const privileged = options.purpose === 'migration' || options.purpose === 'provision';
    if (privileged && (!options.expectedDatabase || options.expectedDatabase.length > 128)) {
      throw new Error('MIGRATION_EXPECTED_DATABASE is required for migration');
    }
    // All unqualified application SQL must stay outside other apps' tables. node-postgres
    // lets connection-string options override Pool options, so pin both to the same schema.
    let connectionUrl: URL;
    try { connectionUrl = new URL(url); }
    catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL'); }
    if (!['postgres:', 'postgresql:'].includes(connectionUrl.protocol)) throw new Error('DATABASE_URL must use PostgreSQL');
    const startupOptions = `-c search_path=sales_agent -c statement_timeout=${queryTimeoutMs}`;
    connectionUrl.searchParams.set('options', startupOptions);
    connectionUrl.searchParams.set('statement_timeout', String(queryTimeoutMs));
    connectionUrl.searchParams.set('query_timeout', String(queryTimeoutMs));
    const pool = new pg.Pool({ connectionString: connectionUrl.toString(), options: startupOptions, max: poolMax, connectionTimeoutMillis: connectionTimeoutMs, statement_timeout: queryTimeoutMs, query_timeout: queryTimeoutMs });
    const adapter: Database = { query: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => ({ rows: (await pool.query<T>(sql, params)).rows }), close: () => pool.end() };
    try {
      if (privileged) {
        const target = await pool.query<{ database: string }>('SELECT current_database() AS database');
        if (target.rows[0]?.database !== options.expectedDatabase) throw new Error('Unexpected migration database');
        if (options.purpose === 'migration') await pool.query('CREATE SCHEMA IF NOT EXISTS sales_agent');
      }
      else await verifyDatabaseReady(adapter);
    } catch {
      await pool.end();
      throw new Error(privileged
        ? 'Unable to initialize sales_agent schema; check expected database, migration connectivity and owner privileges'
        : 'sales_agent schema is not ready or runtime role is not restricted; verify scoped grants and run the separate migration deployment first');
    }
    return adapter;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL required in production');
  const db = new PGlite(localPath);
  await db.waitReady;
  try {
    await db.query('CREATE SCHEMA IF NOT EXISTS sales_agent');
    await db.query('SET search_path TO sales_agent');
  } catch { await db.close(); throw new Error('Unable to initialize the local sales_agent database schema'); }
  const adapter: Database = { query: (sql, params) => db.query(sql, params), close: () => db.close() };
  try { await migrate(adapter); }
  catch { await db.close(); throw new Error('Unable to migrate the local sales_agent database schema'); }
  return adapter;
}

export async function migrate(db: Database): Promise<void> {
  // Explicit owner-only production deployment; local PGlite invokes this automatically.
  // Additive, idempotent statements. Serialize deployment migrations before starting replicas.
  const statements = [
    `CREATE TABLE IF NOT EXISTS shops (shop TEXT PRIMARY KEY, config JSONB NOT NULL, credentials TEXT NOT NULL, facts JSONB NOT NULL DEFAULT '[]', active BOOLEAN NOT NULL DEFAULT true, installed_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS conversations (shop TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE, id UUID NOT NULL, history TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, turns INTEGER NOT NULL DEFAULT 0, busy_until TIMESTAMPTZ, consent BOOLEAN NOT NULL, assignment TEXT NOT NULL, experiment_id TEXT NOT NULL, PRIMARY KEY(shop,id))`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS visitor_hash TEXT`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS config_fingerprint TEXT`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS provider TEXT`,
    `CREATE TABLE IF NOT EXISTS avatar_sessions (id UUID PRIMARY KEY, shop TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE, conversation_id UUID NOT NULL, claims JSONB NOT NULL, credential_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('starting','active','ending','ended','failed')), expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), provider_pal_id TEXT, provider_conversation_id TEXT, result TEXT, sequence INTEGER NOT NULL DEFAULT 0, last_request_hash TEXT, busy_until TIMESTAMPTZ)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS avatar_one_active_shop ON avatar_sessions(shop) WHERE state IN ('starting','active','ending')`,
    `CREATE INDEX IF NOT EXISTS avatar_expiry ON avatar_sessions(expires_at)`,
    `CREATE TABLE IF NOT EXISTS usage_buckets (shop TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE, bucket TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(shop,bucket))`,
    `CREATE TABLE IF NOT EXISTS events (shop TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE, id TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL, conversation_id UUID, client_hash TEXT, experiment_id TEXT, assignment TEXT, metadata JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(shop,source,id))`,
    `CREATE TABLE IF NOT EXISTS pixel_assignments (shop TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE, client_hash TEXT NOT NULL, experiment_id TEXT NOT NULL, assignment TEXT NOT NULL, conversation_id UUID NOT NULL, expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(shop,client_hash,experiment_id))`,
    `ALTER TABLE events ADD COLUMN IF NOT EXISTS visitor_hash TEXT`,
    `ALTER TABLE pixel_assignments ADD COLUMN IF NOT EXISTS visitor_hash TEXT`,
    `ALTER TABLE pixel_assignments ADD COLUMN IF NOT EXISTS ambiguous BOOLEAN NOT NULL DEFAULT false`,
    `CREATE TABLE IF NOT EXISTS experiment_specs (shop TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE, experiment_id TEXT NOT NULL, config_fingerprint TEXT NOT NULL, specification JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(shop,experiment_id))`,
    `CREATE TABLE IF NOT EXISTS eligible_exposures (shop TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE, experiment_id TEXT NOT NULL, visitor_hash TEXT NOT NULL, assignment TEXT NOT NULL, config_fingerprint TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(shop,experiment_id,visitor_hash))`,
    `CREATE TABLE IF NOT EXISTS model_usage (shop TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE, day DATE NOT NULL, experiment_id TEXT NOT NULL, assignment TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, knowledge_version TEXT NOT NULL, config_fingerprint TEXT NOT NULL, operation TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, successful_requests INTEGER NOT NULL DEFAULT 0, input_tokens BIGINT NOT NULL DEFAULT 0, output_tokens BIGINT NOT NULL DEFAULT 0, unknown_token_requests INTEGER NOT NULL DEFAULT 0, duration_ms BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(shop,day,experiment_id,assignment,provider,model,knowledge_version,config_fingerprint,operation))`,
    `CREATE TABLE IF NOT EXISTS webhooks (shop TEXT NOT NULL, id TEXT NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(shop,id))`,
    `CREATE INDEX IF NOT EXISTS events_experiment ON events(shop,experiment_id,assignment,name)`,
    `CREATE INDEX IF NOT EXISTS conversations_expiry ON conversations(expires_at)`,
    `CREATE INDEX IF NOT EXISTS conversations_visitor ON conversations(shop,visitor_hash)`,
    `CREATE INDEX IF NOT EXISTS events_expiry ON events(created_at)`,
    `CREATE INDEX IF NOT EXISTS events_visitor ON events(shop,visitor_hash)`,
    `CREATE INDEX IF NOT EXISTS eligible_exposures_expiry ON eligible_exposures(created_at)`,
    `CREATE INDEX IF NOT EXISTS pixel_assignments_expiry ON pixel_assignments(expires_at)`,
    `CREATE INDEX IF NOT EXISTS pixel_assignments_conversation ON pixel_assignments(shop,conversation_id)`,
    `CREATE INDEX IF NOT EXISTS webhooks_expiry ON webhooks(received_at)`,
    `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sales_agent_runtime') THEN GRANT SELECT,INSERT,UPDATE,DELETE ON sales_agent.experiment_specs,sales_agent.eligible_exposures,sales_agent.model_usage,sales_agent.avatar_sessions TO sales_agent_runtime; END IF; END $$`,
    `INSERT INTO schema_migrations(version) VALUES(${DATABASE_SCHEMA_VERSION}) ON CONFLICT DO NOTHING`,
  ];
  for (const sql of statements) await db.query(sql);
}

export async function takeBudget(db: Database, shop: string, bucket: string, limit: number): Promise<boolean> {
  const { rows } = await db.query(`INSERT INTO usage_buckets(shop,bucket,count) VALUES($1,$2,1)
    ON CONFLICT(shop,bucket) DO UPDATE SET count=usage_buckets.count+1 WHERE usage_buckets.count < $3 RETURNING count`, [shop, bucket, limit]);
  return rows.length === 1;
}

export async function purgeExpired(db: Database): Promise<void> {
  await db.query("UPDATE avatar_sessions SET result=NULL WHERE expires_at<now() OR state IN ('ended','failed')");
  await db.query("DELETE FROM avatar_sessions WHERE state IN ('ended','failed') AND expires_at<now()-interval '1 day'");
  await db.query('DELETE FROM conversations WHERE expires_at < now()');
  await db.query('DELETE FROM pixel_assignments WHERE expires_at < now()');
  await db.query("DELETE FROM events WHERE created_at < now() - interval '90 days'");
  await db.query("DELETE FROM eligible_exposures WHERE created_at < now() - interval '90 days'");
  await db.query("DELETE FROM model_usage WHERE day < current_date - 90");
  await db.query("DELETE FROM webhooks WHERE received_at < now() - interval '7 days'");
  // Buckets are prefixed with UTC date. Keep two days for diagnostics.
  await db.query("DELETE FROM usage_buckets WHERE left(bucket,10) < to_char(now() - interval '2 days','YYYY-MM-DD')");
}
