import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, verifyDatabaseReady, type Database } from '../apps/server/src/database.js';
import { provisionRuntimeRole, runRuntimeProvisioningFromEnvironment } from '../apps/server/src/provision-runtime.js';

const name = 'sales_agent_production';
const password = 'fixture_only_random_password_1234567890_abcdefghijklmnop';
let engine: PGlite;
const statements: string[] = [];
const db: Database = {
  query: (sql, params) => { statements.push(sql); return engine.query(sql, params); },
  close: async () => {},
};

beforeAll(async () => {
  const initializer = new PGlite();
  await initializer.query('CREATE DATABASE sales_agent_production');
  const data = await initializer.dumpDataDir();
  await initializer.close();
  engine = new PGlite({ database: name, loadDataDir: data });
  await engine.exec('CREATE SCHEMA sales_agent; SET search_path TO sales_agent');
  await migrate(db);
  statements.length = 0;
}, 15000);
afterAll(async () => { if (engine) await engine.close(); });

describe('isolated one-time runtime role bootstrap', () => {
  it('requires one-time mode and denies unrelated targets before any role mutation', async () => {
    await expect(runRuntimeProvisioningFromEnvironment({})).rejects.toThrow('one-time');
    await expect(provisionRuntimeRole(db, 'kooqie_loyalty_production', password)).rejects.toThrow('denied');
    expect(statements).toHaveLength(0);
    await expect(provisionRuntimeRole(db, 'sales_agent_wrong', password)).rejects.toThrow('refused');
    expect(statements.some(sql => /^CREATE ROLE/.test(sql))).toBe(false);
  });

  it('refuses a database containing unrelated application objects without altering them', async () => {
    await engine.exec("CREATE TABLE public.unrelated(marker TEXT); INSERT INTO public.unrelated VALUES('preserve')");
    statements.length = 0;
    await expect(provisionRuntimeRole(db, name, password)).rejects.toThrow('refused');
    expect(statements.some(sql => /^CREATE ROLE/.test(sql))).toBe(false);
    expect((await engine.query<{ marker: string }>('SELECT marker FROM public.unrelated')).rows).toEqual([{ marker: 'preserve' }]);
    await engine.exec('DROP TABLE public.unrelated');
  });

  it('rolls back the entire new role if a grant step fails', async () => {
    const failing: Database = {
      ...db, query: (sql, params) => {
        if (sql.startsWith('GRANT USAGE')) throw new Error('fixture-only-provider-error');
        return db.query(sql, params);
      },
    };
    await expect(provisionRuntimeRole(failing, name, password)).rejects.toThrow('refused');
    expect((await engine.query("SELECT 1 FROM pg_roles WHERE rolname='sales_agent_runtime'")).rows).toHaveLength(0);
  });

  it('stores a SCRAM verifier, grants DML only, blocks DDL, and refuses an accidental second bootstrap', async () => {
    statements.length = 0;
    await provisionRuntimeRole(db, name, password);
    expect(statements.join('\n')).not.toContain(password);
    const attributes = await engine.query<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolbypassrls: boolean; rolpassword: string }>("SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolpassword FROM pg_authid WHERE rolname='sales_agent_runtime'");
    expect(attributes.rows[0]).toMatchObject({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    const verifier = attributes.rows[0]!.rolpassword;
    expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:/);
    expect(verifier).not.toContain(password);
    await engine.exec('SET ROLE sales_agent_runtime');
    try {
      await verifyDatabaseReady(db);
      await engine.query("INSERT INTO sales_agent.shops(shop,config,credentials,facts) VALUES('fixture.myshopify.com','{}','fixture','[]')");
      expect((await engine.query('SELECT shop FROM sales_agent.shops')).rows).toHaveLength(1);
      await expect(engine.query('CREATE TABLE sales_agent.forbidden(id INTEGER)')).rejects.toThrow(/permission denied/i);
      await expect(engine.query('CREATE TABLE public.forbidden(id INTEGER)')).rejects.toThrow(/permission denied/i);
      await expect(engine.query('UPDATE sales_agent.schema_migrations SET version=2')).rejects.toThrow(/permission denied/i);
    } finally { await engine.exec('RESET ROLE'); }
    await expect(provisionRuntimeRole(db, name, password)).rejects.toThrow('one-time role state');
    expect((await engine.query<{ rolpassword: string }>("SELECT rolpassword FROM pg_authid WHERE rolname='sales_agent_runtime'")).rows[0]!.rolpassword).toBe(verifier);
  });
});
