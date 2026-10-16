import { describe, expect, it, vi } from 'vitest';
import { respond } from '../packages/core/src/respond.js';
import { MEDICAL_HISTORY_MARKER } from '../packages/core/src/policy.js';
import type { ApprovedFact, Plan, Product, RespondInput, ShopConfig } from '../packages/core/src/types.js';
import type { ConversationDraft, ConversationModel } from '../packages/core/src/conversation.js';

const product: Product = {
  id: 'gid://shopify/Product/1', title: 'Plain Protein', handle: 'plain-protein', url: '/products/plain-protein', imageUrl: null,
  variants: [{ id: 'gid://shopify/ProductVariant/11', legacyId: '11', title: 'Vanilla', price: { amount: '25.00', currencyCode: 'EUR' },
    availableForSale: true, currentlyNotInStock: false }],
};
const shop: ShopConfig = { shop: 'pilot.myshopify.com', brand: 'Pilot', locale: 'el', allowedCountries: ['GR'], enabled: true,
  experiment: { id: 'test', enabled: false, treatmentPercent: 50 }, approvedImageUrls: [], knowledgeVersion: '1' };
const fact: ApprovedFact = { id: 'size', shop: shop.shop, locale: 'el', productId: product.id, text: 'Η συσκευασία περιέχει 500 g.',
  source: 'https://example.com/label', approvedBy: 'Merchant', approvedAt: '2026-01-01T00:00:00Z', status: 'approved' };
const plan: Plan = { intent: 'facts', searchQuery: '', productIds: [product.id], factIds: [fact.id], variantId: null, quantity: null };
const draft = (text = 'Η συσκευασία περιέχει 500 g.', productIds = [product.id], factIds = [fact.id]): ConversationDraft =>
  ({ segments: [{ text, productIds, factIds }] });
function request(overrides: Partial<RespondInput> = {}): RespondInput {
  return { shop, facts: [fact], message: 'Show me Plain Protein', history: [], country: 'GR', locale: 'el',
    planner: { plan: vi.fn().mockResolvedValue({ ...plan, searchQuery: 'protein' }) },
    composer: { selectAndCompose: vi.fn().mockResolvedValue({ plan, draft: draft() }),
      compose: vi.fn().mockResolvedValue(draft('Έλεγξε την επιλογή σου.', [], [])),
      verify: vi.fn().mockResolvedValue({ supported: true, medical: false }) },
    catalog: { getCompleteSmallCatalog: vi.fn().mockResolvedValue([product]), search: vi.fn().mockResolvedValue([product]),
      getProducts: vi.fn().mockResolvedValue([product]), getVariant: vi.fn().mockResolvedValue({ product, variant: product.variants[0]! }) },
    ...overrides };
}

describe('two-call conversation with a complete small live catalog', () => {
  it('skips search planning while retaining a final live read and independent selected-evidence verification', async () => {
    const input = request();
    const fresh = { ...product, variants: [{ ...product.variants[0]!, availableForSale: false, price: { amount: '28.00', currencyCode: 'EUR' } }] };
    vi.mocked(input.catalog.getProducts).mockResolvedValue([fresh]);
    const result = await respond(input);
    expect(result.policy).toBeUndefined();
    expect(result.products).toEqual([fresh]);
    expect(input.planner.plan).not.toHaveBeenCalled();
    expect(input.catalog.search).not.toHaveBeenCalled();
    expect(input.catalog.getProducts).toHaveBeenCalledOnce();
    expect(input.composer!.compose).not.toHaveBeenCalled();
    expect(input.composer!.selectAndCompose).toHaveBeenCalledOnce();
    expect(input.composer!.verify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ products: [fresh],
      facts: [{ id: fact.id, productId: fact.productId, text: fact.text, source: fact.source }] }), draft());
  });

  it('preserves display order and clinical history without re-reading historical cards separately', async () => {
    const second: Product = { ...product, id: 'gid://shopify/Product/2', variants: [{ ...product.variants[0]!, id: 'gid://shopify/ProductVariant/22' }] };
    const history = [{ role: 'user' as const, content: MEDICAL_HISTORY_MARKER },
      { role: 'assistant' as const, content: 'Previous options', context: { productIds: [second.id, product.id], factIds: [] } }];
    const input = request({ message: 'Θέλω ασβέστιο', history });
    vi.mocked(input.catalog.getCompleteSmallCatalog!).mockResolvedValue([product, second]);
    expect((await respond(input)).policy).toBeUndefined();
    expect(input.catalog.getProducts).toHaveBeenCalledOnce();
    expect(input.composer!.selectAndCompose).toHaveBeenCalledWith(expect.objectContaining({ products: [second, product], history }));
    expect(input.composer!.verify).toHaveBeenCalledWith(expect.objectContaining({ history }), expect.anything());
  });

  it('retains named-product evidence when the approved collection exceeds the per-turn evidence limit', async () => {
    const products = Array.from({ length: 12 }, (_, index) => ({ ...product, id: `gid://shopify/Product/${index + 1}`,
      title: index === 11 ? 'Named Zinc' : `Other item ${index + 1}`,
      variants: [{ ...product.variants[0]!, id: `gid://shopify/ProductVariant/${index + 100}` }] }));
    const facts = products.flatMap((item, index) => Array.from({ length: 3 }, (_, part) => ({ ...fact,
      id: `fact-${String(index).padStart(2, '0')}-${part}`, productId: item.id, text: `${item.title}: package description ${part}.` })));
    const input = request({ facts, message: 'Tell me about Named Zinc' });
    vi.mocked(input.catalog.getCompleteSmallCatalog!).mockResolvedValue(products);
    vi.mocked(input.composer!.selectAndCompose!).mockResolvedValue({ plan: { ...plan, intent: 'clarify', productIds: [], factIds: [] }, draft: draft('What would you like to know?', [], []) });
    await respond(input);
    const supplied = vi.mocked(input.composer!.selectAndCompose!).mock.calls[0]![0].facts;
    expect(supplied).toHaveLength(24);
    expect(supplied.filter(item => item.productId === products[11]!.id)).toHaveLength(3);
  });

  it.each(['incomplete', 'oversized', 'legacy'])('retains the existing search pipeline for %s catalogs', async reason => {
    const input = request();
    if (reason === 'legacy') delete input.catalog.getCompleteSmallCatalog;
    else vi.mocked(input.catalog.getCompleteSmallCatalog!).mockResolvedValue(reason === 'incomplete' ? null : Array(13).fill(product));
    expect((await respond(input)).policy).toBeUndefined();
    expect(input.planner.plan).toHaveBeenCalledOnce();
    expect(input.catalog.search).toHaveBeenCalledOnce();
    expect(input.composer!.verify).toHaveBeenCalledOnce();
  });

  it('handles a complete empty catalog as evidence for a verified clarification, not an extra search', async () => {
    const input = request();
    vi.mocked(input.catalog.getCompleteSmallCatalog!).mockResolvedValue([]);
    vi.mocked(input.composer!.selectAndCompose!).mockResolvedValue({ plan: { ...plan, intent: 'clarify', productIds: [], factIds: [] },
      draft: draft('Δεν έχω διαθέσιμη επιλογή στον κατάλογο.', [], []) });
    const result = await respond(input);
    expect(result.policy).toBeUndefined();
    expect(result.products).toEqual([]);
    expect(input.planner.plan).not.toHaveBeenCalled();
    expect(input.catalog.getProducts).not.toHaveBeenCalled();
    expect(input.composer!.verify).toHaveBeenCalledOnce();
  });

  it.each(['medical selection', 'medical verification', 'unsupported claim', 'revoked evidence', 'removed product', 'foreign reference', 'failed live read'])
  ('fails closed for %s', async reason => {
    const mutable = { ...fact };
    const input = request({ facts: [mutable] });
    if (reason === 'medical selection') vi.mocked(input.composer!.selectAndCompose!).mockResolvedValue({ plan: { ...plan, intent: 'medical' }, draft: null });
    if (reason === 'medical verification') vi.mocked(input.composer!.verify).mockResolvedValue({ supported: false, medical: true });
    if (reason === 'unsupported claim') vi.mocked(input.composer!.verify).mockResolvedValue({ supported: false, medical: false });
    if (reason === 'removed product') vi.mocked(input.catalog.getProducts).mockResolvedValue([]);
    if (reason === 'foreign reference') vi.mocked(input.composer!.selectAndCompose!).mockResolvedValue({ plan: { ...plan, productIds: ['gid://shopify/Product/999'] },
      draft: draft('Unknown product', ['gid://shopify/Product/999'], []) });
    if (reason === 'failed live read') vi.mocked(input.catalog.getCompleteSmallCatalog!).mockRejectedValue(new Error('private provider body'));
    if (reason === 'revoked evidence') vi.mocked(input.composer!.verify).mockImplementation(async () => { mutable.status = 'revoked'; return { supported: true, medical: false }; });
    const result = await respond(input);
    expect(result.policy).toBe(reason.startsWith('medical') ? 'medical' : 'unavailable');
    expect(result.products).toEqual([]);
    expect(result.facts).toEqual([]);
    expect(result.pendingAction).toBeUndefined();
    if (reason === 'foreign reference') expect(input.catalog.getProducts).not.toHaveBeenCalled();
  });

  it('keeps explicit cart requests on the existing live-variant validation and confirmation path', async () => {
    const input = request({ message: 'Add the vanilla product to my cart' });
    vi.mocked(input.planner.plan).mockResolvedValue({ ...plan, intent: 'add_to_cart', searchQuery: 'protein', variantId: product.variants[0]!.id, quantity: 1 });
    const result = await respond(input);
    expect(result.pendingAction).toEqual({ kind: 'add', variantId: product.variants[0]!.id, quantity: 1 });
    expect(input.catalog.getCompleteSmallCatalog).not.toHaveBeenCalled();
    expect(input.composer!.selectAndCompose).not.toHaveBeenCalled();
    expect(input.catalog.getVariant).toHaveBeenCalledOnce();
    expect(input.composer!.compose).toHaveBeenCalledWith(expect.objectContaining({ pendingAction: result.pendingAction }));
  });

  it('never treats a model cart selection as fresh shopper authorization', async () => {
    const input = request();
    vi.mocked(input.composer!.selectAndCompose!).mockResolvedValue({ plan: { ...plan, intent: 'add_to_cart', variantId: product.variants[0]!.id, quantity: 1 }, draft: null });
    const result = await respond(input);
    expect(result.pendingAction).toBeUndefined();
    expect(input.catalog.getVariant).not.toHaveBeenCalled();
    expect(input.composer!.compose).toHaveBeenCalledWith(expect.objectContaining({ intent: 'clarify' }));
  });

  it('does not probe the catalog for legacy composers or deterministic medical requests', async () => {
    const input = request();
    const { selectAndCompose: _unused, ...legacy } = input.composer as ConversationModel;
    input.composer = legacy;
    expect((await respond(input)).policy).toBeUndefined();
    expect(input.catalog.getCompleteSmallCatalog).not.toHaveBeenCalled();
    const medical = request({ message: 'Έχω διαβήτη, ποιο να πάρω;' });
    expect((await respond(medical)).policy).toBe('medical');
    expect(medical.catalog.getCompleteSmallCatalog).not.toHaveBeenCalled();
  });
});
