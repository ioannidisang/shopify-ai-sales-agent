import { describe, expect, it } from 'vitest';
import { compactSelectionReferences } from '../packages/core/src/selection-references.js';
import { selectionConversationContext } from '../packages/core/src/model-protocol.js';
import type { ConversationInput, ConversationSelection } from '../packages/core/src/conversation.js';

const product = { id: 'gid://shopify/Product/12345', title: 'An ordinary product', handle: 'ordinary', url: '/products/ordinary', imageUrl: null,
  variants: [{ id: 'gid://shopify/ProductVariant/67890', legacyId: '67890', title: 'Small', price: { amount: '10.00', currencyCode: 'EUR' },
    availableForSale: true, currentlyNotInStock: false }] };
const factId = 'knowledge_0123456789012345678901234567890123456789';
const input: ConversationInput = { message: 'What does the product contain?', history: [
  { role: 'user', content: 'Preserve my actual message p1 and 12345 verbatim.' },
  { role: 'assistant', content: 'Earlier factual response', context: { productIds: ['gid://shopify/Product/999', product.id], factIds: ['prior-fact', factId] } },
], locale: 'en', brand: 'Example', instructions: 'Be concise', examples: [{ user: 'Choose', assistant: 'Which size?' }], intent: 'classify_and_select',
  products: [product], facts: [{ id: factId, productId: product.id, text: 'The package contains 500 g.', source: 'https://example.com/source' },
    { id: 'global', productId: null, text: 'The policy text stays unchanged.', source: 'https://example.com/policy' }] };
const selection: ConversationSelection = { plan: { intent: 'facts', searchQuery: '', productIds: ['p1'], factIds: ['f1', 'f2'], variantId: null, quantity: null },
  draft: { segments: [{ text: 'The package contains 500 g.', productIds: ['p1'], factIds: ['f1'] }] } };

describe('request-local selection references', () => {
  it('compresses only structured references and restores canonical result identity without modifying input', () => {
    const before = structuredClone(input);
    const { context, decode } = compactSelectionReferences(input);
    const original = selectionConversationContext(input);
    expect(context.products[0]).toEqual({ ...original.products[0], id: 'p1', variants: [{ ...original.products[0]!.variants[0], id: 'v1' }] });
    expect(context.facts).toEqual([{ ...original.facts[0], id: 'f1', productId: 'p1' }, { ...original.facts[1], id: 'f2', productId: null }]);
    expect(context.candidateProductCards).toEqual([{ productId: 'p1', showsPrice: true, showsAvailability: true }]);
    expect(context.history[1]?.context).toEqual({ productIds: ['hp1', 'p1'], factIds: ['hf1', 'f1'] });
    expect(context.history.map(turn => turn.content)).toEqual(original.history.map(turn => turn.content));
    expect(context.message).toBe(input.message);
    expect(context.merchantStyle).toEqual(original.merchantStyle);
    expect(decode(selection)).toEqual({ plan: { ...selection.plan, productIds: [product.id], factIds: [factId, 'global'] },
      draft: { segments: [{ ...selection.draft!.segments[0], productIds: [product.id], factIds: [factId] }] } });
    expect(input).toEqual(before);
    expect(selection.plan.productIds).toEqual(['p1']);
  });

  it('maps a pending variant and null cart draft without granting execution authority', () => {
    const { context, decode } = compactSelectionReferences({ ...input, pendingAction: { kind: 'add', variantId: product.variants[0]!.id, quantity: 2 } });
    expect(context.pendingAction).toEqual({ kind: 'add', variantId: 'v1', quantity: 2 });
    expect(decode({ plan: { ...selection.plan, intent: 'add_to_cart', variantId: 'v1', quantity: 2 }, draft: null }))
      .toEqual({ plan: { ...selection.plan, intent: 'add_to_cart', productIds: [product.id], factIds: [factId, 'global'], variantId: product.variants[0]!.id, quantity: 2 }, draft: null });
  });

  it('preserves the medical retention signal while discarding malformed references and every draft segment', () => {
    const { decode } = compactSelectionReferences(input);
    const result = decode({ plan: { ...selection.plan, intent: 'medical', searchQuery: 'untrusted search',
      productIds: ['unknown'], factIds: ['hf1'], variantId: 'wrong', quantity: 2 },
    draft: { segments: [{ text: 'Untrusted medical draft', productIds: ['unknown'], factIds: ['wrong'] }] } });
    expect(result).toEqual({ plan: { intent: 'medical', searchQuery: '', productIds: [], factIds: [], variantId: null, quantity: null }, draft: null });
  });

  it.each(['unknown product', 'wrong product type', 'canonical product', 'history product', 'unknown fact', 'history fact', 'wrong fact type', 'unknown variant', 'wrong variant type', 'unknown draft', 'unselected draft'])
  ('fails closed on %s references', kind => {
    const output = structuredClone(selection);
    if (kind === 'unknown product') output.plan.productIds = ['p2'];
    if (kind === 'wrong product type') output.plan.productIds = ['f1'];
    if (kind === 'canonical product') output.plan.productIds = [product.id];
    if (kind === 'history product') output.plan.productIds = ['hp1'];
    if (kind === 'unknown fact') output.plan.factIds = ['f999'];
    if (kind === 'history fact') output.plan.factIds = ['hf1'];
    if (kind === 'wrong fact type') output.plan.factIds = ['p1'];
    if (kind === 'unknown variant') output.plan.variantId = 'v999';
    if (kind === 'wrong variant type') output.plan.variantId = 'p1';
    if (kind === 'unknown draft') output.draft!.segments[0]!.factIds = ['f999'];
    if (kind === 'unselected draft') output.plan.factIds = ['f2'];
    expect(() => compactSelectionReferences(input).decode(output)).toThrow(/^The planning service is unavailable\.$/);
  });

  it('never lets earlier invocation aliases establish evidence for a new request', () => {
    const first = compactSelectionReferences(input);
    const otherProduct = { ...product, id: 'gid://shopify/Product/444', variants: [{ ...product.variants[0]!, id: 'gid://shopify/ProductVariant/555' }] };
    const second = compactSelectionReferences({ ...input, products: [otherProduct], facts: [{ ...input.facts[0]!, id: 'different-fact', productId: otherProduct.id }] });
    expect(first.decode(selection).plan.productIds).toEqual([product.id]);
    expect(second.decode({ ...selection, plan: { ...selection.plan, factIds: ['f1'] } }).plan.productIds).toEqual([otherProduct.id]);
    expect(() => second.decode(selection)).toThrow(); // f2 only existed in the other request.
    expect(() => second.decode({ ...selection, plan: { ...selection.plan, productIds: ['hp2'], factIds: ['f1'] } })).toThrow();
  });

  it('rejects duplicate or missing evidence associations before any provider request', () => {
    expect(() => compactSelectionReferences({ ...input, products: [product, product] })).toThrow();
    expect(() => compactSelectionReferences({ ...input, facts: [input.facts[0]!, input.facts[0]!] })).toThrow();
    expect(() => compactSelectionReferences({ ...input, facts: [{ ...input.facts[0]!, productId: 'gid://shopify/Product/999' }] })).toThrow();
    expect(() => compactSelectionReferences({ ...input, pendingAction: { kind: 'add', variantId: 'gid://shopify/ProductVariant/999', quantity: 1 } })).toThrow();
  });

  it('supports an empty current catalog while preserving non-selectable historical references', () => {
    const { context, decode } = compactSelectionReferences({ ...input, products: [], facts: [] });
    expect(context.products).toEqual([]);
    expect(context.facts).toEqual([]);
    expect(context.history[1]!.context).toEqual({ productIds: ['hp1', 'hp2'], factIds: ['hf1', 'hf2'] });
    expect(decode({ plan: { ...selection.plan, productIds: [], factIds: [] }, draft: null }).draft).toBeNull();
    expect(() => decode(selection)).toThrow();
  });
});
