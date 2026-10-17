import { describe, expect, it } from 'vitest';
import { spokenPrices } from '../apps/server/src/spoken-prices.js';
import type { Product } from '../packages/core/src/types.js';

const card = (amount = '12.50'): Product => ({
  id: 'gid://shopify/Product/1', title: 'Untrusted catalog name', handle: 'item', url: 'https://example.com/item', imageUrl: null,
  variants: [{ id: 'gid://shopify/ProductVariant/1', legacyId: '1', title: 'Default Title',
    price: { amount, currencyCode: 'EUR' }, availableForSale: false, currentlyNotInStock: false }],
});
describe('trusted spoken card prices', () => {
  it('reads the three live cards in order without narrating catalog names or availability', () => {
    const result = spokenPrices('Τιμές για τα 3 παραπάνω προϊόντα;', [card('12.50'), card('21.99'), card('0.00')], 'el');
    expect(result).toBe('Οι τιμές στις κάρτες, με τη σειρά που εμφανίζονται, είναι: 12,50 ευρώ, 21,99 ευρώ, 0,00 ευρώ.');
    expect(result).not.toMatch(/Untrusted|διαθεσιμ|αποθεμα/);
  });
  it('requires an explicit current price question', () => {
    for (const question of ['Πες μου για D3', 'Εκτιμώ τη βοήθεια', 'Είναι διαθέσιμο;', 'Good night',
      'Δεν με ενδιαφέρουν οι τιμές', 'Δεν θέλω τιμές', 'Χωρίς τιμές', "Don't tell me prices", 'No prices please']) {
      expect(spokenPrices(question, [card()], 'el')).toBe('');
    }
    expect(spokenPrices('How much does it cost?', [card()], 'en')).toBe('The price on the card is 12.50 euros.');
  });
  it('does not compute totals or discounts and uses only the supplied current snapshot', () => {
    const product = card('20.00');
    expect(spokenPrices('Τιμή για 3 τεμάχια με έκπτωση;', [product], 'el')).toBe('Η τιμή στην κάρτα είναι 20,00 ευρώ.');
    product.variants[0]!.price.amount = '22.00';
    expect(spokenPrices('Ποια είναι η τιμή;', [product], 'el')).toContain('22,00 ευρώ');
  });
  it('declines ambiguous, nonstandard or invalid cards without partial quoting', () => {
    const multiple = card(); multiple.variants.push({ ...multiple.variants[0]!, id: 'gid://shopify/ProductVariant/2' });
    const subscription = { ...card(), requiresSellingPlan: true };
    const bundle = card(); bundle.variants[0]!.requiresComponents = true;
    const foreign = card(); foreign.variants[0]!.price.currencyCode = 'USD';
    const empty = card(); empty.variants = [];
    for (const invalid of [multiple, subscription, bundle, foreign, empty,
      ...['NaN', '-1', '1,50', '1.001', '1e3', '1234567890', '12 ευρώ'].map(card)]) {
      expect(spokenPrices('τιμές;', [card(), invalid], 'el')).toBe('');
    }
    expect(spokenPrices('τιμές;', [], 'el')).toBe('');
    expect(spokenPrices('τιμές;', Array.from({ length: 5 }, () => card()), 'el')).toBe('');
  });
});
