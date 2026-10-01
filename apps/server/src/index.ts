import { readEnv } from './config.js';
import { openDatabase, purgeExpired } from './database.js';
import { buildApp } from './app.js';

const env = readEnv();
const db = await openDatabase(env.databaseUrl);
await purgeExpired(db);
const app = await buildApp(env, db);
await app.listen({ host: process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1', port: env.port });
async function shutdown() { await app.close(); await db.close(); }
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
