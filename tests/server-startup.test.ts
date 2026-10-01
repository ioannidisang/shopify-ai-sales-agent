import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer, type ServerOptions } from '../apps/server/src/index.js';
import type { Database } from '../apps/server/src/database.js';

const privateError = new Error('postgres://private-user:private-password@private-host/private-database');

function setup() {
  const environment = vi.fn<NonNullable<ServerOptions['environment']>>().mockReturnValue({
    port: 3000, appUrl: 'https://example.com', allowedShops: ['ym5fhx-fa.myshopify.com'],
    databaseUrl: 'postgres://synthetic-private-connection', apiKey: undefined, apiSecret: undefined,
    sessionSecret: undefined, encryptionKey: undefined, openaiKey: undefined, openaiModel: undefined,
    mistralKey: undefined, mistralModel: undefined,
  });
  const databaseClose = vi.fn<Database['close']>().mockResolvedValue();
  const db: Database = { query: async () => ({ rows: [] }), close: databaseClose };
  const connect = vi.fn<NonNullable<ServerOptions['connect']>>().mockResolvedValue(db);
  const purge = vi.fn<NonNullable<ServerOptions['purge']>>().mockResolvedValue();
  const listen = vi.fn().mockResolvedValue('http://127.0.0.1:3000');
  const appClose = vi.fn<() => Promise<void>>().mockResolvedValue();
  const build = vi.fn<NonNullable<ServerOptions['build']>>().mockResolvedValue({ listen, close: appClose });
  return { environment, databaseClose, db, connect, purge, listen, appClose, build,
    options: { environment, connect, purge, build } satisfies ServerOptions };
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('server lifecycle privacy boundary', () => {
  it.each(['environment', 'connect', 'purge', 'build', 'listen'] as const)('redacts %s failure and releases every acquired resource', async stage => {
    const setupResult = setup();
    if (stage === 'environment') setupResult.environment.mockImplementation(() => { throw privateError; });
    else setupResult[stage].mockRejectedValue(privateError);
    const error = await startServer(setupResult.options).catch(value => value as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe('Error: Server startup failed; check configuration, connectivity and runtime schema readiness.');
    expect((error as Error).cause).toBeUndefined();
    expect(setupResult.databaseClose).toHaveBeenCalledTimes(['purge', 'build', 'listen'].includes(stage) ? 1 : 0);
    expect(setupResult.appClose).toHaveBeenCalledTimes(stage === 'listen' ? 1 : 0);
  });

  it('redacts cleanup errors while preserving startup failure and attempting database cleanup', async () => {
    const { options, listen, appClose, databaseClose } = setup();
    listen.mockRejectedValue(privateError);
    appClose.mockRejectedValue(privateError);
    databaseClose.mockRejectedValue(privateError);
    await expect(startServer(options)).rejects.toThrow(/^Server startup failed;/);
    expect(appClose).toHaveBeenCalledOnce();
    expect(databaseClose).toHaveBeenCalledOnce();
  });

  it.each([
    { mode: 'production', host: '0.0.0.0' },
    { mode: 'development', host: '127.0.0.1' },
  ])('retains $mode listener behavior and closes resources once for concurrent signals', async ({ mode, host }) => {
    vi.stubEnv('NODE_ENV', mode);
    const { options, connect, purge, build, listen, appClose, databaseClose, db } = setup();
    const shutdown = await startServer(options);
    expect(connect).toHaveBeenCalledExactlyOnceWith('postgres://synthetic-private-connection');
    expect(purge).toHaveBeenCalledExactlyOnceWith(db);
    expect(purge.mock.invocationCallOrder[0]).toBeLessThan(build.mock.invocationCallOrder[0]!);
    expect(listen).toHaveBeenCalledExactlyOnceWith({ host, port: 3000 });
    expect(databaseClose).not.toHaveBeenCalled();
    await Promise.all([shutdown(), shutdown()]);
    expect(appClose).toHaveBeenCalledOnce();
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(appClose.mock.invocationCallOrder[0]).toBeLessThan(databaseClose.mock.invocationCallOrder[0]!);
  });

  it.each(['app', 'database'] as const)('redacts %s shutdown failure and still closes both resources', async stage => {
    const { options, appClose, databaseClose } = setup();
    const shutdown = await startServer(options);
    (stage === 'app' ? appClose : databaseClose).mockRejectedValue(privateError);
    await expect(shutdown()).rejects.toThrow('Server shutdown failed; check service health.');
    await expect(shutdown()).rejects.toThrow('Server shutdown failed; check service health.');
    expect(appClose).toHaveBeenCalledOnce();
    expect(databaseClose).toHaveBeenCalledOnce();
  });
});
