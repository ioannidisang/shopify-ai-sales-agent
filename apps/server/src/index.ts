import { pathToFileURL } from 'node:url';
import { readEnv } from './config.js';
import { openDatabase, purgeExpired, type Database } from './database.js';
import { buildApp } from './app.js';

interface RunningServer {
  listen(options: { host: string; port: number }): Promise<unknown>;
  close(): Promise<void>;
}

export interface ServerOptions {
  environment?: typeof readEnv;
  connect?: typeof openDatabase;
  purge?: typeof purgeExpired;
  build?: (env: ReturnType<typeof readEnv>, db: Database) => Promise<RunningServer>;
}

export async function startServer(options: ServerOptions = {}): Promise<() => Promise<void>> {
  let db: Database | undefined;
  let app: RunningServer | undefined;
  let closing: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    return closing ??= (async () => {
      let failed = false;
      try { await app?.close(); } catch { failed = true; }
      try { await db?.close(); } catch { failed = true; }
      if (failed) throw new Error('Server shutdown failed; check service health.');
    })();
  }
  try {
    const env = (options.environment ?? readEnv)();
    db = await (options.connect ?? openDatabase)(env.databaseUrl);
    await (options.purge ?? purgeExpired)(db);
    app = await (options.build ?? buildApp)(env, db);
    await app.listen({ host: process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1', port: env.port });
    return shutdown;
  } catch {
    // Configuration, driver and vendor exceptions can contain credentials or URLs.
    // Close every acquired resource without exposing either the original or cleanup error.
    try { await shutdown(); } catch { /* The startup failure is already reported below. */ }
    throw new Error('Server startup failed; check configuration, connectivity and runtime schema readiness.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const shutdown = await startServer();
    const onSignal = () => {
      void shutdown().catch(() => {
        console.error('Server shutdown failed; check service health.');
        process.exitCode = 1;
      });
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  } catch {
    console.error('Server startup failed; check configuration, connectivity and runtime schema readiness.');
    process.exitCode = 1;
  }
}
