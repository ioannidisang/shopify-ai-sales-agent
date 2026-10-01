import { planSchema } from './model-protocol.js';
import { hasExplicitAddIntent, isMedicalRequest, usableFacts } from './policy.js';
import { currentSourceFacts, retrieveFacts } from './knowledge.js';
import { composeGrounded, CompositionRejected } from './grounding.js';
import type { AssistantResponse, Locale, RespondInput } from './types.js';

const templates = {
  el: {
    greeting: 'Γεια σου! Μπορώ να σε βοηθήσω να βρεις προϊόντα, να δεις επιλογές και τιμές ή εγκεκριμένες πληροφορίες. Τι ψάχνεις;',
    medical: 'Μπορώ να παρουσιάσω εγκεκριμένες πληροφορίες προϊόντων, αλλά δεν μπορώ να αξιολογήσω συμπτώματα, θεραπεία, δοσολογία ή καταλληλότητα για την υγεία σου. Για προσωπική καθοδήγηση απευθύνσου σε γιατρό ή φαρμακοποιό.',
    unavailable: 'Η υπηρεσία δεν είναι διαθέσιμη αυτή τη στιγμή. Μπορείς να συνεχίσεις τις αγορές σου από το κατάστημα.',
    search: 'Δες τις επιλογές από τον ζωντανό κατάλογο παρακάτω. Διάλεξε προϊόν και παραλλαγή για να συνεχίσεις.',
    facts: 'Αυτές είναι οι διαθέσιμες εγκεκριμένες πληροφορίες για την επιλογή σου.',
    noFacts: 'Δεν έχω εγκεκριμένες πληροφορίες που να απαντούν σε αυτό το ερώτημα. Μπορώ να βοηθήσω με τις διαθέσιμες επιλογές και τιμές.',
    noResults: 'Δεν βρήκα σχετική επιλογή στον διαθέσιμο κατάλογο. Γράψε το όνομα ή την κατηγορία του προϊόντος που ψάχνεις.',
    clarify: 'Ποιο προϊόν και ποια παραλλαγή θέλεις; Διάλεξε την ακριβή επιλογή στην κάρτα του προϊόντος.',
    proposal: 'Έτοιμη η πρόταση προσθήκης. Έλεγξε την παραλλαγή και την ποσότητα και πάτησε επιβεβαίωση για να προστεθεί στο καλάθι.',
    soldOut: 'Η συγκεκριμένη επιλογή δεν είναι διαθέσιμη για αγορά αυτή τη στιγμή. Δες τις άλλες παραλλαγές ή επίλεξε άλλο προϊόν.',
    unsupported: 'Μπορώ να βοηθήσω με αναζήτηση προϊόντων, πραγματικές τιμές και διαθεσιμότητα ή εγκεκριμένες πληροφορίες του καταστήματος.',
  },
  en: {
    greeting: 'Hello! I can help you find products, compare available options and prices, or read approved product information. What are you looking for?',
    medical: 'I can show approved product information, but I cannot assess symptoms, treatment, dosage or suitability for your health. Please ask a doctor or pharmacist for personal guidance.',
    unavailable: 'The assistant is unavailable at the moment. You can continue shopping in the store.',
    search: 'Here are options from the live catalog. Select a product and variant to continue.',
    facts: 'Here is the available approved information for your selection.',
    noFacts: 'I do not have approved information that answers this question. I can help with available options and prices.',
    noResults: 'I could not find a relevant option in the available catalog. Please share the product name or category.',
    clarify: 'Which product and variant would you like? Select the exact option on the product card.',
    proposal: 'Your proposed addition is ready. Check the variant and quantity, then confirm to add it to your cart.',
    soldOut: 'This option is currently unavailable for purchase. Check the other variants or choose another product.',
    unsupported: 'I can help find products, show current prices and availability, or share approved store information.',
  },
} as const;

export function policyResponse(locale: Locale, kind: keyof typeof templates.en): AssistantResponse {
  return { text: templates[locale][kind], products: [], facts: [], ...((kind === 'medical' || kind === 'unavailable') ? { policy: kind } : {}) };
}

export async function respond(input: RespondInput): Promise<AssistantResponse> {
  const { shop, catalog, planner, locale, country } = input;
  if (!shop.enabled || !shop.allowedCountries.includes(country)) return policyResponse(locale, 'unavailable');
  if (isMedicalRequest(input.message, input.history)) return policyResponse(locale, 'medical');
  const query = [...input.history.slice(-4).filter(turn => turn.role === 'user').map(turn => turn.content), input.message].join(' ');
  const facts = input.composer ? retrieveFacts(input.facts, shop.shop, locale, query, undefined, 24) : usableFacts(input.facts, shop.shop, locale);
  const configuredProfile = shop.conversation;
  const profile = configuredProfile?.approvedBy?.trim() && configuredProfile.approvedAt
    && Number.isFinite(Date.parse(configuredProfile.approvedAt)) && Date.parse(configuredProfile.approvedAt) <= Date.now() ? configuredProfile : undefined;
  const base = { message: input.message, history: input.history.slice(-10), locale, facts,
    ...(profile ? { guidance: { instructions: profile.instructions, examples: profile.examples } } : {}) };
  const finish = async (result: AssistantResponse, intent: string): Promise<AssistantResponse> => {
    // Legacy planner-only consumers keep their deterministic interface. Production always supplies a composer.
    if (!input.composer) return result;
    const text = await composeGrounded(input.composer, {
      ...base, brand: shop.brand, products: result.products, facts: result.facts,
      instructions: profile?.instructions ?? '', examples: profile?.examples ?? [], intent,
      ...(result.pendingAction ? { pendingAction: result.pendingAction } : {}),
    });
    const selectedIds = new Set(result.facts.map(fact => fact.id));
    const stillApproved = usableFacts(currentSourceFacts(input.facts, shop.shop).filter(fact => selectedIds.has(fact.id)), shop.shop, locale);
    if (stillApproved.length !== selectedIds.size) throw new CompositionRejected();
    return { ...result, text };
  };
  try {
    const context = { country, locale, ...(input.signal ? { signal: input.signal } : {}) };
    input.signal?.throwIfAborted();
    // IDs are stored by the server in display order. Re-read them rather than trusting old prices.
    const lastDisplay = input.history.slice().reverse().find(turn => turn.role === 'assistant' && turn.context?.productIds.length);
    const rememberedIds = [...new Set(lastDisplay?.context?.productIds ?? [])].filter(id => /^gid:\/\/shopify\/Product\/\d+$/.test(id)).slice(0, 4);
    const remembered = rememberedIds.length ? await catalog.getProducts(rememberedIds, context) : [];
    const rememberedProducts = rememberedIds.flatMap(id => remembered.filter(product => product.id === id));
    const initial = planSchema.parse(await planner.plan({ ...base, products: rememberedProducts }));
    if (initial.intent === 'medical') return policyResponse(locale, 'medical');
    if (initial.intent === 'greeting' || initial.intent === 'unsupported') return await finish(policyResponse(locale, initial.intent), initial.intent);
    const searched = initial.searchQuery.trim() ? await catalog.search(initial.searchQuery, context) : [];
    const candidates = [...new Map([...rememberedProducts, ...searched].map(product => [product.id, product])).values()].slice(0, 12);
    const allowedProductIds = new Set(candidates.map(product => product.id));
    const scopedFacts = input.composer
      ? retrieveFacts(input.facts, shop.shop, locale, query, [...allowedProductIds], 24)
      : facts.filter(fact => fact.productId === null || allowedProductIds.has(fact.productId));
    const plan = planSchema.parse(await planner.plan({ ...base, facts: scopedFacts, products: candidates }));
    if (plan.intent === 'medical') return policyResponse(locale, 'medical');
    if (plan.intent === 'unsupported' || plan.intent === 'greeting') return await finish(policyResponse(locale, plan.intent), plan.intent);
    // Never fetch an arbitrary model-supplied ID; it must be a member of this shop's search result.
    const ids = [...new Set(plan.productIds)].filter(id => allowedProductIds.has(id)).slice(0, 4);
    const fresh = ids.length ? await catalog.getProducts(ids, context) : [];
    const products = ids.flatMap(id => {
      const product = fresh.find(item => item.id === id);
      return product ? [{ ...product, imageUrl: product.imageUrl && shop.approvedImageUrls.includes(product.imageUrl) ? product.imageUrl : null }] : [];
    });
    const selectedIds = new Set(products.map(product => product.id));
    const selectedFactIds = new Set(plan.factIds);
    const selectedFacts = scopedFacts.filter(fact => selectedFactIds.has(fact.id) && (fact.productId === null || selectedIds.has(fact.productId)))
      .slice(0, 4).map(({ id, productId, text, source }) => ({ id, productId, text, source }));
    const result: AssistantResponse = {
      text: templates[locale][plan.intent === 'facts' ? (selectedFacts.length ? 'facts' : 'noFacts') : (products.length ? 'search' : 'noResults')],
      products, facts: selectedFacts,
    };
    if (plan.intent === 'clarify') result.text = templates[locale].clarify;
    if (plan.intent === 'add_to_cart') {
      result.text = templates[locale].clarify;
      const selected = products.flatMap(product => product.variants).find(variant => variant.id === plan.variantId);
      if (hasExplicitAddIntent(input.message) && selected && plan.quantity && Number.isInteger(plan.quantity) && plan.quantity >= 1 && plan.quantity <= 20) {
        // Cart proposals get a separate live variant check after ranking.
        const verified = await catalog.getVariant(selected.id, context);
        if (verified && selectedIds.has(verified.product.id) && verified.variant.id === selected.id) {
          const rule = verified.variant.quantityRule;
          const validQuantity = !rule || (plan.quantity >= rule.minimum && (rule.maximum === null || plan.quantity <= rule.maximum) && plan.quantity % rule.increment === 0);
          if (!verified.variant.availableForSale || verified.variant.currentlyNotInStock) result.text = templates[locale].soldOut;
          else if (!verified.product.requiresSellingPlan && !verified.variant.requiresComponents && validQuantity) {
            for (const card of products) {
              if (card.id === verified.product.id) card.variants = card.variants.map(variant => variant.id === verified.variant.id ? verified.variant : variant);
            }
            result.pendingAction = { kind: 'add', variantId: verified.variant.id, quantity: plan.quantity };
            result.text = templates[locale].proposal;
          }
        }
      }
    }
    return await finish(result, result.pendingAction ? 'cart_confirmation_required' : plan.intent === 'add_to_cart' ? 'clarify' : plan.intent);
  } catch (error) {
    // Never leak provider error bodies, credentials, or unsafe model output.
    if (error instanceof CompositionRejected && error.medical) return policyResponse(locale, 'medical');
    return policyResponse(locale, 'unavailable');
  }
}
