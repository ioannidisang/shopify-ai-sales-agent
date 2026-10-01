# Temporary catalog access for a closed storefront

The default catalog excludes any product whose live Storefront API `onlineStoreUrl` is null. This is conservative: Shopify staff also identifies storefront password protection as a cause of a null URL, even where the Online Store channel is selected. A null URL alone therefore cannot distinguish an unpublished product from a closed storefront.

For a merchant-authorized private pilot, the optional tenant `previewCatalog` configuration grants temporary display permission to particular product ID/handle pairs. It is not proof of publication. It does not change a Shopify product, its channels, stock, prices, claims, media, or the storefront password. The capability is reusable per tenant; application code contains no Nutri Tiger product IDs.

The configuration requires a tenant shop, version, approval attribution, verification date, expiration and one to twelve unique product ID/handle pairs with canonical same-shop product URLs. URLs containing credentials, query strings, fragments or another host are rejected. The expiration must fall within seven days of the verification date. Every catalog operation checks the ID and handle against a fresh Shopify response and checks the current time; expiration and future verification dates fail closed. Missing products and variants remain missing. Variant pagination also rechecks expiration before returning the result.

Live Shopify prices, variants and availability remain authoritative, including an unavailable result. The exception cannot carry commerce fields, claims or images. Add-to-cart continues to require an explicit shopper action and an available live variant through the existing Ajax cart flow. Removing password protection, changing inventory and publishing the live theme require their own authorized actions.

An experiment cannot be enabled while this configuration exists, including after it expires. Remove it and verify normal Storefront publication before starting an experiment or publishing the assistant. Synchronize the reviewed tenant configuration after deploying the backend; installing a new code version alone does not update an existing tenant row.

## Nutri Tiger pilot approval and verification

The merchant's 1 October 2026 direction authorized the closed-store Nutri Tiger pilot and assistant operation in a dedicated unpublished theme. Under that scope, the following product ID/handle pairs were read from the live Storefront API and independently verified in the authenticated unpublished storefront preview on 1 October 2026. The stored links are canonical product references; they are not authenticated preview links and are not evidence that the store is publicly accessible.

| Product ID | Handle | Canonical reference |
| --- | --- | --- |
| `gid://shopify/Product/10744522768731` | `hydro-whey-2kg` | [Product reference](https://ym5fhx-fa.myshopify.com/products/hydro-whey-2kg) |
| `gid://shopify/Product/10744529420635` | `creatine-mono-300g` | [Product reference](https://ym5fhx-fa.myshopify.com/products/creatine-mono-300g) |

Approval version: `nutri-private-preview-2026-10-01-v1`. The exception expires at **2026-10-08 00:00 UTC**. At verification the live API reported these variants unavailable; the preview exception preserves that result. No product claims or packshot images were approved by this catalog verification. A renewed exception requires another explicit review, a new version and newly verified evidence; it must never extend itself automatically.

## Sources

- [Shopify Storefront OnlineStorePublishable field definition](https://shopify.dev/docs/api/storefront/2026-07/interfaces/OnlineStorePublishable)
- [Shopify staff explanation of null product URLs and password protection](https://community.shopify.dev/t/how-to-correctly-generate-product-urls-in-a-multilingual-shopify-customer-account-extension/26330)
- [Locale-aware Ajax product lookup for independent storefront verification](https://shopify.dev/docs/api/ajax/reference/product)
