import { conversationDraftSchema, verificationSchema, type ConversationDraft, type ConversationInput, type ConversationModel } from './conversation.js';
import { containsForbiddenClaim, isSleepWellbeingRequest, normalizeInput } from './policy.js';

export class CompositionRejected extends Error {
  constructor(public readonly medical = false) { super('The response could not be verified.'); }
}

const numbers = (value: string) => value.normalize('NFKC').match(/\d+(?:[.,]\d+)*/g) ?? [];

/** Deterministic checks complement, but cannot replace, semantic evidence checking. */
export async function composeGrounded(model: ConversationModel, input: ConversationInput): Promise<string> {
  return verifyGrounded(model, input, await model.compose(input));
}

/** A draft composed alongside selection has exactly the same final validation boundary. */
export async function verifyGrounded(model: ConversationModel, input: ConversationInput, untrusted: ConversationDraft): Promise<string> {
  const draft = conversationDraftSchema.parse(untrusted);
  // Even a bare product card can imply that it meets the shopper's sleep goal.
  // The current approval flow has no separate permission for such effects: a
  // permissive verifier cannot promote ingredients/package facts into that role.
  // Do not inspect older goals here; independent later factual queries are valid.
  if ((input.intent === 'wellbeing_information_limit' || isSleepWellbeingRequest(input.message))
    && (input.products.length > 0 || input.facts.some(fact => fact.productId !== null) || input.pendingAction)) {
    throw new CompositionRejected();
  }
  const products = new Map(input.products.map(product => [product.id, product]));
  const facts = new Map(input.facts.map(fact => [fact.id, fact]));
  for (const segment of draft.segments) {
    if (segment.productIds.some(id => !products.has(id)) || segment.factIds.some(id => !facts.has(id))) throw new CompositionRejected();
    // Also reject an unsolicited sleep-effect claim in an otherwise factual
    // product answer; ingredient citations cannot legitimize that extra claim.
    if (segment.productIds.length > 0 && isSleepWellbeingRequest(segment.text)) throw new CompositionRejected();
    const normal = normalizeInput(segment.text);
    if (containsForbiddenClaim(segment.text)) throw new CompositionRejected(true);
    // Links and markup come from the application; commercial prices remain in live cards.
    if (/(?:https?:|www\.|<\/?[a-z]|\]\(|\{\{|gid:\/\/)/i.test(segment.text)
      || /(?:[€$£¥]|\b(?:eur|usd|gbp|euros?|dollars?)\b|ευρω)/u.test(normal)
      || /(?:\b(?:i(?:'ve| have)?\s+)?(?:added|ordered|purchased|paid|updated your cart)\b|προσεθεσα|προσθεσα|εβαλα.{0,50}καλαθ|ολοκληρωσα.{0,50}(?:αγορ|παραγγελ))/u.test(normal)) throw new CompositionRejected();
    const citedFacts = segment.factIds.map(id => facts.get(id)!);
    if (citedFacts.some(fact => fact.productId !== null && !segment.productIds.includes(fact.productId))) throw new CompositionRejected();
    // Numeric product specifications need evidence; shopper numbers can be echoed as preferences.
    const evidence = [segment.productIds.length || segment.factIds.length ? '' : input.message, ...citedFacts.map(fact => fact.text),
      ...segment.productIds.flatMap(id => { const product = products.get(id)!; return [product.title, ...product.variants.map(variant => variant.title)]; }),
      input.pendingAction ? String(input.pendingAction.quantity) : ''].join(' ');
    const allowedNumbers = new Set(numbers(evidence).map(value => value.replace(',', '.')));
    if (numbers(segment.text).some(value => !allowedNumbers.has(value.replace(',', '.')))) throw new CompositionRejected();
  }
  // A separate pass judges each assertion against the supplied evidence, not just citation membership.
  const verification = verificationSchema.parse(await model.verify(input, draft));
  if (verification.medical) throw new CompositionRejected(true);
  if (!verification.supported) throw new CompositionRejected();
  return draft.segments.map(segment => segment.text.trim()).join('\n\n');
}
