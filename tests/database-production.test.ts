import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDatabase, readDatabaseOptions } from '../apps/server/src/database.js';
import { runMigrationsFromEnvironment } from '../apps/server/src/migrate.js';
import { readEnv } from '../apps/server/src/config.js';

const driver = vi.hoisted(() => ({ options: [] as Record<string, unknown>[], query: vi.fn(), end: vi.fn() }));
vi.mock('pg', () => ({ default: { Pool: class {
  constructor(options: Record<string, unknown>) { driver.options.push(options); }
  query(sql: string, params?: unknown[]) { return driver.query(sql, params); }
  end() { return driver.end(); }
} } }));

// Network calls are replaced by this local PostgreSQL engine. The runtime role has no DDL.
const engine = new PGlite();
const runtimeUrl = 'postgresql://test_runtime:fixture-secret@invalid.example/test?options=-c%20search_path%3Dpublic';

beforeAll(async () => {
  await engine.exec('CREATE SCHEMA sales_agent; SET search_path TO sales_agent');
  await migrate({ query: (sql, params) => engine.query(sql, params), close: async () => {} });
  await engine.exec(`CREATE ROLE sales_agent_runtime NOLOGIN;
    GRANT USAGE ON SCHEMA sales_agent TO sales_agent_runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON shops,conversations,usage_buckets,events,pixel_assignments,webhooks,experiment_specs,eligible_exposures,model_usage,avatar_sessions TO sales_agent_runtime;
    GRANT SELECT ON schema_migrations TO sales_agent_runtime`);
});
afterAll(async () => { await engine.close(); });
beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('DB_POOL_MAX', ''); vi.stubEnv('DB_CONNECTION_TIMEOUT_MS', ''); vi.stubEnv('DB_QUERY_TIMEOUT_MS', '');
  await engine.exec('RESET ROLE; SET ROLE sales_agent_runtime');
  driver.options.length = 0;
  driver.query.mockReset().mockImplementation((sql: string, params?: unknown[]) => engine.query(sql, params));
  driver.end.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('production migration/runtime separation', () => {
  it('opens with read-only readiness queries under a role that cannot alter the schema', async () => {
    const db = await openDatabase(runtimeUrl);
    try {
      expect(driver.query.mock.calls.every(([sql]) => /^SELECT\b/.test(sql))).toBe(true);
      expect(driver.query.mock.calls.some(([sql]) => /schema_migrations/.test(sql))).toBe(true);
      expect((await db.query<{ current_user: string }>('SELECT current_user')).rows[0]!.current_user).toBe('sales_agent_runtime');
      await expect(db.query('CREATE TABLE sales_agent.must_not_exist(id INTEGER)')).rejects.toThrow(/permission denied/i);
      expect(driver.options[0]).toMatchObject({ max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10000, query_timeout: 10000 });
      expect(new URL(String(driver.options[0]!.connectionString)).searchParams.get('options')).toBe('-c search_path=sales_agent -c statement_timeout=10000');
    } finally { await db.close(); }
  });

  it('fails closed without creating schema objects when readiness or runtime grants are missing', async () => {
    driver.query.mockResolvedValueOnce({ rows: [] });
    await expect(openDatabase(runtimeUrl)).rejects.toThrow('run the separate migration deployment first');
    expect(driver.query.mock.calls.every(([sql]) => /^SELECT\b/.test(sql))).toBe(true);
    expect(driver.end).toHaveBeenCalledOnce();
  });

  it('runs owner DDL only with the explicit migration URL and one migration connection', async () => {
    await engine.exec('RESET ROLE');
    const target=(await engine.query<{database:string}>('SELECT current_database() AS database')).rows[0]!.database;
    await runMigrationsFromEnvironment({ MIGRATION_DATABASE_URL: 'postgresql://test_owner:fixture-secret@invalid.example/test', MIGRATION_EXPECTED_DATABASE:target, DATABASE_URL: runtimeUrl });
    expect(new URL(String(driver.options[0]!.connectionString)).username).toBe('test_owner');
    expect(driver.options[0]!.max).toBe(1);
    expect(driver.query.mock.calls[0]?.[0]).toBe('SELECT current_database() AS database');
    expect(driver.query.mock.calls[1]?.[0]).toBe('CREATE SCHEMA IF NOT EXISTS sales_agent');
    expect(driver.query.mock.calls.some(([sql]) => /^ALTER TABLE conversations/.test(sql))).toBe(true);
    expect(driver.end).toHaveBeenCalledOnce();
  });

  it('rejects an unexpected migration database before executing any DDL',async()=>{
    await expect(runMigrationsFromEnvironment({MIGRATION_DATABASE_URL:runtimeUrl,MIGRATION_EXPECTED_DATABASE:'wrong_target'})).rejects.toThrow('expected database');
    expect(driver.query.mock.calls).toHaveLength(1);
    expect(driver.query.mock.calls[0]?.[0]).toBe('SELECT current_database() AS database');
    expect(driver.end).toHaveBeenCalledOnce();
  });

  it('rejects owner/elevated runtime credentials and migration credentials in runtime environment',async()=>{
    await engine.exec('RESET ROLE');
    await expect(openDatabase(runtimeUrl)).rejects.toThrow('runtime role is not restricted');
    expect(driver.query.mock.calls.every(([sql])=>/^SELECT\b/.test(sql))).toBe(true);
    vi.stubEnv('MIGRATION_DATABASE_URL','fixture-only-owner-credential');
    expect(()=>readEnv()).toThrow('Production runtime must not receive MIGRATION_DATABASE_URL');
  });

  it('never falls back to the runtime URL when migration credentials are absent', async () => {
    await expect(runMigrationsFromEnvironment({ DATABASE_URL: runtimeUrl })).rejects.toThrow('MIGRATION_DATABASE_URL is required');
    expect(driver.query).not.toHaveBeenCalled();
    expect(driver.options).toHaveLength(0);
  });

  it('bounds per-process connections and timeouts and honors validated configuration', async () => {
    expect(readDatabaseOptions({})).toEqual({ poolMax: 2, connectionTimeoutMs: 5000, queryTimeoutMs: 10000 });
    for (const env of [{ DB_POOL_MAX: '11' }, { DB_POOL_MAX: '0' }, { DB_CONNECTION_TIMEOUT_MS: '0' }, { DB_QUERY_TIMEOUT_MS: 'infinite' }, { DB_QUERY_TIMEOUT_MS: '60001' }]) {
      expect(() => readDatabaseOptions(env)).toThrow();
    }
    const db = await openDatabase(runtimeUrl, undefined, { poolMax: 1, connectionTimeoutMs: 2000, queryTimeoutMs: 7000 });
    await db.close();
    expect(driver.options[0]).toMatchObject({ max: 1, connectionTimeoutMillis: 2000, statement_timeout: 7000, query_timeout: 7000 });
  });
});
