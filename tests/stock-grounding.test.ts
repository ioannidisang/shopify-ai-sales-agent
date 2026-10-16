import { describe, expect, it, vi } from 'vitest';
import { verifyGrounded } from '../packages/core/src/grounding.js';
import type { ConversationInput, ConversationModel } from '../packages/core/src/conversation.js';

const product = { id: 'gid://shopify/Product/1', title: 'Example Omega', handle: 'example-omega', url: '/products/example-omega', imageUrl: null,
  variants: [{ id: 'gid://shopify/ProductVariant/11', legacyId: '11', title: 'Default Title', price: { amount: '25.00', currencyCode: 'EUR' },
    availableForSale: false, currentlyNotInStock: false }] };
const fact = { id: 'pack', productId: product.id, text: 'Το προϊόν διατίθεται σε συσκευασία 90 καψουλών.', source: 'https://example.com/label' };
const input: ConversationInput = { message: 'Tell me about Example Omega.', history: [], locale: 'en', brand: 'Example', instructions: '', examples: [],
  products: [product], facts: [fact], intent: 'facts' };
const composer = (): ConversationModel => ({ compose: vi.fn(), verify: vi.fn().mockResolvedValue({ supported: true, medical: false }) });

describe('stock statements stay in live product cards', () => {
  it.each([
    'Το Example Omega δεν είναι διαθέσιμο αυτή τη στιγμή.', 'Το προϊόν είναι διαθέσιμο.', 'Μη διαθέσιμο προϊόν.',
    'Το Example Omega είναι εξαντλημένο.', 'Εξαντλήθηκε.', 'Ετοιμοπαράδοτο.', 'Το προϊόν είναι σε έλλειψη.',
    'Το προϊόν είναι σε απόθεμα.', 'Το προϊόν είναι εκτός αποθέματος.', 'Δεν υπάρχει απόθεμα.', 'Διαθέτουμε απόθεμα.',
    'This product is out of stock.', 'This product is in stock.', 'Sold out.', 'This item is on backorder.',
    'The product is ready to ship.', 'Example Omega is currently unavailable.', 'Example Omega is not available.',
    'Example Omega is available now.',
  ])('rejects even an uncited zero-evidence stock assertion: %s', async text => {
    const model = composer();
    await expect(verifyGrounded(model, { ...input, products: [], facts: [], intent: 'clarify' },
      { segments: [{ text, productIds: [], factIds: [] }] })).rejects.toThrow('could not be verified');
    expect(model.verify).not.toHaveBeenCalled();
  });

  it('does not authorize prose stock status even when the cited current variant is really unavailable', async () => {
    const model = composer();
    await expect(verifyGrounded(model, input, { segments: [{ text: 'Example Omega is out of stock.', productIds: [product.id], factIds: [] }] }))
      .rejects.toThrow('could not be verified');
    expect(model.verify).not.toHaveBeenCalled();
  });

  it.each([
    'Το προϊόν διατίθεται σε συσκευασία 90 καψουλών.', 'Το προϊόν είναι διαθέσιμο σε συσκευασία 90 καψουλών.',
    'The product is available in a package of 90 capsules.',
    'Δες την τρέχουσα τιμή και τη διαθεσιμότητα στην κάρτα του προϊόντος.',
    'The product card shows its current price and availability.',
  ])('preserves packaging descriptions and neutral directions to current cards: %s', async text => {
    const model = composer();
    expect(await verifyGrounded(model, input, { segments: [{ text, productIds: [product.id], factIds: [fact.id] }] })).toBe(text);
    expect(model.verify).toHaveBeenCalledOnce();
  });

  it.each([
    'Δεν έχω εγκεκριμένες πληροφορίες για αυτό.', 'Δεν έχω διαθέσιμες εγκεκριμένες πληροφορίες για αυτό.',
    'Οι πληροφορίες δεν είναι διαθέσιμες.', 'I do not have approved information about this.',
    'I have no available approved information about this.', 'Approved information is not currently available.',
  ])('does not mistake missing evidence for a stock assertion: %s', async text => {
    const model = composer();
    expect(await verifyGrounded(model, { ...input, products: [], facts: [] }, { segments: [{ text, productIds: [], factIds: [] }] })).toBe(text);
    expect(model.verify).toHaveBeenCalledOnce();
  });

  it('cannot hide an additional stock claim behind an evidence-absence phrase', async () => {
    const model = composer();
    await expect(verifyGrounded(model, { ...input, products: [], facts: [] }, { segments: [{
      text: 'Δεν έχω διαθέσιμες πληροφορίες. Το προϊόν είναι διαθέσιμο.', productIds: [], factIds: [],
    }] })).rejects.toThrow('could not be verified');
    expect(model.verify).not.toHaveBeenCalled();
  });

  it.each([
    'You can check whether it is available on the card.', 'Check on the product card if it is available.',
    'Δες στην κάρτα αν είναι διαθέσιμο.', 'Μπορείς να δεις αν είναι διαθέσιμο στην κάρτα του προϊόντος.',
  ])('permits a conditional direction only with its cited current card: %s', async text => {
    const model = composer();
    const cited = { segments: [{ text, productIds: [product.id], factIds: [] }] };
    expect(await verifyGrounded(model, input, cited)).toBe(text);
    expect(model.verify).toHaveBeenCalledOnce();
    model.verify = vi.fn().mockResolvedValue({ supported: true, medical: false });
    await expect(verifyGrounded(model, { ...input, products: [], facts: [] }, { segments: [{ text, productIds: [], factIds: [] }] }))
      .rejects.toThrow('could not be verified');
    expect(model.verify).not.toHaveBeenCalled();
  });

  it.each([{ ...product, requiresSellingPlan: true }, { ...product, variants: [] }])
  ('does not promise a current-card availability check when no availability is displayed', async card => {
    const model = composer();
    await expect(verifyGrounded(model, { ...input, products: [card] }, { segments: [{
      text: 'You can check whether it is available on the card.', productIds: [product.id], factIds: [],
    }] })).rejects.toThrow('could not be verified');
    expect(model.verify).not.toHaveBeenCalled();
  });

  it.each([
    'You can check whether it is available on the card. It is available.',
    'Δες στην κάρτα αν είναι διαθέσιμο, γιατί είναι διαθέσιμο.',
    'Θέλεις να δούμε τις διαθέσιμες επιλογές; Το προϊόν είναι διαθέσιμο.',
    'I am available to help. The product is available.',
  ])('rejects a mixed status assertion despite a permitted neutral direction: %s', async text => {
    const model = composer();
    await expect(verifyGrounded(model, input, { segments: [{ text, productIds: [product.id], factIds: [] }] }))
      .rejects.toThrow('could not be verified');
    expect(model.verify).not.toHaveBeenCalled();
  });

  it.each([
    'Θέλεις να δούμε τις διαθέσιμες επιλογές;', 'Θα ήθελες να συγκρίνουμε τις διαθέσιμες επιλογές;',
    'Would you like to see the available options?', 'I am available to help.', 'Είμαι διαθέσιμος να σε βοηθήσω.',
  ])('preserves uncited neutral shopping invitations and assistant availability: %s', async text => {
    const model = composer();
    expect(await verifyGrounded(model, { ...input, products: [], facts: [] }, { segments: [{ text, productIds: [], factIds: [] }] })).toBe(text);
    expect(model.verify).toHaveBeenCalledOnce();
  });
});
