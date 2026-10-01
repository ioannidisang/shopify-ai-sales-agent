import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { openDatabase, migrate, purgeExpired } from '../apps/server/src/database.js';

describe('dedicated application database schema', () => {
  // This test includes the cold PostgreSQL WASM startup, which can exceed Vitest's
  // five-second default on the Render build CPU. Keep a bounded integration timeout.
  it('creates application tables only in sales_agent on an empty local database', async () => {
    const db = await openDatabase(undefined, 'memory://');
    try {
      await migrate(db);
      const schemas = await db.query<{ current: string; public_shops: string | null; public_events: string | null; app_shops: string | null }>(
        "SELECT current_schema() AS current,to_regclass('public.shops')::text AS public_shops,to_regclass('public.events')::text AS public_events,to_regclass('sales_agent.shops')::text AS app_shops",
      );
      expect(schemas.rows[0]).toEqual({ current: 'sales_agent', public_shops: null, public_events: null, app_shops: 'shops' });
    } finally { await db.close(); }
  }, 15000);

  it('preserves pre-existing public tables and marker data through initialization, migration and retention', async () => {
    const temporaryRoot = resolve(tmpdir());
    const directory = await mkdtemp(join(temporaryRoot, 'sales-agent-schema-'));
    const dataPath = join(directory, 'postgres');
    try {
      const existing = new PGlite(dataPath);
      try {
        await existing.exec("CREATE TABLE public.shops (marker TEXT); CREATE TABLE public.events (marker TEXT); CREATE TABLE public.other_app_marker (marker TEXT)");
        for (const table of ['shops', 'events', 'other_app_marker']) await existing.query(`INSERT INTO public.${table}(marker) VALUES($1)`, [`preserve-${table}`]);
      } finally { await existing.close(); }

      const db = await openDatabase(undefined, dataPath);
      try {
        await migrate(db);
        await migrate(db);
        await purgeExpired(db);
        for (const table of ['shops', 'events', 'other_app_marker']) {
          expect((await db.query<{ marker: string }>(`SELECT marker FROM public.${table}`)).rows).toEqual([{ marker: `preserve-${table}` }]);
          const columns = await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [table]);
          expect(columns.rows).toEqual([{ column_name: 'marker' }]);
        }
        expect((await db.query('SELECT shop FROM sales_agent.shops')).rows).toEqual([]);
      } finally { await db.close(); }
    } finally {
      // Delete only the fresh, resolved directory created by this test, never a shared temp root.
      const resolvedDirectory = resolve(directory);
      if (!resolvedDirectory.startsWith(`${temporaryRoot}${sep}sales-agent-schema-`)) throw new Error('Unsafe test cleanup path');
      await rm(resolvedDirectory, { recursive: true, force: true });
    }
  }, 15000);
});
