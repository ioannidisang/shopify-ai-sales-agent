import type { Product } from './types.js';

// Bound the first-pass context without silently omitting a product or variant.
export const SMALL_CATALOG_MAX_PRODUCTS = 12;
export const SMALL_CATALOG_MAX_VARIANTS = 24;

export function fitsSmallCatalogContext(products: Product[]): boolean {
  if (products.length > SMALL_CATALOG_MAX_PRODUCTS || new Set(products.map(product => product.id)).size !== products.length) return false;
  const variants = products.flatMap(product => product.variants);
  return variants.length <= SMALL_CATALOG_MAX_VARIANTS
    && new Set(variants.map(variant => variant.id)).size === variants.length
    && products.every(product => /^gid:\/\/shopify\/Product\/\d+$/.test(product.id) && product.title.length <= 300)
    && variants.every(variant => /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variant.id) && variant.title.length <= 300);
}
