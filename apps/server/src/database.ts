import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface Database {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  purpose?: 'runtime' | 'migration';
  expectedDatabase?: string;
  poolMax?: number;
  connectionTimeoutMs?: number;
  queryTimeoutMs?: number;
}

export const DATABASE_SCHEMA_VERSION = 1;

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
    if (options.purpose === 'migration' && (!options.expectedDatabase || options.expectedDatabase.length > 128)) {
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
      if (options.purpose === 'migration') {
        const target = await pool.query<{ database: string }>('SELECT current_database() AS database');
        if (target.rows[0]?.database !== options.expectedDatabase) throw new Error('Unexpected migration database');
        await pool.query('CREATE SCHEMA IF NOT EXISTS sales_agent');
      }
      else await verifyDatabaseReady(adapter);
    } catch {
      await pool.end();
      throw new Error(options.purpose === 'migration'
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
    `CREATE TABLE IF NOT EXISTS usage_buckets (shop TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE, bucket TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(shop,bucket))`,
    `CREATE TABLE IF NOT EXISTS events (shop TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE, id TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL, conversation_id UUID, client_hash TEXT, experiment_id TEXT, assignment TEXT, metadata JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(shop,source,id))`,
    `CREATE TABLE IF NOT EXISTS pixel_assignments (shop TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE, client_hash TEXT NOT NULL, experiment_id TEXT NOT NULL, assignment TEXT NOT NULL, conversation_id UUID NOT NULL, expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(shop,client_hash,experiment_id))`,
    `CREATE TABLE IF NOT EXISTS webhooks (shop TEXT NOT NULL, id TEXT NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(shop,id))`,
    `CREATE INDEX IF NOT EXISTS events_experiment ON events(shop,experiment_id,assignment,name)`,
    `CREATE INDEX IF NOT EXISTS conversations_expiry ON conversations(expires_at)`,
    `CREATE INDEX IF NOT EXISTS conversations_visitor ON conversations(shop,visitor_hash)`,
    `CREATE INDEX IF NOT EXISTS events_expiry ON events(created_at)`,
    `CREATE INDEX IF NOT EXISTS pixel_assignments_expiry ON pixel_assignments(expires_at)`,
    `CREATE INDEX IF NOT EXISTS pixel_assignments_conversation ON pixel_assignments(shop,conversation_id)`,
    `CREATE INDEX IF NOT EXISTS webhooks_expiry ON webhooks(received_at)`,
    `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
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
  await db.query('DELETE FROM conversations WHERE expires_at < now()');
  await db.query('DELETE FROM pixel_assignments WHERE expires_at < now()');
  await db.query("DELETE FROM events WHERE created_at < now() - interval '90 days'");
  await db.query("DELETE FROM webhooks WHERE received_at < now() - interval '7 days'");
  // Buckets are prefixed with UTC date. Keep two days for diagnostics.
  await db.query("DELETE FROM usage_buckets WHERE left(bucket,10) < to_char(now() - interval '2 days','YYYY-MM-DD')");
}
