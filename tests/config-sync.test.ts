import { describe, expect, it, vi } from 'vitest';
import { runConfigSync, type ConfigSyncOptions } from '../scripts/sync-config.js';
import { readTenantFiles } from '../apps/server/src/config.js';
import type { Database } from '../apps/server/src/database.js';

const shop = 'ym5fhx-fa.myshopify.com';

async function setup() {
  const tenant = await readTenantFiles(shop);
  tenant.config.knowledgeVersion = 'private-version-value';
  const query = vi.fn<Database['query']>().mockResolvedValue({ rows: [{ shop }] });
  const close = vi.fn<Database['close']>().mockResolvedValue();
  const connect = vi.fn().mockResolvedValue({ query, close });
  const output = vi.fn();
  const loadTenant = vi.fn().mockResolvedValue(tenant);
  const options: ConfigSyncOptions = {
    environment: () => ({ allowedShops: [shop], databaseUrl: 'postgres://synthetic-private-connection' }),
    loadTenant, connect, output,
  };
  return { tenant, query, close, connect, output, loadTenant, options };
}

describe('safe production tenant configuration sync', () => {
  it('updates only the specified active tenant and emits safe counts after closing its runtime connection', async () => {
    const { tenant, query, close, connect, output, options } = await setup();
    await expect(runConfigSync([shop], options)).resolves.toEqual({ shop, factRecords: 0, synced: true });
    expect(connect).toHaveBeenCalledWith('postgres://synthetic-private-connection');
    expect(query).toHaveBeenCalledExactlyOnceWith('UPDATE shops SET config=$2,facts=$3 WHERE shop=$1 AND active=true RETURNING shop', [shop, JSON.stringify(tenant.config), JSON.stringify(tenant.facts)]);
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(output.mock.invocationCallOrder[0]!);
    expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ shop, factRecords: 0, synced: true }));
    expect(output.mock.calls.flat().join(' ')).not.toContain('private');
  });

  it.each([[], [shop, 'unexpected'], ['https://private.example/token']].map(args => ({ args })))('rejects malformed arguments before reading configuration or connecting: $args', async ({ args }) => {
    const { connect, loadTenant, output, options } = await setup();
    await expect(runConfigSync(args, options)).rejects.toThrow(/^Usage: pnpm config:sync/);
    expect(loadTenant).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });

  it('rejects a different tenant before reading any source file or connecting', async () => {
    const { connect, loadTenant, output, options } = await setup();
    await expect(runConfigSync(['other-store.myshopify.com'], options)).rejects.toThrow(/^Configuration sync refused or failed\./);
    expect(loadTenant).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });

  it('withholds source parsing errors before opening the database', async () => {
    const { loadTenant, connect, output, options } = await setup();
    loadTenant.mockRejectedValue(new Error('private-source-contents'));
    await expect(runConfigSync([shop], options)).rejects.toThrow(/^Configuration sync refused or failed\./);
    expect(connect).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });

  it.each(['query', 'close'] as const)('withholds private %s errors and closes the connection', async stage => {
    const { query, close, output, options } = await setup();
    (stage === 'query' ? query : close).mockRejectedValue(new Error('private-database-error-with-credentials'));
    await expect(runConfigSync([shop], options)).rejects.toThrow(/^Configuration sync refused or failed\./);
    expect(close).toHaveBeenCalledOnce();
    expect(output).not.toHaveBeenCalled();
  });

  it('does not report success for a missing or inactive installation', async () => {
    const { query, close, output, options } = await setup();
    query.mockResolvedValue({ rows: [] });
    await expect(runConfigSync([shop], options)).rejects.toThrow(/^Configuration sync refused or failed\./);
    expect(close).toHaveBeenCalledOnce();
    expect(output).not.toHaveBeenCalled();
  });
});
