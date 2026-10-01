import { z } from 'zod';

/** Bounded preview display permission. Every commerce field still comes from live Shopify reads. */
export const previewCatalogSchema = z.object({
  purpose: z.literal('private_preview'),
  shop: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
  version: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  approvedBy: z.string().trim().min(1).max(160),
  verifiedOn: z.iso.date(),
  expiresAt: z.iso.datetime(),
  products: z.array(z.object({
    id: z.string().max(100).regex(/^gid:\/\/shopify\/Product\/\d+$/),
    handle: z.string().regex(/^[a-z0-9][a-z0-9-]{0,254}$/),
    evidenceUrl: z.url().max(500),
  }).strict()).min(1).max(12),
}).strict().superRefine((value, context) => {
  const start = Date.parse(`${value.verifiedOn}T00:00:00Z`);
  const expiry = Date.parse(value.expiresAt);
  if (!(expiry > start && expiry <= start + 7 * 86400000)) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Preview approval must expire within seven days of verification' });
  }
  if (new Set(value.products.map(product => product.id)).size !== value.products.length
    || new Set(value.products.map(product => product.handle)).size !== value.products.length) {
    context.addIssue({ code: 'custom', path: ['products'], message: 'Preview products require unique IDs and handles' });
  }
  for (const [index, product] of value.products.entries()) {
    // Store only the canonical product reference, never an authenticated preview URL.
    if (product.evidenceUrl !== `https://${value.shop}/products/${product.handle}`) {
      context.addIssue({ code: 'custom', path: ['products', index, 'evidenceUrl'], message: 'Preview evidence must be the same shop canonical product URL' });
    }
  }
});
