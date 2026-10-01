import { describe, expect, it, vi } from 'vitest';
import { buildSearchQuery, ShopifyCatalog } from '../packages/shopify/src/catalog.js';
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
  it('does not list products unpublished on the Online Store channel', async () => {
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
