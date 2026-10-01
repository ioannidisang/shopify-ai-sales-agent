import { z } from 'zod';
import type { Catalog, CatalogContext, PreviewCatalogApproval, Product, ProductVariant } from '../../core/src/types.js';
import { GET_MORE_VARIANTS, GET_PRODUCTS, GET_VARIANT, SEARCH_PRODUCTS } from './queries.js';
import { previewCatalogSchema } from './preview-catalog.js';

export const STOREFRONT_API_VERSION = '2026-07';
const productId = /^gid:\/\/shopify\/Product\/\d+$/;
const variantId = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/;
const variantSchema = z.object({
  id: z.string().regex(variantId), title: z.string(),
  price: z.object({ amount: z.string().regex(/^\d+(?:\.\d+)?$/), currencyCode: z.string().regex(/^[A-Z]{3}$/) }),
  availableForSale: z.boolean(), currentlyNotInStock: z.boolean(),
  requiresComponents: z.boolean(),
  quantityRule: z.object({ minimum: z.number().int().min(1), maximum: z.number().int().nullable(), increment: z.number().int().min(1) }),
});
const variantsSchema = z.object({
  nodes: z.array(variantSchema),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
});
const productSchema = z.object({
  id: z.string().regex(productId), title: z.string(), handle: z.string().min(1),
  onlineStoreUrl: z.string().nullable(), featuredImage: z.object({ url: z.string() }).nullable(),
  requiresSellingPlan: z.boolean(),
  variants: variantsSchema,
});
type RawProduct = z.infer<typeof productSchema>;
type RawVariant = z.infer<typeof variantSchema>;

export class CatalogError extends Error {
  constructor(public readonly code: 'unavailable' | 'invalid_response' | 'invalid_request' = 'unavailable') {
    super('Live product information is unavailable.'); this.name = 'CatalogError';
  }
}

export interface ShopifyCatalogOptions {
  shop: string; accessToken: string; approvedImageUrls: string[];
  fetch?: typeof fetch; timeoutMs?: number;
  previewCatalog?: PreviewCatalogApproval; experimentEnabled?: boolean; now?: () => number;
}

/** Build a bounded literal product search, never an LLM-authored Shopify query. */
export function buildSearchQuery(text: string): string {
  const words = text.normalize('NFKC').match(/[\p{L}\p{N}]{2,40}/gu)?.slice(0, 8) ?? [];
  return words.map(word => `(title:${word}* OR product_type:${word}*)`).join(' OR ');
}

export class ShopifyCatalog implements Catalog {
  private readonly endpoint: string;
  private readonly accessToken: string;
  private readonly requestFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly approvedImages: Set<string>;
  private readonly previewCatalog: PreviewCatalogApproval | undefined;
  private readonly now: () => number;

  constructor(options: ShopifyCatalogOptions) {
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(options.shop) || !options.accessToken.trim()) throw new CatalogError('invalid_request');
    this.endpoint = `https://${options.shop}/api/${STOREFRONT_API_VERSION}/graphql.json`;
    this.accessToken = options.accessToken;
    this.requestFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.now = options.now ?? Date.now;
    if (options.previewCatalog) {
      const approval = previewCatalogSchema.safeParse(options.previewCatalog);
      if (!approval.success || approval.data.shop !== options.shop || options.experimentEnabled !== false) throw new CatalogError('invalid_request');
      this.previewCatalog = approval.data;
    }
    this.approvedImages = new Set(options.approvedImageUrls.filter(url => {
      try { return new URL(url).protocol === 'https:'; } catch { return false; }
    }));
  }

  private canDisplay(raw: RawProduct): boolean {
    if (raw.onlineStoreUrl !== null) return true;
    // Password protection can also suppress this URL. Only a reviewed, expiring
    // preview exception may display those products; it never overrides stock.
    const approval = this.previewCatalog;
    const now = this.now();
    return Boolean(approval && Number.isFinite(now)
      && now >= Date.parse(`${approval.verifiedOn}T00:00:00Z`)
      && now < Date.parse(approval.expiresAt)
      && approval.products.some(product => product.id === raw.id && product.handle === raw.handle));
  }

  private async query(query: string, variables: Record<string, unknown>, context: CatalogContext): Promise<unknown> {
    if (!/^[A-Z]{2}$/.test(context.country) || !['el', 'en'].includes(context.locale)) throw new CatalogError('invalid_request');
    try {
      const response = await this.requestFetch(this.endpoint, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': this.accessToken },
        body: JSON.stringify({ query, variables: { ...variables, country: context.country, language: context.locale.toUpperCase() } }),
        signal: context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new CatalogError();
      const returnedVersion = response.headers.get('x-shopify-api-version');
      if (returnedVersion && returnedVersion !== STOREFRONT_API_VERSION) throw new CatalogError('invalid_response');
      const payload = z.object({ data: z.unknown().optional(), errors: z.array(z.unknown()).optional() }).parse(await response.json());
      if (payload.errors?.length || payload.data == null) throw new CatalogError('invalid_response');
      return payload.data;
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      throw new CatalogError();
    }
  }

  private mapVariant(raw: RawVariant): ProductVariant {
    return { ...raw, legacyId: variantId.exec(raw.id)![1]! };
  }

  private mapProduct(raw: RawProduct): Product {
    const imageUrl = raw.featuredImage?.url ?? null;
    return {
      id: raw.id, title: raw.title, handle: raw.handle,
      // Relative, store-local URLs cannot leak a user to a model-supplied host.
      url: `/products/${encodeURIComponent(raw.handle)}`,
      imageUrl: imageUrl && this.approvedImages.has(imageUrl) ? imageUrl : null,
      variants: raw.variants.nodes.map(variant => this.mapVariant(variant)),
      requiresSellingPlan: raw.requiresSellingPlan,
    };
  }

  async search(query: string, context: CatalogContext): Promise<Product[]> {
    try {
      const data = z.object({ products: z.object({ nodes: z.array(productSchema) }) }).parse(
        await this.query(SEARCH_PRODUCTS, { query: buildSearchQuery(query.slice(0, 160)) }, context));
      return data.products.nodes.filter(product => this.canDisplay(product)).map(product => this.mapProduct(product));
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      throw new CatalogError('invalid_response');
    }
  }

  async getProducts(ids: string[], context: CatalogContext): Promise<Product[]> {
    if (ids.length > 12 || ids.some(id => !productId.test(id))) throw new CatalogError('invalid_request');
    if (!ids.length) return [];
    try {
      const data = z.object({ nodes: z.array(productSchema.nullable()) }).parse(await this.query(GET_PRODUCTS, { ids: [...new Set(ids)] }, context));
      const result: Product[] = [];
      for (const raw of data.nodes) {
        if (!raw || !ids.includes(raw.id) || !this.canDisplay(raw)) continue;
        let pageInfo = raw.variants.pageInfo;
        const allVariants = [...raw.variants.nodes];
        const seenCursors = new Set<string>();
        while (pageInfo.hasNextPage) {
          if (!pageInfo.endCursor || seenCursors.has(pageInfo.endCursor) || allVariants.length >= 2500) throw new CatalogError('invalid_response');
          seenCursors.add(pageInfo.endCursor);
          const next = z.object({ product: z.object({ variants: variantsSchema }).nullable() }).parse(
            await this.query(GET_MORE_VARIANTS, { id: raw.id, after: pageInfo.endCursor }, context));
          if (!next.product) throw new CatalogError('invalid_response');
          allVariants.push(...next.product.variants.nodes);
          pageInfo = next.product.variants.pageInfo;
        }
        const uniqueVariants = [...new Map(allVariants.map(variant => [variant.id, variant])).values()];
        if (this.canDisplay(raw)) result.push(this.mapProduct({ ...raw, variants: { nodes: uniqueVariants, pageInfo } }));
      }
      return result;
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      throw new CatalogError('invalid_response');
    }
  }

  async getVariant(id: string, context: CatalogContext): Promise<{ product: Product; variant: ProductVariant } | null> {
    if (!variantId.test(id)) throw new CatalogError('invalid_request');
    try {
      const data = z.object({ node: variantSchema.extend({ product: productSchema }).nullable() }).parse(await this.query(GET_VARIANT, { id }, context));
      if (!data.node || data.node.id !== id || !this.canDisplay(data.node.product)) return null;
      const { product, ...rawVariant } = data.node;
      const mappedProduct = this.mapProduct(product);
      const variant = this.mapVariant(rawVariant);
      // The requested variant may sit past the first page of its parent product.
      if (!mappedProduct.variants.some(existing => existing.id === variant.id)) mappedProduct.variants.push(variant);
      return { product: mappedProduct, variant };
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      throw new CatalogError('invalid_response');
    }
  }
}
