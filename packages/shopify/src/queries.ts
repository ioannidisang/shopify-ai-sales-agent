// Validated against Shopify Storefront API 2026-07. No merchant data is embedded.
const productFields = (variantLimit: number) => `
  id title handle onlineStoreUrl requiresSellingPlan
  featuredImage { url }
  variants(first: ${variantLimit}) {
    nodes { id title price { amount currencyCode } availableForSale currentlyNotInStock requiresComponents quantityRule { minimum maximum increment } }
    pageInfo { hasNextPage endCursor }
  }
`;
export const PRODUCT_FIELDS = productFields(100);

// One extra product/variant lets the adapter reject an oversized catalog instead
// of mistaking a full page for the full catalog. No cross-request commerce cache.
export const GET_COMPLETE_SMALL_CATALOG = `
  query SalesAgentCompleteSmallCatalog($country: CountryCode!, $language: LanguageCode!)
  @inContext(country: $country, language: $language) {
    products(first: 13) { nodes { ${productFields(25)} } pageInfo { hasNextPage } }
  }
`;

export const SEARCH_PRODUCTS = `
  query SalesAgentSearch($query: String!, $country: CountryCode!, $language: LanguageCode!)
  @inContext(country: $country, language: $language) {
    products(first: 12, query: $query) { nodes { ${PRODUCT_FIELDS} } }
  }
`;

export const GET_PRODUCTS = `
  query SalesAgentProducts($ids: [ID!]!, $country: CountryCode!, $language: LanguageCode!)
  @inContext(country: $country, language: $language) {
    nodes(ids: $ids) { ... on Product { ${PRODUCT_FIELDS} } }
  }
`;

export const GET_VARIANT = `
  query SalesAgentVariant($id: ID!, $country: CountryCode!, $language: LanguageCode!)
  @inContext(country: $country, language: $language) {
    node(id: $id) { ... on ProductVariant {
      id title price { amount currencyCode } availableForSale currentlyNotInStock requiresComponents quantityRule { minimum maximum increment }
      product { ${PRODUCT_FIELDS} }
    } }
  }
`;

export const GET_MORE_VARIANTS = `
  query SalesAgentMoreVariants($id: ID!, $after: String!, $country: CountryCode!, $language: LanguageCode!)
  @inContext(country: $country, language: $language) {
    product(id: $id) { variants(first: 100, after: $after) {
      nodes { id title price { amount currencyCode } availableForSale currentlyNotInStock requiresComponents quantityRule { minimum maximum increment } }
      pageInfo { hasNextPage endCursor }
    } }
  }
`;
