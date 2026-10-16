import type { ConversationInput, ConversationSelection } from './conversation.js';
import { PlannerError, selectionConversationContext } from './model-protocol.js';

export const selectionReferenceInstructions = `The structured IDs in this request are temporary references: p for current products,
v for current variants, and f for approved facts. Return these IDs exactly in the corresponding reference fields.
History-only references hp and hf preserve earlier display context but are not current evidence and must never be selected.
Do not put reference IDs in customer-facing text. Do not treat an ID as evidence beyond its supplied product or fact.`;

function references(prefix: string, ids: string[]) {
  const canonicalToAlias = new Map<string, string>();
  const aliasToCanonical = new Map<string, string>();
  for (const id of ids) {
    if (!id || canonicalToAlias.has(id)) throw new PlannerError();
    const alias = `${prefix}${canonicalToAlias.size + 1}`;
    canonicalToAlias.set(id, alias);
    aliasToCanonical.set(alias, id);
  }
  const required = (map: Map<string, string>, id: string): string => {
    const value = map.get(id);
    if (value === undefined) throw new PlannerError();
    return value;
  };
  return {
    encode: (id: string) => required(canonicalToAlias, id),
    decode: (id: string) => required(aliasToCanonical, id),
    historical: (() => {
      const historyOnly = new Map<string, string>();
      return (id: string): string => {
        const current = canonicalToAlias.get(id);
        if (current !== undefined) return current;
        if (!id) throw new PlannerError();
        if (!historyOnly.has(id)) historyOnly.set(id, `h${prefix}${historyOnly.size + 1}`);
        return historyOnly.get(id)!;
      };
    })(),
  };
}

/** Per-request transport compression only. Canonical IDs return before grounding or commerce logic. */
export function compactSelectionReferences(input: ConversationInput) {
  const original = selectionConversationContext(input);
  const products = references('p', original.products.map(product => product.id));
  const variants = references('v', original.products.flatMap(product => product.variants.map(variant => variant.id)));
  const facts = references('f', original.facts.map(fact => fact.id));
  const context = {
    ...original,
    products: original.products.map(product => ({ ...product, id: products.encode(product.id),
      variants: product.variants.map(variant => ({ ...variant, id: variants.encode(variant.id) })) })),
    facts: original.facts.map(fact => ({ ...fact, id: facts.encode(fact.id),
      productId: fact.productId === null ? null : products.encode(fact.productId) })),
    candidateProductCards: original.candidateProductCards.map(card => ({ ...card, productId: products.encode(card.productId) })),
    history: original.history.map(turn => ({ ...turn, ...(turn.context ? { context: {
      productIds: turn.context.productIds.map(products.historical), factIds: turn.context.factIds.map(facts.historical),
    } } : {}) })),
    pendingAction: original.pendingAction ? { ...original.pendingAction, variantId: variants.encode(original.pendingAction.variantId) } : null,
  };
  const decode = (selection: ConversationSelection): ConversationSelection => {
    // Medical classification must retain the refusal/retention marker even if
    // the model also emits bad references. Nothing from that draft is displayed.
    if (selection.plan.intent === 'medical') return {
      plan: { intent: 'medical', searchQuery: '', productIds: [], factIds: [], variantId: null, quantity: null }, draft: null,
    };
    const plan = { ...selection.plan, productIds: selection.plan.productIds.map(products.decode),
      factIds: selection.plan.factIds.map(facts.decode),
      variantId: selection.plan.variantId === null ? null : variants.decode(selection.plan.variantId) };
    const draft = selection.draft === null ? null : { segments: selection.draft.segments.map(segment => ({ ...segment,
      productIds: segment.productIds.map(products.decode), factIds: segment.factIds.map(facts.decode),
    })) };
    // A candidate's existence does not authorize references outside the selection.
    if (draft?.segments.some(segment => segment.productIds.some(id => !plan.productIds.includes(id))
      || segment.factIds.some(id => !plan.factIds.includes(id)))) throw new PlannerError();
    return { plan, draft };
  };
  return { context, decode };
}
