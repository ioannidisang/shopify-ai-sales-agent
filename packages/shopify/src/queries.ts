// Validated against Shopify Storefront API 2026-07. No merchant data is embedded.
export const PRODUCT_FIELDS = `
  id title handle onlineStoreUrl requiresSellingPlan
  featuredImage { url }
  variants(first: 100) {
    nodes { id title price { amount currencyCode } availableForSale currentlyNotInStock requiresComponents quantityRule { minimum maximum increment } }
    pageInfo { hasNextPage endCursor }
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
