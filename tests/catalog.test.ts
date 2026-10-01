import { describe, expect, it, vi } from 'vitest';
import { buildSearchQuery, ShopifyCatalog } from '../packages/shopify/src/catalog.js';
import type { PreviewCatalogApproval } from '../packages/core/src/types.js';
const context = { country: 'GR', locale: 'el' as const };
const rawVariant = { id: 'gid://shopify/ProductVariant/11', title: 'Vanilla', price: { amount: '24.90', currencyCode: 'EUR' }, availableForSale: true, currentlyNotInStock: true, requiresComponents: false, quantityRule: { minimum: 1, maximum: null, increment: 1 } };
const rawProduct = {
  id: 'gid://shopify/Product/1', title: 'Protein', handle: 'protein', onlineStoreUrl: 'https://example.com/products/protein',
  featuredImage: { url: 'https://cdn.shopify.com/approved.png' },
  requiresSellingPlan: false,
  variants: { nodes: [rawVariant], pageInfo: { hasNextPage: false, endCursor: null } },
};
function response(data: unknown, extra: object = {}): Response { return new Response(JSON.stringify({ data, ...extra }), { status: 200 }); }
function setup(requestFetch = vi.fn<typeof fetch>().mockResolvedValue(response({ products: { nodes: [rawProduct] } })), approvedImageUrls: string[] = []) {
  return { requestFetch, catalog: new ShopifyCatalog({ shop: 'pilot.myshopify.com', accessToken: 'test-token', approvedImageUrls, fetch: requestFetch, timeoutMs: 25 }) };
}

describe('Shopify live catalog', () => {
  it('pins the API and buyer market; maps backorder availability and allowlisted images', async () => {
    const { catalog, requestFetch } = setup(undefined, [rawProduct.featuredImage.url]);
    const result = await catalog.search('protein', context);
    const [url, options] = requestFetch.mock.calls[0]!;
    expect(url).toBe('https://pilot.myshopify.com/api/2026-07/graphql.json');
    expect(JSON.parse(String(options?.body)).variables).toMatchObject({ country: 'GR', language: 'EL' });
    expect(result[0]!.variants[0]).toMatchObject({ legacyId: '11', currentlyNotInStock: true, price: rawVariant.price });
    expect(result[0]!.imageUrl).toBe(rawProduct.featuredImage.url);
    expect(result[0]!.url).toBe('/products/protein');
  });
  it('hides every image until that exact URL is approved', async () => {
    expect((await setup().catalog.search('protein', context))[0]!.imageUrl).toBeNull();
  });
  it('does not list a null Online Store URL without explicit preview approval', async () => {
    const { catalog } = setup(vi.fn<typeof fetch>().mockResolvedValue(response({ products: { nodes: [{ ...rawProduct, onlineStoreUrl: null }] } })));
    expect(await catalog.search('protein', context)).toEqual([]);
  });
  it('does not accept Shopify query operators from the model', () => {
    const query = buildSearchQuery('protein OR price:0 status:any "malicious"');
    expect(query).not.toContain('price:0');
    expect(query).not.toContain('status:any');
    expect(query).not.toContain('"');
  });
  it('validates the shop hostname before a token can leave the process', () => {
    expect(() => new ShopifyCatalog({ shop: 'pilot.myshopify.com.evil.test', accessToken: 'secret', approvedImageUrls: [] })).toThrow();
  });
  it('fails closed when Shopify returns GraphQL errors with partial product data', async () => {
    const { catalog } = setup(vi.fn<typeof fetch>().mockResolvedValue(response({ products: { nodes: [rawProduct] } }, { errors: [{ message: 'access denied secret' }] })));
    await expect(catalog.search('protein', context)).rejects.toThrow('Live product information');
  });
  it('fails closed on malformed monetary or availability fields', async () => {
    const broken = { ...rawProduct, variants: { ...rawProduct.variants, nodes: [{ ...rawVariant, price: { amount: 'free', currencyCode: 'EUR' } }] } };
    const { catalog } = setup(vi.fn<typeof fetch>().mockResolvedValue(response({ products: { nodes: [broken] } })));
    await expect(catalog.search('protein', context)).rejects.toThrow('Live product information');
  });
  it('fails closed when Shopify silently falls forward to another API version', async () => {
    const { catalog } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: { products: { nodes: [rawProduct] } } }), {
      headers: { 'x-shopify-api-version': '2027-07' },
    })));
    await expect(catalog.search('protein', context)).rejects.toThrow();
  });
  it('times out a slow provider without returning stale or fabricated products', async () => {
    const fakeFetch = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    await expect(setup(fakeFetch).catalog.search('protein', context)).rejects.toThrow('Live product information');
  });
  it('fetches additional variant pages when hydrating selected cards', async () => {
    const requestFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ nodes: [{ ...rawProduct, variants: { nodes: [rawVariant], pageInfo: { hasNextPage: true, endCursor: 'next' } } }] }))
      .mockResolvedValueOnce(response({ product: { variants: { nodes: [{ ...rawVariant, id: 'gid://shopify/ProductVariant/12', title: 'Chocolate' }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
    const result = await setup(requestFetch).catalog.getProducts([rawProduct.id], context);
    expect(result[0]!.variants).toHaveLength(2);
    expect(JSON.parse(String(requestFetch.mock.calls[1]![1]?.body)).variables.after).toBe('next');
  });
  it('returns null for a removed variant', async () => {
    const { catalog } = setup(vi.fn<typeof fetch>().mockResolvedValue(response({ node: null })));
    expect(await catalog.getVariant(rawVariant.id, context)).toBeNull();
  });
  it('validates product/variant IDs before a request', async () => {
    const { catalog, requestFetch } = setup();
    await expect(catalog.getProducts(['https://evil.test'], context)).rejects.toThrow();
    await expect(catalog.getVariant('11', context)).rejects.toThrow();
    expect(requestFetch).not.toHaveBeenCalled();
  });
});

describe('bounded private preview catalog approval', () => {
  const shop = 'pilot.myshopify.com';
  const approval: PreviewCatalogApproval = {
    purpose: 'private_preview', shop, version: 'preview-v1', approvedBy: 'Merchant pilot authorization',
    verifiedOn: '2026-10-01', expiresAt: '2026-10-08T00:00:00Z',
    products: [{ id: rawProduct.id, handle: rawProduct.handle, evidenceUrl: `https://${shop}/products/${rawProduct.handle}` }],
  };
  const privateProduct = { ...rawProduct, onlineStoreUrl: null,
    variants: { ...rawProduct.variants, nodes: [{ ...rawVariant, availableForSale: false, currentlyNotInStock: false }] } };
  const methods = ['search', 'getProducts', 'getVariant'] as const;
  function previewSetup(product: Omit<typeof rawProduct, 'onlineStoreUrl'> & { onlineStoreUrl: string | null } = privateProduct, options: { approval?: PreviewCatalogApproval | null; now?: () => number } = {}) {
    const requestFetch = vi.fn<typeof fetch>().mockImplementation(async () => response({
      products: { nodes: [product] }, nodes: [product], node: { ...product.variants.nodes[0]!, product },
    }));
    const catalog = new ShopifyCatalog({ shop, accessToken: 'test-token', approvedImageUrls: [], fetch: requestFetch,
      previewCatalog: options.approval === null ? undefined : options.approval ?? approval,
      experimentEnabled: false, now: options.now ?? (() => Date.parse('2026-10-01T12:00:00Z')) });
    return { requestFetch, catalog };
  }
  async function read(catalog: ShopifyCatalog, method: typeof methods[number], id = rawProduct.id) {
    if (method === 'search') return catalog.search('protein', context);
    if (method === 'getProducts') return catalog.getProducts([id], context);
    const result = await catalog.getVariant(rawVariant.id, context);
    return result ? [result.product] : [];
  }

  it.each(methods)('%s admits only reviewed live products and preserves unavailable commerce fields', async method => {
    const { catalog, requestFetch } = previewSetup();
    const result = await read(catalog, method);
    expect(result).toHaveLength(1);
    expect(result[0]!.variants[0]).toMatchObject({ id: rawVariant.id, price: rawVariant.price, availableForSale: false, currentlyNotInStock: false });
    expect(result[0]!.imageUrl).toBeNull();
    expect(requestFetch).toHaveBeenCalledOnce();
    await read(catalog, method);
    expect(requestFetch).toHaveBeenCalledTimes(2);
  });

  it.each(methods)('%s fails closed without approval, on ID/handle mismatch, before verification, and exactly at expiry', async method => {
    expect(await read(previewSetup(privateProduct, { approval: null }).catalog, method)).toEqual([]);
    const otherId = 'gid://shopify/Product/2';
    expect(await read(previewSetup({ ...privateProduct, id: otherId }).catalog, method, otherId)).toEqual([]);
    expect(await read(previewSetup({ ...privateProduct, handle: 'changed-handle' }).catalog, method)).toEqual([]);
    for (const instant of ['2026-09-30T23:59:59Z', '2026-10-08T00:00:00Z', '2026-10-09T00:00:00Z']) {
      expect(await read(previewSetup(privateProduct, { now: () => Date.parse(instant) }).catalog, method)).toEqual([]);
    }
  });

  it.each(methods)('%s rechecks expiry on every read while normally published products stay visible', async method => {
    let now = Date.parse('2026-10-07T23:59:59Z');
    const { catalog } = previewSetup(privateProduct, { now: () => now });
    expect(await read(catalog, method)).toHaveLength(1);
    now = Date.parse(approval.expiresAt);
    expect(await read(catalog, method)).toEqual([]);
    const published = { ...privateProduct, onlineStoreUrl: rawProduct.onlineStoreUrl };
    expect(await read(previewSetup(published, { now: () => now }).catalog, method)).toHaveLength(1);
  });

  it('rejects foreign tenant approval and refuses an enabled or unspecified experiment state', () => {
    const base = { shop, accessToken: 'test-token', approvedImageUrls: [], previewCatalog: approval };
    expect(() => new ShopifyCatalog(base)).toThrow();
    expect(() => new ShopifyCatalog({ ...base, experimentEnabled: true })).toThrow();
    expect(() => new ShopifyCatalog({ ...base, experimentEnabled: false, shop: 'other.myshopify.com' })).toThrow();
  });

  it('never fabricates a product or variant missing from the live response', async () => {
    const { catalog, requestFetch } = previewSetup();
    requestFetch.mockImplementation(async () => response({ products: { nodes: [] }, nodes: [null], node: null }));
    for (const method of methods) expect(await read(catalog, method)).toEqual([]);
    expect(requestFetch).toHaveBeenCalledTimes(3);
  });

  it('rechecks approval expiry after fetching extra variant pages', async () => {
    let now = Date.parse('2026-10-07T23:59:59Z');
    const { catalog, requestFetch } = previewSetup(privateProduct, { now: () => now });
    requestFetch.mockResolvedValueOnce(response({ nodes: [{ ...privateProduct, variants: { ...privateProduct.variants, pageInfo: { hasNextPage: true, endCursor: 'next' } } }] }));
    requestFetch.mockImplementationOnce(async () => {
      now = Date.parse(approval.expiresAt);
      return response({ product: { variants: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    });
    expect(await catalog.getProducts([rawProduct.id], context)).toEqual([]);
    expect(requestFetch).toHaveBeenCalledTimes(2);
  });
});
