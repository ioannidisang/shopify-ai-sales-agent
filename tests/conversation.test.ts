import { describe, expect, it, vi } from 'vitest';
import { respond } from '../packages/core/src/respond.js';
import { composeGrounded } from '../packages/core/src/grounding.js';
import { conversationContext } from '../packages/core/src/model-protocol.js';
import type { ConversationDraft, ConversationInput, ConversationModel } from '../packages/core/src/conversation.js';
import type { ApprovedFact, Plan, Product, RespondInput, ShopConfig } from '../packages/core/src/types.js';

const product: Product = {
  id: 'gid://shopify/Product/1', title: 'Plain Protein', handle: 'plain-protein', url: '/products/plain-protein', imageUrl: null,
  variants: [{ id: 'gid://shopify/ProductVariant/11', legacyId: '11', title: 'Vanilla', price: { amount: '25.00', currencyCode: 'EUR' }, availableForSale: true, currentlyNotInStock: false }],
};
const shop: ShopConfig = { shop: 'pilot.myshopify.com', brand: 'Pilot', locale: 'el', allowedCountries: ['GR'], enabled: true,
  experiment: { id: 'test', enabled: false, treatmentPercent: 50 }, approvedImageUrls: [], knowledgeVersion: '1',
  conversation: { version: 'voice-1', instructions: 'Speak briefly and ask one useful question.', examples: [{ user: 'Hello', assistant: 'Welcome. What are you looking for?' }], approvedBy: 'Merchant', approvedAt: '2026-01-01T00:00:00Z' } };
const fact: ApprovedFact = { id: 'size', shop: shop.shop, locale: 'el', productId: product.id, text: 'Η συσκευασία περιέχει 500 g.',
  source: 'https://example.com/label', approvedBy: 'Merchant', approvedAt: '2026-01-01T00:00:00Z', status: 'approved' };
const plan: Plan = { intent: 'search', searchQuery: 'protein', productIds: [product.id], factIds: [], variantId: null, quantity: null };
const draft = (text: string, productIds: string[] = [], factIds: string[] = []): ConversationDraft => ({ segments: [{ text, productIds, factIds }] });
const model = (value = draft('Θέλεις να ξεκινήσουμε από κάποια γεύση;')): ConversationModel => ({
  compose: vi.fn().mockResolvedValue(value), verify: vi.fn().mockResolvedValue({ supported: true, medical: false }),
});
function request(overrides: Partial<RespondInput> = {}): RespondInput {
  return { shop, facts: [fact], message: 'Θέλω πρωτεΐνη', history: [], country: 'GR', locale: 'el',
    planner: { plan: vi.fn().mockResolvedValue(plan) }, composer: model(),
    catalog: { search: vi.fn().mockResolvedValue([product]), getProducts: vi.fn().mockResolvedValue([product]),
      getVariant: vi.fn().mockResolvedValue({ product, variant: product.variants[0]! }) }, ...overrides };
}
const composition: ConversationInput = { message: 'Tell me the package size', history: [], brand: 'Pilot', locale: 'en',
  instructions: '', examples: [], products: [product], facts: [fact], intent: 'facts' };

describe('generated conversation with evidence checks', () => {
  it('displays newly composed Greek and passes merchant guidance, never a shared sales template', async () => {
    const input = request();
    const response = await respond(input);
    expect(response.text).toBe('Θέλεις να ξεκινήσουμε από κάποια γεύση;');
    expect(response.products).toEqual([product]);
    expect(input.composer!.compose).toHaveBeenCalledWith(expect.objectContaining({ brand: 'Pilot', instructions: shop.conversation!.instructions, examples: shop.conversation!.examples }));
    expect(input.composer!.verify).toHaveBeenCalledOnce();
    expect(input.planner.plan).toHaveBeenCalledWith(expect.objectContaining({ guidance: { instructions: shop.conversation!.instructions, examples: shop.conversation!.examples } }));
  });
  it('composes greetings without catalog access and without needing approved product facts', async () => {
    const input = request({ facts: [], message: 'Γεια!', planner: { plan: vi.fn().mockResolvedValue({ ...plan, intent: 'greeting' }) } });
    expect((await respond(input)).text).toBe('Θέλεις να ξεκινήσουμε από κάποια γεύση;');
    expect(input.catalog.search).not.toHaveBeenCalled();
  });
  it('permits a supported paraphrase with the correct product and fact references', async () => {
    const text = 'Θα βρεις 500 g μέσα στη συσκευασία.';
    expect(await composeGrounded(model(draft(text, [product.id], [fact.id])), composition)).toBe(text);
  });
  it('permits natural price-card guidance with a product reference and no invented price or fact', async () => {
    const text = 'Την τρέχουσα τιμή και τη διαθεσιμότητα θα τις δεις στην κάρτα του προϊόντος.';
    const composer = model(draft(text, [product.id]));
    expect(await composeGrounded(composer, { ...composition, facts: [] })).toBe(text);
    expect(composer.verify).toHaveBeenCalledOnce();
  });
  it('distinguishes commerce shown in the current card from values omitted from prose context', () => {
    const composing = conversationContext(composition);
    const verifying = conversationContext(composition, true);
    expect(composing.productCards).toEqual([{ productId: product.id, showsPrice: true, showsAvailability: true }]);
    expect(verifying.productCards).toEqual(composing.productCards);
    expect(composing.products[0]!.variants[0]).not.toHaveProperty('price');
    expect(composing.products[0]!.variants[0]).not.toHaveProperty('availableForSale');
    expect(verifying.products[0]!.variants[0]!.price).toEqual(product.variants[0]!.price);
  });
  it('never represents historical cards or non-purchasable card branches as currently showing prices', () => {
    const history = [{ role: 'assistant' as const, content: 'A previous choice', context: { productIds: [product.id], factIds: [] } }];
    expect(conversationContext({ ...composition, products: [], history }).productCards).toEqual([]);
    for (const unavailableCard of [{ ...product, requiresSellingPlan: true }, { ...product, variants: [] }]) {
      expect(conversationContext({ ...composition, products: [unavailableCard] }).productCards)
        .toEqual([{ productId: product.id, showsPrice: false, showsAvailability: false }]);
    }
  });
  it('answers a Greek capsule-package question using approved evidence and a fresh price card', async () => {
    const capsuleProduct = { ...product, title: 'Dr. Magnesium Bisglycinate' };
    const packagingFact = { ...fact, text: 'Η συσκευασία περιέχει 90 κάψουλες.' };
    const text = 'Η συσκευασία περιέχει 90 κάψουλες. Δες την τρέχουσα τιμή στην κάρτα.';
    const input = request({
      message: 'Θέλω το Dr. Magnesium Bisglycinate. Τι περιέχει, πόσες κάψουλες έχει και πόσο κοστίζει;',
      facts: [packagingFact],
      planner: { plan: vi.fn().mockResolvedValue({ ...plan, intent: 'facts', factIds: [fact.id] }) },
      composer: model(draft(text, [product.id], [fact.id])),
      catalog: { search: vi.fn().mockResolvedValue([capsuleProduct]), getProducts: vi.fn().mockResolvedValue([capsuleProduct]),
        getVariant: vi.fn() },
    });
    const response = await respond(input);
    expect(response.policy).toBeUndefined();
    expect(response.text).toBe(text);
    expect(response.facts[0]?.text).toBe(packagingFact.text);
    expect(response.products[0]?.variants[0]?.price).toEqual(product.variants[0]!.price);
    expect(input.catalog.getProducts).toHaveBeenCalledWith([product.id], { country: 'GR', locale: 'el' });
    expect(input.composer!.verify).toHaveBeenCalledOnce();
  });
  it.each([
    draft('Buy this', ['gid://shopify/Product/999']), draft('A fact', [], ['foreign-fact']),
    draft('Contains 900 g.', [product.id], [fact.id]), draft('It costs €25.', [product.id]),
    draft('Visit https://unknown.example'), draft('I added it to your cart.', [product.id]),
    draft('Πρόσθεσα το προϊόν.', [product.id]), draft('Contains 500 g.', [], [fact.id]),
  ])('rejects invalid references, unsupported numeric values, generated prices and claimed cart writes before verification', async value => {
    const composer = model(value);
    await expect(composeGrounded(composer, composition)).rejects.toThrow();
    expect(composer.verify).not.toHaveBeenCalled();
  });
  it('does not mistake a real citation for proof of the composed assertion', async () => {
    const composer = model(draft('This is the most effective product.', [product.id], [fact.id]));
    vi.mocked(composer.verify).mockResolvedValue({ supported: false, medical: false });
    await expect(composeGrounded(composer, composition)).rejects.toThrow('could not be verified');
  });
  it('never promotes a shopper-supplied number into a product specification', async () => {
    const composer = model(draft('Contains 900 g.', [product.id], [fact.id]));
    await expect(composeGrounded(composer, { ...composition, message: 'Is it 900 g?' })).rejects.toThrow();
    expect(composer.verify).not.toHaveBeenCalled();
  });
  it('rejects obvious treatment claims even if a model would incorrectly approve them', async () => {
    const composer = model(draft('This cures diabetes.', [product.id]));
    await expect(composeGrounded(composer, composition)).rejects.toThrow();
    expect(composer.verify).not.toHaveBeenCalled();
  });
  it('ignores an unreviewed conversation profile', async () => {
    const input = request({ shop: { ...shop, conversation: { ...shop.conversation!, approvedBy: undefined, approvedAt: undefined } } });
    await respond(input);
    expect(input.composer!.compose).toHaveBeenCalledWith(expect.objectContaining({ instructions: '', examples: [] }));
  });
  it('withholds all generated text and product proposals after semantic verification failure', async () => {
    const input = request();
    vi.mocked(input.composer!.verify).mockResolvedValue({ supported: false, medical: false });
    const response = await respond(input);
    expect(response.policy).toBe('unavailable');
    expect(response.products).toEqual([]);
    expect(response.pendingAction).toBeUndefined();
  });
  it('withholds facts revoked while the model was composing', async () => {
    const localFact = { ...fact };
    const input = request({ facts: [localFact], planner: { plan: vi.fn().mockResolvedValue({ ...plan, intent: 'facts', factIds: [fact.id] }) } });
    vi.mocked(input.composer!.compose).mockImplementation(async () => {
      localFact.status = 'revoked';
      return draft('Η συσκευασία περιέχει 500 g.', [product.id], [fact.id]);
    });
    const response = await respond(input);
    expect(response.policy).toBe('unavailable');
    expect(response.facts).toEqual([]);
  });
  it('keeps a medical retention marker when the final check identifies clinical intent', async () => {
    const input = request();
    vi.mocked(input.composer!.verify).mockResolvedValue({ supported: false, medical: true });
    const response = await respond(input);
    expect(response.policy).toBe('medical');
    expect(response.products).toEqual([]);
  });
  it('does not transmit a detected medical request to the composer', async () => {
    const input = request({ message: 'Έχω διαβήτη, ποιο να πάρω;' });
    expect((await respond(input)).policy).toBe('medical');
    expect(input.composer!.compose).not.toHaveBeenCalled();
  });
  it('fails closed on malformed drafts and provider errors without leaking their contents', async () => {
    const input = request();
    vi.mocked(input.composer!.compose).mockRejectedValue(new Error('secret-provider-payload'));
    const response = await respond(input);
    expect(response.policy).toBe('unavailable');
    expect(JSON.stringify(response)).not.toContain('secret-provider-payload');
  });
  it('re-reads previous cards in display order for references such as the second product', async () => {
    const second = { ...product, id: 'gid://shopify/Product/2', title: 'Second Protein' };
    const input = request({ message: 'Το δεύτερο', history: [{ role: 'assistant', content: 'Here are options', context: { productIds: [product.id, second.id], factIds: [] } }] });
    vi.mocked(input.catalog.getProducts).mockResolvedValueOnce([second, product]).mockResolvedValue([second]);
    vi.mocked(input.planner.plan).mockResolvedValue({ ...plan, searchQuery: '', productIds: [second.id] });
    const response = await respond(input);
    expect(vi.mocked(input.planner.plan).mock.calls[0]![0].products.map(item => item.id)).toEqual([product.id, second.id]);
    expect(response.products.map(item => item.id)).toEqual([second.id]);
    expect(input.catalog.search).not.toHaveBeenCalled();
  });
});
