import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { shopDomain } from './security.js';
import { previewCatalogSchema } from '../../../packages/shopify/src/preview-catalog.js';

export const configSchema = z.object({
  shop: shopDomain, brand: z.string().min(1).max(80), locale: z.enum(['el', 'en']),
  allowedCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(50), enabled: z.boolean(),
  experiment: z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), enabled: z.boolean(), treatmentPercent: z.number().min(0).max(100).default(50),
    arms: z.array(z.object({ id: z.enum(['openai', 'mistral', 'control']), weight: z.number().positive().max(100) }).strict()).min(2).max(3).optional(),
  }).strict().refine(value => !value.arms || (new Set(value.arms.map(arm => arm.id)).size === value.arms.length
    && value.arms.some(arm => arm.id === 'control') && Math.abs(value.arms.reduce((sum, arm) => sum + arm.weight, 0) - 100) < 0.000001), 'Experiment arms require unique IDs, a control and weights totaling 100'),
  defaultProvider: z.enum(['openai', 'mistral']).optional(),
  conversation: z.object({
    version: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), instructions: z.string().max(2000),
    examples: z.array(z.object({ user: z.string().min(1).max(500), assistant: z.string().min(1).max(1000) }).strict()).max(8),
    approvedBy: z.string().trim().min(1).max(100), approvedAt: z.iso.datetime().refine(value => Date.parse(value) <= Date.now(), 'Guidance approval cannot be in the future'),
  }).strict().optional(),
  approvedImageUrls: z.array(z.url().refine(value => new URL(value).protocol === 'https:')).max(500),
  knowledgeVersion: z.string().max(80),
  previewCatalog: previewCatalogSchema.optional(),
}).strict().refine(value => !value.previewCatalog || value.previewCatalog.shop === value.shop, 'Preview approval must belong to this tenant')
  .refine(value => !value.previewCatalog || !value.experiment.enabled, 'Remove preview catalog approval before enabling an experiment');
export const factSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), shop: shopDomain,
  productId: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/).nullable(),
  locale: z.enum(['el', 'en']), text: z.string().min(1).max(1200), source: z.string().min(1).max(500),
  approvedBy: z.string().max(100), approvedAt: z.iso.datetime(),
  status: z.enum(['approved', 'draft', 'revoked']), expiresAt: z.iso.datetime().nullable().optional(),
  sourceVersion: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), retrievedAt: z.iso.datetime().optional(),
}).strict().refine(value => value.status !== 'approved' || Boolean(value.approvedBy.trim()), 'Approved facts require a reviewer')
  .refine(value => [value.sourceVersion, value.sourceHash, value.retrievedAt].every(v => v === undefined)
    || [value.sourceVersion, value.sourceHash, value.retrievedAt].every(v => Boolean(v)), 'Source provenance must be complete')
  .refine(value => value.sourceVersion === undefined || value.sourceVersion === `sha256-${value.sourceHash}`, 'Source version must match its content hash');

export async function readTenantFiles(shop: string, root = 'config/stores') {
  shopDomain.parse(shop);
  const data = JSON.parse(await readFile(resolve(root, `${shop}.json`), 'utf8')) as unknown;
  const parsed = z.object({ config: configSchema, facts: z.array(factSchema).max(1000) }).strict().parse(data);
  if (parsed.config.shop !== shop || parsed.facts.some(f => f.shop !== shop)) throw new Error('Tenant config mismatch');
  if (new Set(parsed.facts.map(f => f.id)).size !== parsed.facts.length) throw new Error('Duplicate fact IDs');
  return parsed;
}

export function readEnv() {
  const raw = process.env;
  if (raw.NODE_ENV === 'production' && raw.MIGRATION_DATABASE_URL) throw new Error('Production runtime must not receive MIGRATION_DATABASE_URL');
  if (raw.NODE_ENV === 'production' && (raw.RUNTIME_DATABASE_PASSWORD || raw.RUNTIME_ROLE_BOOTSTRAP === 'true')) throw new Error('Production runtime must not receive role bootstrap secrets or mode');
  const port = z.coerce.number().int().min(1).max(65535).parse(raw.PORT ?? '3000');
  const allowedShops = (raw.ALLOWED_SHOPS ?? 'ym5fhx-fa.myshopify.com').split(',').map(s => shopDomain.parse(s.trim()));
  const appUrl = raw.APP_URL ?? `http://localhost:${port}`;
  const parsedUrl = new URL(appUrl);
  if (raw.NODE_ENV === 'production' && (parsedUrl.protocol !== 'https:' || !raw.DATABASE_URL)) throw new Error('Production requires HTTPS APP_URL and PostgreSQL DATABASE_URL');
  return {
    port, appUrl, allowedShops, databaseUrl: raw.DATABASE_URL,
    apiKey: raw.SHOPIFY_API_KEY, apiSecret: raw.SHOPIFY_API_SECRET,
    sessionSecret: raw.SESSION_SECRET, encryptionKey: raw.ENCRYPTION_KEY,
    openaiKey: raw.OPENAI_API_KEY, openaiModel: raw.OPENAI_MODEL,
    mistralKey: raw.MISTRAL_API_KEY, mistralModel: raw.MISTRAL_MODEL,
  };
}
