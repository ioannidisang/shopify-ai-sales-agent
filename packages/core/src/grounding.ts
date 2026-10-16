import { conversationDraftSchema, verificationSchema, type ConversationDraft, type ConversationInput, type ConversationModel } from './conversation.js';
import { containsForbiddenClaim, isSleepWellbeingRequest, normalizeInput } from './policy.js';

export class CompositionRejected extends Error {
  constructor(public readonly medical = false) { super('The response could not be verified.'); }
}

const numbers = (value: string) => value.normalize('NFKC').match(/\d+(?:[.,]\d+)*/g) ?? [];

/** Stock states belong to the refreshed cards, including when a draft omits citations. */
function containsStockAssertion(text: string, hasCurrentCard: boolean, unreferenced: boolean): boolean {
  const normal = normalizeInput(text).trim();
  // A conditional direction does not assert a stock state. Match the whole
  // sentence and require its cited current card, so neither absent cards nor an
  // appended inventory statement can inherit this exception.
  if (hasCurrentCard && (
    /^(?:you\s+can\s+)?(?:check|see)\s+(?:whether|if)\s+(?:it\s+is|it's)\s+(?:currently\s+)?available\s+(?:on|in)\s+the\s+(?:product\s+)?card[.!?]?$/u.test(normal)
    || /^(?:you\s+can\s+)?(?:check|see)\s+(?:on|in)\s+the\s+(?:product\s+)?card\s+(?:whether|if)\s+(?:it\s+is|it's)\s+(?:currently\s+)?available[.!?]?$/u.test(normal)
    || /^(?:μπορεις\s+να\s+)?(?:δες|δεις|ελεγξε|ελεγξεις)\s+στην\s+καρτα(?:\s+του\s+προιοντος)?\s+αν\s+ειναι\s+διαθεσιμ(?:ο|η|α|οι|ες)[.!?;]?$/u.test(normal)
    || /^(?:μπορεις\s+να\s+)?(?:δες|δεις|ελεγξε|ελεγξεις)\s+αν\s+ειναι\s+διαθεσιμ(?:ο|η|α|οι|ες)\s+στην\s+καρτα(?:\s+του\s+προιοντος)?[.!?;]?$/u.test(normal)
  )) return false;
  // Generic invitations and first-person assistance are not claims about any
  // product's inventory. Keep these uncited, whole-sentence shapes narrow; the
  // independent verifier still checks the reply and its complete context.
  if (unreferenced && (
    /^(?:θελεις|θα\s+ηθελες)\s+να\s+(?:δουμε|εξετασουμε|συγκρινουμε)\s+(?:τις\s+)?διαθεσιμες\s+επιλογες\s*[?;]$/u.test(normal)
    || /^(?:would|do)\s+you\s+like\s+to\s+(?:see|compare|explore)\s+(?:the\s+)?available\s+options\s*\?$/u.test(normal)
    || /^i(?:\s+am|'m)\s+available\s+to\s+help(?:\s+you)?[.!]?$/u.test(normal)
    || /^ειμαι\s+διαθεσιμο[σς]\s+να\s+(?:σε\s+)?βοηθησω[.!]?$/u.test(normal)
  )) return false;
  if (/(?:\b(?:out[\s-]+of[\s-]+stock|in[\s-]+stock|sold[\s-]*out|back[\s-]*order\w*|ready[\s-]+to[\s-]+ship)\b|εξαντλη\p{L}*|ετοιμοπαραδοτ\p{L}*|(?:σε|εκτο[σς])\s+(?:αποθεμ\p{L}*|στοκ)|σε\s+ελλειψη|(?:υπαρχ\p{L}*|εχουμε|διαθετ\p{L}*)\s+(?:διαθεσιμο\s+)?αποθεμ\p{L}*)/u.test(normal)) return true;
  // These adjacent phrases discuss evidence or a product's format, not whether
  // it can currently be bought. All remaining assertions still face verification.
  const subjectScoped = normal
    .replace(/διαθεσιμ\p{L}*\s+(?:εγκεκριμεν\p{L}*\s+)?(?:πληροφορι\p{L}*|γνωσ\p{L}*|τεκμηρι\p{L}*)/gu, '')
    .replace(/(?:πληροφορι\p{L}*|γνωσ\p{L}*|τεκμηρι\p{L}*)\s+(?:δεν\s+)?(?:ειναι|παραμεν\p{L}*)\s+(?:προς\s+το\s+παρον\s+)?διαθεσιμ\p{L}*/gu, '')
    .replace(/διαθεσιμ\p{L}*\s+σε\s+(?:συσκευασι\p{L}*|μορφη|γευση)/gu, '')
    .replace(/\b(?:un)?available\s+(?:(?:approved|factual|product)\s+)?(?:information|evidence|knowledge)\b/gu, '')
    .replace(/\b(?:information|evidence|knowledge)\s+(?:(?:is|isn't|is\s+not)\s+)?(?:currently\s+)?(?:un)?available\b/gu, '')
    .replace(/\bavailable\s+in\s+(?:a\s+)?(?:pack(?:age)?|powder|capsule|tablet)\b/gu, '');
  return /(?:\b(?:unavailable|available)\b|(?<!\p{L})διαθεσιμ(?:ο|η|α|οι|ες|ους|ων|ος|ης|ου)(?!\p{L}))/u.test(subjectScoped);
}

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
    const hasCurrentCard = segment.productIds.length > 0 && segment.productIds.every(id => {
      const product = products.get(id)!;
      return !product.requiresSellingPlan && product.variants.length > 0;
    });
    if (containsStockAssertion(segment.text, hasCurrentCard, segment.productIds.length === 0 && segment.factIds.length === 0)) throw new CompositionRejected();
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
