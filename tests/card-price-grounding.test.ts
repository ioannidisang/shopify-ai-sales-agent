import { describe, expect, it, vi } from 'vitest';
import { verifyGrounded } from '../packages/core/src/grounding.js';
import type { ConversationDraft, ConversationInput, ConversationModel } from '../packages/core/src/conversation.js';
import type { Product } from '../packages/core/src/types.js';

const products: Product[] = ['Alpha', 'Beta', 'Gamma'].map((title, index) => ({
  id: `gid://shopify/Product/${index + 1}`, title, handle: title.toLowerCase(), url: `/products/${title.toLowerCase()}`, imageUrl: null,
  variants: [{ id: `gid://shopify/ProductVariant/${index + 11}`, legacyId: String(index + 11), title: 'Default Title',
    price: { amount: '25.00', currencyCode: 'EUR' }, availableForSale: false, currentlyNotInStock: false }],
}));
const input: ConversationInput = { brand: 'Synthetic', locale: 'el', message: 'Ποιες είναι οι τιμές για αυτές τις επιλογές;',
  history: [{ role: 'assistant', content: 'Synthetic catalog options', context: { productIds: products.map(product => product.id), factIds: [] } }],
  instructions: '', examples: [], products, facts: [], intent: 'facts' };
const draft = (text: string, productIds = products.map(product => product.id)): ConversationDraft => ({ segments: [{ text, productIds, factIds: [] }] });
const model = (): ConversationModel => ({ compose: vi.fn(), verify: vi.fn().mockResolvedValue({ supported: true, medical: false }) });

describe('grounded current-card price directions', () => {
  it.each([
    'Οι τιμές είναι διαθέσιμες στις κάρτες των προϊόντων.',
    'Οι τρέχουσες τιμές των 3 προϊόντων εμφανίζονται στις αντίστοιχες κάρτες.',
    'Δες τις τιμές των 3 προϊόντων στις κάρτες τους.',
    'Μπορείς να δεις τις διαθέσιμες τιμές στις κάρτες των προϊόντων.',
    'The prices are available on the product cards.',
    'The current prices of the 3 products are displayed in their cards.',
    'You can check the prices for these 3 products on the corresponding product cards.',
  ])('allows only a card UI reference and still independently verifies: %s', async text => {
    const composer = model();
    expect(await verifyGrounded(composer, input, draft(text))).toBe(text);
    expect(composer.verify).toHaveBeenCalledExactlyOnceWith(input, draft(text));
  });

  it('uses the cited current cards, not all current candidates or historical cards, to validate a count', async () => {
    const composer = model();
    const selected = [products[1]!.id, products[2]!.id];
    const text = 'Δες τις τρέχουσες τιμές των 2 προϊόντων στις κάρτες τους.';
    expect(await verifyGrounded(composer, input, draft(text, selected))).toBe(text);
    await expect(verifyGrounded(composer, input, draft('Δες τις τιμές των 3 προϊόντων στις κάρτες τους.', selected))).rejects.toThrow();
    await expect(verifyGrounded(composer, input, draft('Δες τις τιμές των 3 προϊόντων στις κάρτες τους.', Array(3).fill(products[0]!.id)))).rejects.toThrow();
  });

  it.each([
    { ...input, products: [] },
    { ...input, products: products.map(product => ({ ...product, variants: [] })) },
    { ...input, products: products.map(product => ({ ...product, requiresSellingPlan: true })) },
  ])('does not promise price information from historical, absent or non-price card branches', async context => {
    const composer = model();
    const ids = context.products.map(product => product.id);
    await expect(verifyGrounded(composer, context, draft('Οι τιμές είναι διαθέσιμες στις κάρτες των προϊόντων.', ids))).rejects.toThrow();
    expect(composer.verify).not.toHaveBeenCalled();
  });

  it.each([
    'Δες τις τιμές των 4 προϊόντων στις κάρτες τους.',
    'The prices for 2 products are available on the cards.',
    'Οι τιμές είναι διαθέσιμες στις κάρτες. Τα προϊόντα είναι διαθέσιμα.',
    'The prices are available on the cards, and the products are in stock.',
    'Δες τις τιμές των 3 προϊόντων στις κάρτες τους. Περιέχουν 3 κάψουλες.',
    'You can check the prices of 3 products on the cards. Take 3 capsules.',
    'Οι τιμές είναι διαθέσιμες στις κάρτες: 25 ευρώ.',
    'The prices are available on the cards: €25.',
    'The price is 25 on the product card.',
    'Δες τις τιμές των 3 προϊόντων στις κάρτες τους: https://example.com.',
    'Check the price on the card. I added it to your cart.',
  ])('cannot use a UI/count reference to authorize a mixed or unsupported claim: %s', async text => {
    const composer = model();
    await expect(verifyGrounded(composer, input, draft(text))).rejects.toThrow();
    expect(composer.verify).not.toHaveBeenCalled();
  });

  it('rejects an incorrect card count even if that number happens to appear in a product title', async () => {
    const composer = model();
    const context = { ...input, products: products.map(product => ({ ...product, title: `${product.title} 4` })) };
    await expect(verifyGrounded(composer, context, draft('Δες τις τιμές των 4 προϊόντων στις κάρτες τους.'))).rejects.toThrow();
    expect(composer.verify).not.toHaveBeenCalled();
  });

  it('does not exempt valid UI phrasing from semantic or medical verification', async () => {
    const composer = model();
    const text = 'Δες τις τιμές των 3 προϊόντων στις κάρτες τους.';
    vi.mocked(composer.verify).mockResolvedValueOnce({ supported: false, medical: false }).mockResolvedValueOnce({ supported: true, medical: true });
    await expect(verifyGrounded(composer, input, draft(text))).rejects.toThrow();
    await expect(verifyGrounded(composer, input, draft(text))).rejects.toMatchObject({ medical: true });
    expect(composer.verify).toHaveBeenCalledTimes(2);
  });
});
