import { openDatabase, migrate, readDatabaseOptions } from './database.js';
import { pathToFileURL } from 'node:url';

export async function runMigrationsFromEnvironment(env: NodeJS.ProcessEnv): Promise<void> {
  // Never fall back to a runtime credential. This function is also exercised with a local test adapter.
  const migrationUrl = env.MIGRATION_DATABASE_URL;
  if (!migrationUrl) throw new Error('MIGRATION_DATABASE_URL is required');
  if (!env.MIGRATION_EXPECTED_DATABASE) throw new Error('MIGRATION_EXPECTED_DATABASE is required');
  const db = await openDatabase(migrationUrl, undefined, { ...readDatabaseOptions(env), purpose: 'migration', expectedDatabase: env.MIGRATION_EXPECTED_DATABASE, poolMax: 1 });
  try {
    await migrate(db);
  } finally { await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 2) throw new Error('Migration credentials must come from the environment');
    await runMigrationsFromEnvironment(process.env);
    console.log('sales_agent migrations completed. Configure scoped runtime grants before starting the service.');
  } catch {
    // Driver errors may contain connection details; never print the exception or supplied URL.
    console.error('sales_agent migration failed. Check the migration environment, connectivity and schema-owner privileges.');
    process.exitCode = 1;
  }
}
