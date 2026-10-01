import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { configSchema, factSchema, readTenantFiles } from '../apps/server/src/config.js';
import { approveFacts, importSourceFacts, MAX_SOURCE_BYTES, revokeFacts } from '../packages/core/src/knowledge.js';
import type { Locale } from '../packages/core/src/types.js';

export const trainingProfileSchema = z.object({
  version: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  instructions: z.string().trim().min(1).max(2000),
  examples: z.array(z.object({
    user: z.string().trim().min(1).max(500), assistant: z.string().trim().min(1).max(1000),
  }).strict()).max(8),
}).strict();

function options(argv: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]; const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--') || result.has(key)) throw new Error('Options require unique --name value pairs');
    result.set(key, value);
  }
  return result;
}
function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value?.trim()) throw new Error('A required option is missing');
  return value;
}
async function boundedFile(path: string): Promise<Buffer> {
  if (!(await stat(path)).isFile() || (await stat(path)).size > MAX_SOURCE_BYTES) throw new Error('Source must be a file of at most 256 KiB');
  const content = await readFile(path);
  if (content.length > MAX_SOURCE_BYTES) throw new Error('Source exceeds the maximum size');
  return content;
}
function decode(content: Uint8Array): string { return new TextDecoder('utf-8', { fatal: true }).decode(content); }

/** Local-only merchant operations. No network, provider calls, source downloads, or publication. */
export async function runKnowledgeCommand(argv: string[], settings: { root?: string; output?: (value: string) => void } = {}): Promise<void> {
  const [command, shop, ...rest] = argv;
  if (!command || !shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error('Usage: pnpm knowledge <import|review|approve|revoke|training-review|training-import> <shop> [--option value]');
  if (!['import', 'review', 'approve', 'revoke', 'training-review', 'training-import'].includes(command)) throw new Error('Unknown knowledge command');
  const flags = options(rest);
  const allowed = new Set(['--file', '--source', '--locale', '--product', '--ids', '--by', '--confirm-reviewed', '--status']);
  if ([...flags.keys()].some(key => !allowed.has(key))) throw new Error('Unknown knowledge option');
  const root = settings.root ?? 'config/stores';
  const output = settings.output ?? console.log;
  const path = resolve(root, `${shop}.json`);
  const mutates = ['import', 'approve', 'revoke', 'training-import'].includes(command);
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let temporary: string | undefined;
  try {
    if (mutates) lock = await open(`${path}.lock`, 'wx', 0o600);
    const tenant = await readTenantFiles(shop, root);
    if (command === 'review') {
      const status = flags.get('--status') ?? 'draft';
      if (!['draft', 'approved', 'revoked', 'all'].includes(status)) throw new Error('Unknown review status');
      const facts = tenant.facts.filter(fact => status === 'all' || fact.status === status);
      output(JSON.stringify({ shop, knowledgeVersion: tenant.config.knowledgeVersion, facts }, null, 2));
      return;
    }
    if (command === 'training-review' || command === 'training-import') {
      const profile = trainingProfileSchema.parse(JSON.parse(decode(await boundedFile(required(flags, '--file')))) as unknown);
      if (command === 'training-review') { output(JSON.stringify(profile, null, 2)); return; }
      if (flags.get('--confirm-reviewed') !== 'true') throw new Error('Merchant review must be explicitly confirmed');
      const approvedBy = required(flags, '--by').trim();
      if (approvedBy.length > 100) throw new Error('Approver exceeds the maximum length');
      const previous = tenant.config.conversation;
      if (previous?.version === profile.version) throw new Error('Use a new conversation version for every approved profile import');
      tenant.config = configSchema.parse({ ...tenant.config, conversation: { ...profile, approvedBy, approvedAt: new Date().toISOString() } });
    } else if (command === 'import') {
      const file = required(flags, '--file');
      const extension = extname(file).toLowerCase();
      if (!['.txt', '.md', '.json'].includes(extension)) throw new Error('Import a .txt, .md, or .json source file');
      const locale = flags.get('--locale') ?? tenant.config.locale;
      if (!['el', 'en'].includes(locale)) throw new Error('Unsupported source locale');
      const result = importSourceFacts(tenant.facts, {
        shop, source: required(flags, '--source'), content: await boundedFile(file),
        format: extension === '.json' ? 'json' : 'text', locale: locale as Locale,
        productId: flags.get('--product') ?? null,
      });
      tenant.facts = result.facts.map(fact => factSchema.parse(fact));
      if (result.unchanged) { output(`Unchanged source: ${shop}; no approvals or records changed.`); return; }
      output(`Prepared ${result.importedIds.length} drafts and ${result.revokedIds.length} source revocations for local save. Review before approval.`);
    } else {
      const ids = required(flags, '--ids').split(',').map(id => id.trim());
      if (command === 'approve') {
        if (flags.get('--confirm-reviewed') !== 'true') throw new Error('Merchant review must be explicitly confirmed');
        tenant.facts = approveFacts(tenant.facts, shop, ids, required(flags, '--by')).map(fact => factSchema.parse(fact));
      } else tenant.facts = revokeFacts(tenant.facts, shop, ids).map(fact => factSchema.parse(fact));
    }
    tenant.config.knowledgeVersion = `knowledge-${randomUUID()}`;
    const validated = { config: configSchema.parse(tenant.config), facts: tenant.facts.map(fact => factSchema.parse(fact)) };
    temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path); temporary = undefined;
    output(`Saved local knowledge for ${shop}. Runtime publication requires the separate config:sync operation.`);
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    if (lock) { await lock.close(); await unlink(`${path}.lock`); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runKnowledgeCommand(process.argv.slice(2)); }
  catch {
    // Errors may contain file contents or parser data; keep the public CLI output bounded and secret-free.
    console.error('Knowledge operation failed. Check command options, canonical source URL, tenant schema, review confirmation, and file limits. No source contents or credentials are logged.');
    process.exitCode = 1;
  }
}
