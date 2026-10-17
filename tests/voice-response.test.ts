import { describe, expect, it, vi } from 'vitest';
import { respond } from '../packages/core/src/respond.js';
import type { ConversationDraft, ConversationModel } from '../packages/core/src/conversation.js';
import type { ApprovedFact, Plan, Product, RespondInput, ShopConfig } from '../packages/core/src/types.js';

const product: Product = { id: 'gid://shopify/Product/1', title: 'Plain powder', handle: 'plain', url: '/products/plain', imageUrl: null,
  variants: [{ id: 'gid://shopify/ProductVariant/11', legacyId: '11', title: 'Original', price: { amount: '25.00', currencyCode: 'EUR' }, availableForSale: true, currentlyNotInStock: false }] };
const shop: ShopConfig = { shop: 'pilot.myshopify.com', brand: 'Pilot', locale: 'el', allowedCountries: ['GR'], enabled: true,
  experiment: { id: 'test', enabled: false, treatmentPercent: 50 }, approvedImageUrls: [], knowledgeVersion: '1' };
const fact: ApprovedFact = { id: 'package', shop: shop.shop, locale: 'el', productId: product.id, text: 'Η συσκευασία είναι 500 g.',
  source: 'https://example.com/package', approvedBy: 'Merchant', approvedAt: '2026-01-01T00:00:00Z', status: 'approved' };
const plan: Plan = { intent: 'facts', searchQuery: 'powder', productIds: [product.id], factIds: [fact.id], variantId: null, quantity: null };
const draft: ConversationDraft = { segments: [{ text: fact.text, productIds: [product.id], factIds: [fact.id] }] };
function fixture(complete: boolean) {
  const fresh = { ...product, variants: [{ ...product.variants[0]!, price: { amount: '27.00', currencyCode: 'EUR' } }] };
  const composer = { compose: vi.fn<ConversationModel['compose']>().mockResolvedValue(draft),
    selectAndCompose: vi.fn<NonNullable<ConversationModel['selectAndCompose']>>().mockResolvedValue({ plan, draft }),
    verify: vi.fn<ConversationModel['verify']>().mockResolvedValue({ supported: true, medical: false }) };
  const input: RespondInput = { shop, facts: [fact], message: 'Τι περιέχει το Plain powder;', history: [], country: 'GR', locale: 'el', responseMode: 'voice',
    planner: { plan: vi.fn().mockResolvedValue(plan) }, composer,
    catalog: { getCompleteSmallCatalog: vi.fn().mockResolvedValue(complete ? [product] : null), search: vi.fn().mockResolvedValue([product]),
      getProducts: vi.fn().mockResolvedValue([fresh]), getVariant: vi.fn() } };
  return { input, composer, fresh };
}

describe('voice presentation without changing the grounding boundary', () => {
  it.each([true, false])('preserves final live reads and independent checks in the complete-catalog=%s path', async complete => {
    const { input, composer, fresh } = fixture(complete);
    const response = await respond(input);
    expect(response.policy).toBeUndefined();
    expect(response.text).toBe(draft.segments[0]!.text);
    expect(response.products).toEqual([fresh]);
    expect(composer.selectAndCompose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ responseMode: 'voice', products: [product] }));
    expect(input.catalog.getProducts).toHaveBeenCalledExactlyOnceWith([product.id], { country: 'GR', locale: 'el' });
    expect(composer.verify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ responseMode: 'voice', products: [fresh], facts: [expect.objectContaining({ id: fact.id })] }), draft);
    expect(composer.compose).not.toHaveBeenCalled();
  });

  it('generates a plain sleep information limit with no product suggestion and still independently checks it', async () => {
    const { input, composer } = fixture(true);
    input.message = 'Θέλω κάτι για καλύτερο ύπνο';
    const answer = { segments: [{ text: 'Δεν έχω τις πληροφορίες που χρειάζονται για να προτείνω κάποιο προϊόν για καλύτερο ύπνο. Ποιο συστατικό σε ενδιαφέρει;', productIds: [], factIds: [] }] };
    composer.compose.mockResolvedValue(answer);
    const response = await respond(input);
    expect(response.policy).toBeUndefined();
    expect(response.text).toBe(answer.segments[0]!.text);
    expect(response.products).toEqual([]);
    expect(response.facts).toEqual([]);
    expect(composer.compose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ responseMode: 'voice', intent: 'wellbeing_information_limit', products: [], facts: [] }));
    expect(composer.verify).toHaveBeenCalledOnce();
    expect(composer.selectAndCompose).not.toHaveBeenCalled();
    expect(input.catalog.getCompleteSmallCatalog).not.toHaveBeenCalled();
  });

  it('keeps medical handling deterministic and refuses unsupported voice drafts', async () => {
    const clinical = fixture(true);
    clinical.input.message = 'Έχω αϋπνία, ποιο να πάρω;';
    expect((await respond(clinical.input)).policy).toBe('medical');
    expect(clinical.composer.selectAndCompose).not.toHaveBeenCalled();
    expect(clinical.composer.compose).not.toHaveBeenCalled();
    const unsupported = fixture(true);
    unsupported.composer.verify.mockResolvedValue({ supported: false, medical: false });
    const response = await respond(unsupported.input);
    expect(response.policy).toBe('unavailable');
    expect(response.products).toEqual([]);
    expect(response.text).not.toBe(draft.segments[0]!.text);
  });

  it('leaves text composition without a voice delivery hint', async () => {
    const { input, composer } = fixture(true);
    delete input.responseMode;
    await respond(input);
    expect(composer.selectAndCompose.mock.calls[0]![0]).not.toHaveProperty('responseMode');
    expect(composer.verify.mock.calls[0]![0]).not.toHaveProperty('responseMode');
  });
});
