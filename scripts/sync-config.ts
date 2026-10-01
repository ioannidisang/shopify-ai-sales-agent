import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTenantFiles, readEnv } from '../apps/server/src/config.js';
import { openDatabase, type Database } from '../apps/server/src/database.js';
import { shopDomain } from '../apps/server/src/security.js';

export interface ConfigSyncOptions {
  environment?: () => Pick<ReturnType<typeof readEnv>, 'allowedShops' | 'databaseUrl'>;
  loadTenant?: typeof readTenantFiles;
  connect?: (url?: string) => Promise<Database>;
  output?: (value: string) => void;
}

const usage = 'Usage: pnpm config:sync <shop>.myshopify.com (production: node dist/scripts/sync-config.js <shop>.myshopify.com).';
const failed = 'Configuration sync refused or failed. Verify the allowlisted shop, tenant file, installed shop and restricted runtime database configuration. No credentials, knowledge contents or database errors are logged.';

/** Update only the installed, active tenant using runtime credentials; never log vendor errors or source contents. */
export async function runConfigSync(args: string[], options: ConfigSyncOptions = {}): Promise<{ shop: string; factRecords: number; synced: true }> {
  if (args.length !== 1 || !shopDomain.safeParse(args[0]).success) throw new Error(usage);
  const shop = args[0]!;
  try {
    const env = (options.environment ?? readEnv)();
    if (!env.allowedShops.includes(shop)) throw new Error('Shop is not allowlisted');
    const { config, facts } = await (options.loadTenant ?? readTenantFiles)(shop);
    const db = await (options.connect ?? openDatabase)(env.databaseUrl);
    try {
      const result = await db.query('UPDATE shops SET config=$2,facts=$3 WHERE shop=$1 AND active=true RETURNING shop', [shop, JSON.stringify(config), JSON.stringify(facts)]);
      if (!result.rows.length) throw new Error('Shop is not installed');
    } finally { await db.close(); }
    const result = { shop, factRecords: facts.length, synced: true as const };
    (options.output ?? console.log)(JSON.stringify(result));
    return result;
  } catch {
    // File parsing/validation, PostgreSQL and connection errors can include sensitive values.
    throw new Error(failed);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runConfigSync(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error && error.message === usage ? usage : failed);
    process.exitCode = 1;
  }
}
