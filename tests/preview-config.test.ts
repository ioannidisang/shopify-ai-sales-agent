import { describe, expect, it } from 'vitest';
import { configSchema, readTenantFiles } from '../apps/server/src/config.js';
import type { PreviewCatalogApproval, ShopConfig } from '../packages/core/src/types.js';

const shop = 'preview.myshopify.com';
const approval: PreviewCatalogApproval = {
  purpose: 'private_preview', shop, version: 'preview-v1', approvedBy: 'Merchant', verifiedOn: '2026-10-01', expiresAt: '2026-10-08T00:00:00Z',
  products: [{ id: 'gid://shopify/Product/1', handle: 'product-one', evidenceUrl: `https://${shop}/products/product-one` }],
};
const config: ShopConfig = { shop, brand: 'Preview', locale: 'el', allowedCountries: ['GR'], enabled: true,
  experiment: { id: 'v1', enabled: false, treatmentPercent: 50 }, approvedImageUrls: [], knowledgeVersion: 'empty-v1', previewCatalog: approval };
const accepts = (previewCatalog: unknown) => configSchema.safeParse({ ...config, previewCatalog }).success;

describe('private preview tenant configuration', () => {
  it('keeps the exception optional and requires no product facts or images', () => {
    expect(accepts(undefined)).toBe(true);
    expect(accepts(approval)).toBe(true);
  });
  it('rejects cross-tenant approval and any configured preview exception during experiments', () => {
    expect(configSchema.safeParse({ ...config, shop: 'other.myshopify.com' }).success).toBe(false);
    expect(configSchema.safeParse({ ...config, experiment: { ...config.experiment, enabled: true } }).success).toBe(false);
  });
  it.each([
    { ...approval, version: '' }, { ...approval, approvedBy: ' ' }, { ...approval, verifiedOn: 'invalid' },
    { ...approval, expiresAt: '2026-10-01T00:00:00Z' }, { ...approval, expiresAt: '2026-10-08T00:00:01Z' },
    { ...approval, products: [] }, { ...approval, products: Array(13).fill(approval.products[0]) },
    { ...approval, products: [approval.products[0], approval.products[0]] },
    { ...approval, products: [{ ...approval.products[0], id: 'gid://shopify/ProductVariant/1' }] },
    { ...approval, products: [{ ...approval.products[0], availableForSale: true }] },
  ])('rejects invalid, overlong, ambiguous or commerce-bearing approval %#', value => {
    expect(accepts(value)).toBe(false);
  });
  it.each([
    `https://${shop}/products/product-one?preview_theme_id=123`, `https://${shop}/products/product-one#secret`,
    `https://name:password@${shop}/products/product-one`, 'https://other.myshopify.com/products/product-one',
    `http://${shop}/products/product-one`, `https://${shop}/products/other-product`,
  ])('rejects authenticated, foreign or mismatched evidence URL %s', evidenceUrl => {
    expect(accepts({ ...approval, products: [{ ...approval.products[0], evidenceUrl }] })).toBe(false);
  });
  it('loads the explicitly configured closed Nutri Tiger pilot without enabling claims, images or experiments', async () => {
    const tenant = await readTenantFiles('ym5fhx-fa.myshopify.com');
    expect(tenant.config.previewCatalog).toMatchObject({ shop: tenant.config.shop, expiresAt: '2026-10-08T00:00:00Z' });
    expect(tenant.config.previewCatalog!.products).toHaveLength(2);
    expect(tenant.config.experiment.enabled).toBe(false);
    expect(tenant.config.approvedImageUrls).toEqual([]);
    expect(tenant.facts).toEqual([]);
  });
});
