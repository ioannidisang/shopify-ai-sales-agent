import { describe, expect, it, vi } from 'vitest';
import { isMedicalRequest, isSleepWellbeingRequest, MEDICAL_HISTORY_MARKER } from '../packages/core/src/policy.js';
import { respond } from '../packages/core/src/respond.js';
import { verifyGrounded } from '../packages/core/src/grounding.js';
import type { ConversationDraft, ConversationInput, ConversationModel } from '../packages/core/src/conversation.js';
import type { ApprovedFact, Plan, Product, RespondInput, ShopConfig } from '../packages/core/src/types.js';

const product: Product = { id: 'gid://shopify/Product/1', title: 'Good Night', handle: 'good-night', url: '/products/good-night', imageUrl: null,
  variants: [{ id: 'gid://shopify/ProductVariant/11', legacyId: '11', title: 'Default Title', price: { amount: '20.00', currencyCode: 'EUR' },
    availableForSale: true, currentlyNotInStock: false }] };
const shop: ShopConfig = { shop: 'pilot.myshopify.com', brand: 'Pilot', locale: 'el', enabled: true, allowedCountries: ['GR'],
  experiment: { id: 'test', enabled: false, treatmentPercent: 50 }, approvedImageUrls: [], knowledgeVersion: '1' };
const fact: ApprovedFact = { id: 'composition', productId: product.id, shop: shop.shop, locale: 'el',
  text: 'Το Good Night περιέχει μελατονίνη.', source: 'https://example.com/label', approvedBy: 'Merchant', approvedAt: '2026-01-01T00:00:00Z', status: 'approved' };
const plan: Plan = { intent: 'facts', searchQuery: '', productIds: [product.id], factIds: [fact.id], variantId: null, quantity: null };
const neutral = 'Δεν έχω εγκεκριμένες πληροφορίες για αυτόν τον στόχο. Θέλεις να συγκρίνουμε συστατικά ή μορφή;';
const draft = (text: string, productIds: string[] = [], factIds: string[] = []): ConversationDraft => ({ segments: [{ text, productIds, factIds }] });
const composer = (): ConversationModel => ({
  compose: vi.fn().mockResolvedValue(draft(neutral)), verify: vi.fn().mockResolvedValue({ supported: true, medical: false }),
  selectAndCompose: vi.fn().mockResolvedValue({ plan, draft: draft(fact.text, [product.id], [fact.id]) }),
});
function request(overrides: Partial<RespondInput> = {}): RespondInput {
  return { shop, facts: [fact], message: 'Με ενδιαφέρει η βελτίωση του ύπνου.', history: [], country: 'GR', locale: 'el',
    planner: { plan: vi.fn().mockResolvedValue(plan) }, composer: composer(),
    catalog: { getCompleteSmallCatalog: vi.fn().mockResolvedValue([product]), search: vi.fn().mockResolvedValue([product]),
      getProducts: vi.fn().mockResolvedValue([product]), getVariant: vi.fn().mockResolvedValue({ product, variant: product.variants[0]! }) }, ...overrides };
}
const composition: ConversationInput = { message: 'Θέλω να κοιμάμαι καλύτερα.', history: [], locale: 'el', brand: 'Pilot', instructions: '', examples: [],
  products: [], facts: [], intent: 'wellbeing_information_limit' };

describe('narrow unsupported sleep-goal scope', () => {
  it.each([
    'Με ενδιαφέρει η βελτίωση του ύπνου.', 'Θέλω κάτι για να κοιμάμαι καλύτερα.',
    'Ψάχνω καλύτερο ύπνο.', 'Κάτι για τον ύπνο;', 'Το Good Night βοηθάει στον ύπνο;',
    'Το Good Night μπορεί να βοηθήσει στον ύπνο.', 'Τι περιέχει το Good Night και θα με βοηθήσει να κοιμάμαι καλύτερα;',
    'I want to sleep better.', 'Can you recommend something for better sleep?', 'Does Good Night help with sleep?',
    'Good Night for sleep?', 'I am interested in improving sleep quality.', 'Which product supports a good night of sleep?',
  ])('recognizes the current goal or effect request: %s', message => {
    expect(isMedicalRequest(message)).toBe(false);
    expect(isSleepWellbeingRequest(message)).toBe(true);
  });

  it.each([
    'Θέλω Good Night.', 'Τι περιέχει το Good Night;', 'Πόσα γραμμάρια έχει το Good Night;',
    'Πόσο κοστίζει το Good Night;', 'Ποια είναι τα συστατικά του συμπληρώματος ύπνου Good Night;',
    'Does Good Night contain melatonin?', 'What are the ingredients of this sleep supplement?', 'Show me SleepWell.',
  ])('does not turn a named-product factual query into a goal: %s', message => {
    expect(isSleepWellbeingRequest(message)).toBe(false);
  });

  it.each(['Έχω αϋπνία.', 'Θέλω κάτι για την αϋπνία.', 'Δεν μπορώ να κοιμηθώ εδώ και εβδομάδες.',
    'I have insomnia.', "I can't sleep for weeks.", 'What is safe with my medication for sleep?'])
  ('keeps symptoms and medical suitability on the clinical boundary: %s', async message => {
    expect(isMedicalRequest(message)).toBe(true);
    expect(isSleepWellbeingRequest(message)).toBe(false);
    const input = request({ message });
    expect((await respond(input)).policy).toBe('medical');
    expect(input.composer!.compose).not.toHaveBeenCalled();
    expect(input.catalog.getCompleteSmallCatalog).not.toHaveBeenCalled();
  });

  it('generates a neutral answer with no catalog cues, keeps history, and still independently verifies it', async () => {
    const history = [{ role: 'assistant' as const, content: 'Previous product information', context: { productIds: [product.id], factIds: [fact.id] } }];
    const input = request({ history });
    const response = await respond(input);
    expect(response).toMatchObject({ text: neutral, products: [], facts: [] });
    expect(response.policy).toBeUndefined();
    expect(response.pendingAction).toBeUndefined();
    expect(input.planner.plan).not.toHaveBeenCalled();
    expect(input.composer!.selectAndCompose).not.toHaveBeenCalled();
    expect(input.composer!.compose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ products: [], facts: [], history, intent: 'wellbeing_information_limit' }));
    expect(input.composer!.verify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ products: [], facts: [], history }), draft(neutral));
    expect(input.catalog.getCompleteSmallCatalog).not.toHaveBeenCalled();
    expect(input.catalog.search).not.toHaveBeenCalled();
    expect(input.catalog.getProducts).not.toHaveBeenCalled();
    expect(input.catalog.getVariant).not.toHaveBeenCalled();
  });

  it('does not override a medical verdict from retained clinical history', async () => {
    const history = [{ role: 'user' as const, content: MEDICAL_HISTORY_MARKER }];
    const input = request({ history, message: 'Με ενδιαφέρει να βελτιώσω την ποιότητα του ύπνου μου.' });
    vi.mocked(input.composer!.verify).mockResolvedValue({ supported: false, medical: true });
    expect((await respond(input)).policy).toBe('medical');
    expect(input.composer!.verify).toHaveBeenCalledWith(expect.objectContaining({ history }), expect.anything());
  });

  it('allows an independent later named-product question while retaining the earlier goal in history', async () => {
    const history = [{ role: 'user' as const, content: 'Θέλω να κοιμάμαι καλύτερα.' }];
    const input = request({ history, message: 'Τι περιέχει το Good Night;' });
    const response = await respond(input);
    expect(response.policy).toBeUndefined();
    expect(response.text).toBe(fact.text);
    expect(response.products).toEqual([product]);
    expect(input.composer!.compose).not.toHaveBeenCalled();
    expect(input.composer!.selectAndCompose).toHaveBeenCalledWith(expect.objectContaining({ history }));
    expect(input.composer!.verify).toHaveBeenCalledWith(expect.objectContaining({ history }), expect.anything());
  });

  it('cannot turn a fabricated current reference into a recommendation during the neutral route', async () => {
    const input = request();
    vi.mocked(input.composer!.compose).mockResolvedValue(draft('Το Good Night.', [product.id], [fact.id]));
    expect((await respond(input)).policy).toBe('unavailable');
    expect(input.composer!.verify).not.toHaveBeenCalled();
  });

  it.each(['product card alone', 'composition citation', 'pending cart'])
  ('rejects a goal-linked %s even with a permissive verifier', async kind => {
    const model = composer();
    const input = { ...composition,
      ...(kind === 'product card alone' ? { products: [product] } : {}),
      ...(kind === 'composition citation' ? { facts: [fact] } : {}),
      ...(kind === 'pending cart' ? { pendingAction: { kind: 'add' as const, variantId: product.variants[0]!.id, quantity: 1 } } : {}) };
    await expect(verifyGrounded(model, input, draft('Δες αυτή την επιλογή.'))).rejects.toThrow('could not be verified');
    expect(model.verify).not.toHaveBeenCalled();
  });

  it.each(['Το Good Night βοηθάει στον ύπνο.', 'Το Good Night μπορεί να βοηθήσει στον ύπνο.', 'Good Night supports better sleep.'])
  ('rejects an unsolicited product benefit in a factual answer: %s', async text => {
    const model = composer();
    await expect(verifyGrounded(model, { ...composition, message: 'Τι περιέχει το Good Night;', intent: 'facts', products: [product], facts: [fact] },
      draft(text, [product.id], [fact.id]))).rejects.toThrow('could not be verified');
    expect(model.verify).not.toHaveBeenCalled();
  });

  it('allows ordinary ingredient evidence after an earlier goal, and allows generated neutral questions', async () => {
    const model = composer();
    expect(await verifyGrounded(model, { ...composition, message: 'Τι περιέχει το Good Night;', intent: 'facts', products: [product], facts: [fact],
      history: [{ role: 'user', content: 'I want better sleep.' }] }, draft(fact.text, [product.id], [fact.id]))).toBe(fact.text);
    expect(await verifyGrounded(model, composition, draft(neutral))).toBe(neutral);
    expect(model.verify).toHaveBeenCalledTimes(2);
  });
});
