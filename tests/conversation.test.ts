import { describe, expect, it, vi } from 'vitest';
import { respond } from '../packages/core/src/respond.js';
import { composeGrounded } from '../packages/core/src/grounding.js';
import { conversationContext } from '../packages/core/src/model-protocol.js';
import { MEDICAL_HISTORY_MARKER } from '../packages/core/src/policy.js';
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
  it('answers a new factual product request after a medical marker without erasing safety context', async () => {
    const history = [{ role: 'user' as const, content: MEDICAL_HISTORY_MARKER },
      { role: 'assistant' as const, content: 'Please ask a health professional for personal advice.' }];
    const before = structuredClone(history);
    const input = request({ message: 'Θέλω ασβέστιο', history });
    const result = await respond(input);
    expect(result.policy).toBeUndefined();
    expect(result.products).toEqual([product]);
    expect(input.planner.plan).toHaveBeenCalledWith(expect.objectContaining({ history }));
    expect(input.composer!.compose).toHaveBeenCalledWith(expect.objectContaining({ history }));
    expect(input.composer!.verify).toHaveBeenCalledWith(expect.objectContaining({ history }), expect.anything());
    expect(history).toEqual(before);
    const followup = request({ message: 'Ναι, βάλε αυτό', history: [...history,
      { role: 'user', content: input.message }, { role: 'assistant', content: result.text }] });
    expect((await respond(followup)).policy).toBe('medical');
    expect(followup.planner.plan).not.toHaveBeenCalled();
  });
  it('retains ordinary budget and preference history for a newly named product', async () => {
    const history = [{ role: 'user' as const, content: 'My budget is modest and I prefer vanilla.' }];
    const input = request({ message: 'Show me protein', history });
    await respond(input);
    expect(input.planner.plan).toHaveBeenCalledWith(expect.objectContaining({ history }));
    expect(input.composer!.compose).toHaveBeenCalledWith(expect.objectContaining({ history }));
  });
  it('still rejects medical implications found by verification after a fresh product request', async () => {
    const input = request({ message: 'Θέλω ασβέστιο', history: [{ role: 'user', content: MEDICAL_HISTORY_MARKER }] });
    vi.mocked(input.composer!.verify).mockResolvedValue({ supported: false, medical: true });
    const result = await respond(input);
    expect(result.policy).toBe('medical');
    expect(result.products).toEqual([]);
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
  it('avoids duplicate planning only for identical no-search context and still re-reads the final selection', async () => {
    const input = request({ message: 'Τι περιέχει;', history: [{ role: 'assistant', content: 'An option',
      context: { productIds: [product.id], factIds: [fact.id] } }] });
    vi.mocked(input.planner.plan).mockResolvedValue({ ...plan, searchQuery: '', intent: 'facts', factIds: [fact.id] });
    const result = await respond(input);
    expect(input.planner.plan).toHaveBeenCalledOnce();
    expect(input.catalog.search).not.toHaveBeenCalled();
    expect(input.catalog.getProducts).toHaveBeenCalledTimes(2);
    expect(input.composer!.compose).toHaveBeenCalledOnce();
    expect(input.composer!.verify).toHaveBeenCalledOnce();
    expect(result.products).toEqual([product]);
  });
  it('plans again without a search when fact scoping changed the model context', async () => {
    const anotherFact = { ...fact, id: 'another', productId: 'gid://shopify/Product/2' };
    const input = request({ facts: [fact, anotherFact], message: 'Τι περιέχει;', history: [{ role: 'assistant', content: 'An option',
      context: { productIds: [product.id], factIds: [fact.id] } }] });
    vi.mocked(input.planner.plan).mockResolvedValue({ ...plan, searchQuery: '', intent: 'facts', factIds: [fact.id] });
    await respond(input);
    expect(input.planner.plan).toHaveBeenCalledTimes(2);
    expect(input.catalog.search).not.toHaveBeenCalled();
    expect(input.catalog.getProducts).toHaveBeenCalledTimes(2);
  });
  it('does not reuse a plan when a catalog search ran but returned no additional products', async () => {
    const input = request({ history: [{ role: 'assistant', content: 'An option', context: { productIds: [product.id], factIds: [] } }] });
    vi.mocked(input.catalog.search).mockResolvedValue([]);
    await respond(input);
    expect(input.planner.plan).toHaveBeenCalledTimes(2);
    expect(input.catalog.getProducts).toHaveBeenCalledTimes(2);
  });
});

describe('combined product selection and composition', () => {
  function combinedRequest(overrides: Partial<RespondInput> = {}) {
    const composer: ConversationModel = {
      ...model(),
      selectAndCompose: vi.fn().mockResolvedValue({ plan: { ...plan, intent: 'facts', factIds: [fact.id] },
        draft: draft('Η συσκευασία περιέχει 500 g.', [product.id], [fact.id]) }),
    };
    return request({ composer, ...overrides });
  }

  it('uses three model calls, keeps fresh commerce, and verifies only selected final evidence', async () => {
    const second = { ...product, id: 'gid://shopify/Product/2', title: 'Unselected powder' };
    const input = combinedRequest();
    const freshProduct = { ...product, variants: [{ ...product.variants[0]!, price: { amount: '29.90', currencyCode: 'EUR' }, availableForSale: false }] };
    vi.mocked(input.catalog.search).mockResolvedValue([product, second]);
    vi.mocked(input.catalog.getProducts).mockResolvedValue([freshProduct]);
    const result = await respond(input);
    expect(result.policy).toBeUndefined();
    expect(result.text).toBe('Η συσκευασία περιέχει 500 g.');
    expect(result.products).toEqual([freshProduct]);
    expect(input.planner.plan).toHaveBeenCalledOnce();
    expect(input.composer!.selectAndCompose).toHaveBeenCalledOnce();
    expect(input.composer!.compose).not.toHaveBeenCalled();
    expect(input.composer!.verify).toHaveBeenCalledOnce();
    expect(input.composer!.verify).toHaveBeenCalledWith(expect.objectContaining({ products: [freshProduct],
      facts: [{ id: fact.id, productId: product.id, text: fact.text, source: fact.source }] }), expect.anything());
    expect(input.catalog.getProducts).toHaveBeenCalledWith([product.id], { country: 'GR', locale: 'el' });
  });

  it.each(['unselected product', 'wrong product fact', 'generated price', 'unsupported quantity'])('rejects %s before semantic verification', async kind => {
    const second = { ...product, id: 'gid://shopify/Product/2' };
    const otherFact = { ...fact, id: 'other-fact', productId: second.id };
    const input = combinedRequest({ facts: [fact, otherFact] });
    vi.mocked(input.catalog.search).mockResolvedValue([product, second]);
    const value = kind === 'unselected product' ? draft('Here is another product.', [second.id])
      : kind === 'wrong product fact' ? draft('Contains 500 g.', [product.id], [otherFact.id])
        : kind === 'generated price' ? draft('It costs €25.', [product.id]) : draft('Contains 900 g.', [product.id], [fact.id]);
    vi.mocked(input.composer!.selectAndCompose!).mockResolvedValue({ plan: { ...plan, factIds: [fact.id, otherFact.id] }, draft: value });
    expect((await respond(input)).policy).toBe('unavailable');
    expect(input.composer!.verify).not.toHaveBeenCalled();
    expect(input.composer!.compose).not.toHaveBeenCalled();
  });

  it('never verifies a search-snapshot assertion when the selected product disappeared', async () => {
    const input = combinedRequest();
    vi.mocked(input.catalog.getProducts).mockResolvedValue([]);
    expect((await respond(input)).policy).toBe('unavailable');
    expect(input.composer!.verify).not.toHaveBeenCalled();
  });

  it.each(['select', 'verify'])('withholds facts revoked during %s', async stage => {
    const mutable = { ...fact };
    const input = combinedRequest({ facts: [mutable] });
    if (stage === 'select') vi.mocked(input.composer!.selectAndCompose!).mockImplementation(async () => {
      mutable.status = 'revoked';
      return { plan: { ...plan, factIds: [fact.id] }, draft: draft('Contains 500 g.', [product.id], [fact.id]) };
    });
    else vi.mocked(input.composer!.verify).mockImplementation(async () => {
      mutable.status = 'revoked';
      return { supported: true, medical: false };
    });
    const result = await respond(input);
    expect(result.policy).toBe('unavailable');
    expect(result.facts).toEqual([]);
  });

  it('retains clinical markers for independent factual requests in selection and verification', async () => {
    const history = [{ role: 'user' as const, content: MEDICAL_HISTORY_MARKER }];
    const input = combinedRequest({ message: 'Θέλω ασβέστιο', history });
    expect((await respond(input)).policy).toBeUndefined();
    expect(input.composer!.selectAndCompose).toHaveBeenCalledWith(expect.objectContaining({ history }));
    expect(input.composer!.verify).toHaveBeenCalledWith(expect.objectContaining({ history }), expect.anything());
  });

  it('honors a clinical classification even when combined output includes a harmless-looking draft', async () => {
    const input = combinedRequest();
    vi.mocked(input.composer!.selectAndCompose!).mockResolvedValue({ plan: { ...plan, intent: 'medical' }, draft: draft('Hello') });
    expect((await respond(input)).policy).toBe('medical');
    expect(input.catalog.getProducts).not.toHaveBeenCalled();
    expect(input.composer!.verify).not.toHaveBeenCalled();
  });

  it('verifies empty-selection clarification without paying for another composition', async () => {
    const input = combinedRequest();
    vi.mocked(input.composer!.selectAndCompose!).mockResolvedValue({ plan: { ...plan, intent: 'clarify', productIds: [], factIds: [] },
      draft: draft('Προτιμάς κάψουλες ή σκόνη;') });
    const result = await respond(input);
    expect(result.text).toBe('Προτιμάς κάψουλες ή σκόνη;');
    expect(result.products).toEqual([]);
    expect(input.composer!.compose).not.toHaveBeenCalled();
    expect(input.composer!.verify).toHaveBeenCalledOnce();
  });

  it('retains a separate composition after final variant validation for explicit cart requests', async () => {
    const input = combinedRequest({ message: 'Add the vanilla product to my cart' });
    vi.mocked(input.planner.plan).mockResolvedValue({ ...plan, intent: 'add_to_cart', variantId: product.variants[0]!.id, quantity: 1 });
    const result = await respond(input);
    expect(result.pendingAction).toEqual({ kind: 'add', variantId: product.variants[0]!.id, quantity: 1 });
    expect(input.composer!.selectAndCompose).not.toHaveBeenCalled();
    expect(input.catalog.getVariant).toHaveBeenCalledOnce();
    expect(input.composer!.compose).toHaveBeenCalledWith(expect.objectContaining({ pendingAction: result.pendingAction }));
    expect(input.composer!.verify).toHaveBeenCalledOnce();
  });

  it('discards a combined cart draft and never promotes model intent into shopper authorization', async () => {
    const input = combinedRequest();
    vi.mocked(input.composer!.selectAndCompose!).mockResolvedValue({
      plan: { ...plan, intent: 'add_to_cart', variantId: product.variants[0]!.id, quantity: 1 }, draft: draft('I added it to your cart.'),
    });
    const result = await respond(input);
    expect(result.pendingAction).toBeUndefined();
    expect(input.catalog.getVariant).not.toHaveBeenCalled();
    expect(result.text).not.toContain('added');
    expect(input.composer!.compose).toHaveBeenCalledWith(expect.objectContaining({ intent: 'clarify' }));
  });

  it('withholds the complete combined answer when semantic support is rejected', async () => {
    const input = combinedRequest();
    vi.mocked(input.composer!.verify).mockResolvedValue({ supported: false, medical: false });
    const result = await respond(input);
    expect(result.policy).toBe('unavailable');
    expect(result.products).toEqual([]);
    expect(result.facts).toEqual([]);
  });
});
