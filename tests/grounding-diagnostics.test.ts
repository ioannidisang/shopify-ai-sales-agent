import { describe, expect, it, vi } from 'vitest';
import { policyResponse, respond } from '../packages/core/src/respond.js';
import type { ConversationDraft, ConversationModel } from '../packages/core/src/conversation.js';
import type { ApprovedFact, Plan, Product, RespondInput, ShopConfig } from '../packages/core/src/types.js';

const product: Product = { id: 'gid://shopify/Product/1', title: 'Synthetic product', handle: 'synthetic', url: '/products/synthetic', imageUrl: null,
  variants: [{ id: 'gid://shopify/ProductVariant/11', legacyId: '11', title: 'Original', price: { amount: '25.00', currencyCode: 'EUR' }, availableForSale: true, currentlyNotInStock: false }] };
const shop: ShopConfig = { shop: 'synthetic.myshopify.com', brand: 'Synthetic', locale: 'en', allowedCountries: ['GR'], enabled: true,
  experiment: { id: 'test', enabled: false, treatmentPercent: 50 }, approvedImageUrls: [], knowledgeVersion: '1' };
const fact: ApprovedFact = { id: 'package', shop: shop.shop, locale: 'en', productId: product.id, text: 'The package contains 500 g.',
  source: 'https://example.com/package', approvedBy: 'Merchant', approvedAt: '2026-01-01T00:00:00Z', status: 'approved' };
const plan: Plan = { intent: 'facts', searchQuery: 'synthetic', productIds: [product.id], factIds: [fact.id], variantId: null, quantity: null };
const draft = (text: string, productIds = [product.id], factIds: string[] = []): ConversationDraft => ({ segments: [{ text, productIds, factIds }] });
function fixture(value: unknown = draft(fact.text, [product.id], [fact.id])) {
  const localFact = { ...fact };
  const composer = { compose: vi.fn<ConversationModel['compose']>().mockResolvedValue(value as ConversationDraft),
    verify: vi.fn<ConversationModel['verify']>().mockResolvedValue({ supported: true, medical: false }) };
  const observer = vi.fn();
  const input: RespondInput = { shop, facts: [localFact], message: 'Tell me the package size', history: [], country: 'GR', locale: 'en',
    planner: { plan: vi.fn().mockResolvedValue(plan) }, composer, onGroundingRejected: observer,
    catalog: { search: vi.fn().mockResolvedValue([product]), getProducts: vi.fn().mockResolvedValue([product]), getVariant: vi.fn() } };
  return { input, composer, observer, localFact };
}

describe('private operational grounding diagnostics', () => {
  it.each([
    { value: { segments: [] }, stage: 'schema_check', policy: 'unavailable' },
    { value: draft('Synthetic detail', ['gid://shopify/Product/999']), stage: 'reference_check', policy: 'unavailable' },
    { value: draft('This product is available.'), stage: 'card_check', policy: 'unavailable' },
    { value: draft('It costs 25 euros.'), stage: 'format_check', policy: 'unavailable' },
    { value: draft('It contains 900 g.'), stage: 'numeric_check', policy: 'unavailable' },
    { value: draft('This cures diabetes.'), stage: 'content_check', policy: 'medical' },
    { value: draft('This supports better sleep.'), stage: 'content_check', policy: 'unavailable' },
  ] as const)('reports only $stage and preserves the existing fallback %#', async ({ value, stage, policy }) => {
    const { input, composer, observer } = fixture(value);
    expect(await respond(input)).toEqual(policyResponse('en', policy));
    expect(observer).toHaveBeenCalledExactlyOnceWith(stage);
    expect(composer.verify).not.toHaveBeenCalled();
    expect(JSON.stringify(observer.mock.calls)).not.toContain(product.id);
    expect(JSON.stringify(observer.mock.calls)).not.toContain('medical');
    expect(JSON.stringify(observer.mock.calls)).not.toContain('diabetes');
  });

  it.each([false, true])('uses the same generic semantic check for either verifier rejection medical=%s', async medical => {
    const { input, composer, observer } = fixture();
    composer.verify.mockResolvedValue({ supported: false, medical });
    expect(await respond(input)).toEqual(policyResponse('en', medical ? 'medical' : 'unavailable'));
    expect(observer).toHaveBeenCalledExactlyOnceWith('semantic_check');
  });

  it('identifies malformed verification without copying schema errors and identifies revoked sources separately', async () => {
    const malformed = fixture();
    malformed.composer.verify.mockResolvedValue({ privatePayload: 'never log this' } as never);
    expect(await respond(malformed.input)).toEqual(policyResponse('en', 'unavailable'));
    expect(malformed.observer).toHaveBeenCalledExactlyOnceWith('schema_check');
    const revoked = fixture();
    revoked.composer.verify.mockImplementation(async () => {
      revoked.localFact.status = 'revoked';
      return { supported: true, medical: false };
    });
    expect(await respond(revoked.input)).toEqual(policyResponse('en', 'unavailable'));
    expect(revoked.observer).toHaveBeenCalledExactlyOnceWith('source_freshness');
  });

  it('does not let an observer failure alter the exact fallback or report unknown provider error content', async () => {
    const failedObserver = fixture(draft('It contains 900 g.'));
    failedObserver.observer.mockImplementation(() => { throw new Error('private logging failure'); });
    expect(await respond(failedObserver.input)).toEqual(policyResponse('en', 'unavailable'));
    failedObserver.observer.mockRejectedValue(new Error('private asynchronous logging failure'));
    expect(await respond(failedObserver.input)).toEqual(policyResponse('en', 'unavailable'));
    const failedProvider = fixture();
    failedProvider.composer.verify.mockRejectedValue(new Error('private provider response'));
    expect(await respond(failedProvider.input)).toEqual(policyResponse('en', 'unavailable'));
    expect(failedProvider.observer).not.toHaveBeenCalled();
  });

  it('emits no diagnostic for checked success or the deterministic clinical request boundary', async () => {
    const success = fixture();
    expect((await respond(success.input)).text).toBe(fact.text);
    expect(success.observer).not.toHaveBeenCalled();
    const clinical = fixture();
    clinical.input.message = 'I have diabetes, can I take this?';
    expect(await respond(clinical.input)).toEqual(policyResponse('en', 'medical'));
    expect(clinical.observer).not.toHaveBeenCalled();
  });
});
