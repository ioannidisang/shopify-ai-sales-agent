import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DATABASE_SCHEMA_VERSION, openDatabase, readDatabaseOptions, type Database } from './database.js';

export const RUNTIME_ROLE = 'sales_agent_runtime';
const appTables = ['shops', 'conversations', 'usage_buckets', 'events', 'pixel_assignments', 'webhooks', 'experiment_specs', 'eligible_exposures', 'model_usage'];

/** PostgreSQL SCRAM-SHA-256 verifier. Restrict generated passwords to URL-safe ASCII to avoid SASLprep ambiguity. */
export function createScramVerifier(password: string, salt = randomBytes(16)): string {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(password) || salt.length < 16) throw new Error('Runtime password must be 32–256 random URL-safe ASCII characters');
  const iterations = 4096;
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  try {
    const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
    const storedKey = createHash('sha256').update(clientKey).digest('base64');
    clientKey.fill(0);
    const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest('base64');
    return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey}:${serverKey}`;
  } finally { saltedPassword.fill(0); }
}

function assertDedicatedDatabase(name: string): void {
  if (!/^sales_agent(?:_[a-z0-9]+)*$/.test(name) || name.length > 63 || /(?:loyalty|kooqie)/i.test(name)) {
    throw new Error('Runtime bootstrap only supports a new dedicated sales_agent database; Loyalty targets are denied');
  }
}

export async function provisionRuntimeRole(db: Database, expectedDatabase: string, password: string): Promise<void> {
  assertDedicatedDatabase(expectedDatabase);
  const verifier = createScramVerifier(password);
  // No plaintext password is ever interpolated or transmitted as a SQL parameter.
  // Verifier alphabet is fixed, so the sole secret SQL literal cannot escape its quotes.
  if (!/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verifier)) throw new Error('Invalid SCRAM verifier');
  await db.query('BEGIN');
  try {
    const target = await db.query<{ database: string }>('SELECT current_database() AS database');
    if (target.rows[0]?.database !== expectedDatabase) throw new Error('Unexpected database');
    const version = await db.query<{ version: number }>('SELECT version FROM sales_agent.schema_migrations WHERE version=$1', [DATABASE_SCHEMA_VERSION]);
    if (!version.rows.length) throw new Error('Run app migration first');
    const schema = await db.query<{ owned: boolean }>("SELECT nspowner=current_user::regrole AS owned FROM pg_namespace WHERE nspname='sales_agent'");
    if (!schema.rows[0]?.owned) throw new Error('Bootstrap must use the assistant schema owner');
    const unrelated = await db.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp'
      AND c.relkind IN ('r','p','v','m','S','f')
      AND NOT (n.nspname='sales_agent' AND c.relname=ANY($1::text[]))
      AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e') LIMIT 1`, [[...appTables, 'schema_migrations']]);
    if (unrelated.rows.length) throw new Error('Database contains unrelated application objects');
    const existing = await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [RUNTIME_ROLE]);
    if (existing.rows.length) throw new Error('Runtime role already exists; do not bootstrap twice');

    await db.query(`CREATE ROLE sales_agent_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 6 PASSWORD '${verifier}'`);
    // PUBLIC inherits no schema creation rights in this newly checked dedicated database.
    await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await db.query('REVOKE ALL ON SCHEMA sales_agent FROM PUBLIC');
    await db.query(`REVOKE ALL ON DATABASE "${expectedDatabase}" FROM sales_agent_runtime`);
    await db.query(`GRANT CONNECT ON DATABASE "${expectedDatabase}" TO sales_agent_runtime`);
    await db.query('GRANT USAGE ON SCHEMA sales_agent TO sales_agent_runtime');
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${appTables.map(table => `sales_agent.${table}`).join(',')} TO sales_agent_runtime`);
    await db.query('GRANT SELECT ON sales_agent.schema_migrations TO sales_agent_runtime');
    await db.query(`ALTER ROLE sales_agent_runtime IN DATABASE "${expectedDatabase}" SET search_path TO sales_agent`);
    await db.query(`ALTER ROLE sales_agent_runtime IN DATABASE "${expectedDatabase}" SET statement_timeout TO '10s'`);
    // Future tables require an explicit reviewed grant; never grant all future tables by default.
    await db.query('COMMIT');
  } catch {
    try { await db.query('ROLLBACK'); } catch { /* Never report raw database errors or SQL. */ }
    throw new Error('Runtime role bootstrap refused or failed; verify the new assistant target, owner, migration and one-time role state');
  }
}

export async function runRuntimeProvisioningFromEnvironment(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.RUNTIME_ROLE_BOOTSTRAP !== 'true') throw new Error('Explicit one-time runtime bootstrap mode is required');
  if (!env.MIGRATION_DATABASE_URL || !env.MIGRATION_EXPECTED_DATABASE || !env.RUNTIME_DATABASE_PASSWORD) throw new Error('Missing isolated bootstrap environment');
  assertDedicatedDatabase(env.MIGRATION_EXPECTED_DATABASE);
  // Validate before opening any connection; the actual verifier uses fresh salt inside the transaction helper.
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(env.RUNTIME_DATABASE_PASSWORD)) throw new Error('Invalid runtime password format');
  const db = await openDatabase(env.MIGRATION_DATABASE_URL, undefined, {
    ...readDatabaseOptions(env), purpose: 'provision', expectedDatabase: env.MIGRATION_EXPECTED_DATABASE, poolMax: 1,
  });
  try { await provisionRuntimeRole(db, env.MIGRATION_EXPECTED_DATABASE, env.RUNTIME_DATABASE_PASSWORD); }
  finally { await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 2) throw new Error('Bootstrap secrets must come from the environment');
    await runRuntimeProvisioningFromEnvironment(process.env);
    console.log('Restricted assistant runtime role provisioned. Remove bootstrap secrets and mode from the migrator.');
  } catch {
    console.error('Runtime role bootstrap refused or failed. No credentials or SQL are logged; check the isolated migration configuration.');
    process.exitCode = 1;
  }
}
