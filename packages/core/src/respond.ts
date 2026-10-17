import { conversationSelectionSchema, plannerContext, planSchema } from './model-protocol.js';
import { hasExplicitAddIntent, isMedicalRequest, isSleepWellbeingRequest, usableFacts } from './policy.js';
import { currentSourceFacts, retrieveFacts } from './knowledge.js';
import { composeGrounded, CompositionRejected, verifyGrounded } from './grounding.js';
import { fitsSmallCatalogContext } from './catalog-bounds.js';
import { priceFollowupProductIds } from './price-followup.js';
import type { ConversationDraft, ConversationInput, ConversationSelection } from './conversation.js';
import type { ApprovedFact, AssistantResponse, Locale, Plan, Product, RespondInput } from './types.js';

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
  // Keep clinical markers even when a short independent product query is allowed
  // past the lexical screen. Both model stages must still evaluate its meaning.
  const history = input.history;
  const query = [...history.slice(-4).filter(turn => turn.role === 'user').map(turn => turn.content), input.message].join(' ');
  const facts = input.composer ? retrieveFacts(input.facts, shop.shop, locale, query, undefined, 24) : usableFacts(input.facts, shop.shop, locale);
  const configuredProfile = shop.conversation;
  const profile = configuredProfile?.approvedBy?.trim() && configuredProfile.approvedAt
    && Number.isFinite(Date.parse(configuredProfile.approvedAt)) && Date.parse(configuredProfile.approvedAt) <= Date.now() ? configuredProfile : undefined;
  const base = { message: input.message, history: history.slice(-10), locale, facts,
    ...(input.responseMode === 'voice' ? { responseMode: 'voice' as const } : {}),
    ...(profile ? { guidance: { instructions: profile.instructions, examples: profile.examples } } : {}) };
  const finish = async (result: AssistantResponse, intent: string, draft?: ConversationDraft): Promise<AssistantResponse> => {
    // Legacy planner-only consumers keep their deterministic interface. Production always supplies a composer.
    if (!input.composer) return result;
    const composition: ConversationInput = {
      ...base, brand: shop.brand, products: result.products, facts: result.facts,
      instructions: profile?.instructions ?? '', examples: profile?.examples ?? [], intent,
      ...(result.pendingAction ? { pendingAction: result.pendingAction } : {}),
    };
    const text = draft ? await verifyGrounded(input.composer, composition, draft) : await composeGrounded(input.composer, composition);
    const selectedIds = new Set(result.facts.map(fact => fact.id));
    const stillApproved = usableFacts(currentSourceFacts(input.facts, shop.shop).filter(fact => selectedIds.has(fact.id)), shop.shop, locale);
    if (stillApproved.length !== selectedIds.size) throw new CompositionRejected(false, 'source_freshness');
    return { ...result, text };
  };
  try {
    const context = { country, locale, ...(input.signal ? { signal: input.signal } : {}) };
    input.signal?.throwIfAborted();
    // Ingredient/package approval is not permission to recommend a sleep effect.
    // Keep this narrow goal route naturally generated and independently checked,
    // but remove catalog cues that could turn product names into inferred benefits.
    // A future reviewed effect policy is required before this scope can rank items.
    if (isSleepWellbeingRequest(input.message)) {
      return await finish(policyResponse(locale, 'noFacts'), 'wellbeing_information_limit');
    }
    // An exact lookup of already displayed prices is a commerce UI action.
    // Read its cards again; never ask the model to copy monetary values or
    // promote an earlier price snapshot into current evidence.
    const priceIds = priceFollowupProductIds(input.message, history);
    if (priceIds) {
      const fresh = await catalog.getProducts(priceIds, context);
      input.signal?.throwIfAborted();
      if (fresh.length !== priceIds.length || new Set(fresh.map(product => product.id)).size !== priceIds.length
        || fresh.some(product => !priceIds.includes(product.id))) throw new CompositionRejected(false, 'reference_check');
      const products = priceIds.map(id => fresh.find(product => product.id === id)!);
      if (products.some(product => product.requiresSellingPlan || !product.variants.length)) throw new CompositionRejected(false, 'card_check');
      return { text: locale === 'el'
        ? (products.length === 1 ? 'Δες την τρέχουσα τιμή στην κάρτα του προϊόντος.' : 'Δες τις τρέχουσες τιμές στις κάρτες των προϊόντων.')
        : (products.length === 1 ? 'See the current price on the product card.' : 'See the current prices on the product cards.'),
        products: products.map(product => ({ ...product, imageUrl: product.imageUrl && shop.approvedImageUrls.includes(product.imageUrl) ? product.imageUrl : null })), facts: [] };
    }
    // IDs are stored by the server in display order. Never use historical commerce.
    const lastDisplay = history.slice().reverse().find(turn => turn.role === 'assistant' && turn.context?.productIds.length);
    const rememberedIds = [...new Set(lastDisplay?.context?.productIds ?? [])].filter(id => /^gid:\/\/shopify\/Product\/\d+$/.test(id)).slice(0, 4);
    // A complete, bounded live catalog needs no model-authored search. The same
    // selection model still classifies meaning and the independent verifier still
    // receives full relevant history. Larger catalogs retain the search pipeline.
    const complete = input.composer?.selectAndCompose && catalog.getCompleteSmallCatalog && !hasExplicitAddIntent(input.message)
      ? await catalog.getCompleteSmallCatalog(context) : null;
    let candidates: Product[];
    let scopedFacts: ApprovedFact[];
    let combined: ConversationSelection | undefined;
    let plan: Plan;
    if (complete !== null && fitsSmallCatalogContext(complete)) {
      candidates = [...rememberedIds.flatMap(id => complete.filter(product => product.id === id)),
        ...complete.filter(product => !rememberedIds.includes(product.id))];
      scopedFacts = retrieveFacts(input.facts, shop.shop, locale, query, candidates.map(product => product.id), 24);
      combined = conversationSelectionSchema.parse(await input.composer!.selectAndCompose!({
        ...base, facts: scopedFacts, products: candidates, brand: shop.brand,
        instructions: profile?.instructions ?? '', examples: profile?.examples ?? [], intent: 'classify_and_select',
      }));
      plan = combined.plan;
    } else {
      const remembered = rememberedIds.length ? await catalog.getProducts(rememberedIds, context) : [];
      const rememberedProducts = rememberedIds.flatMap(id => remembered.filter(product => product.id === id));
      const initialInput = { ...base, products: rememberedProducts };
      const initial = planSchema.parse(await planner.plan(initialInput));
      if (initial.intent === 'medical') return policyResponse(locale, 'medical');
      if (initial.intent === 'greeting' || initial.intent === 'unsupported') return await finish(policyResponse(locale, initial.intent), initial.intent);
      const searched = initial.searchQuery.trim() ? await catalog.search(initial.searchQuery, context) : [];
      candidates = [...new Map([...rememberedProducts, ...searched].map(product => [product.id, product])).values()].slice(0, 12);
      const candidateIds = new Set(candidates.map(product => product.id));
      scopedFacts = input.composer
        ? retrieveFacts(input.facts, shop.shop, locale, query, [...candidateIds], 24)
        : facts.filter(fact => fact.productId === null || candidateIds.has(fact.productId));
      const selectionInput = { ...base, facts: scopedFacts, products: candidates };
      // Reuse only identical no-search planning context; never skip final live reads.
      const samePlanningContext = !initial.searchQuery.trim()
        && JSON.stringify(plannerContext(initialInput)) === JSON.stringify(plannerContext(selectionInput));
      combined = !samePlanningContext && initial.intent !== 'add_to_cart' && input.composer?.selectAndCompose
        ? conversationSelectionSchema.parse(await input.composer.selectAndCompose({
          ...selectionInput, brand: shop.brand, instructions: profile?.instructions ?? '', examples: profile?.examples ?? [], intent: initial.intent,
        })) : undefined;
      plan = combined?.plan ?? (samePlanningContext ? initial : planSchema.parse(await planner.plan(selectionInput)));
    }
    const allowedProductIds = new Set(candidates.map(product => product.id));
    if (plan.intent === 'medical') return policyResponse(locale, 'medical');
    if (combined && !combined.draft && plan.intent !== 'add_to_cart') throw new CompositionRejected(false, 'schema_check');
    const selectedDraft = combined?.draft ?? undefined;
    if (plan.intent === 'unsupported' || plan.intent === 'greeting') return await finish(policyResponse(locale, plan.intent), plan.intent, selectedDraft);
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
    return await finish(result, result.pendingAction ? 'cart_confirmation_required' : plan.intent === 'add_to_cart' ? 'clarify' : plan.intent,
      plan.intent === 'add_to_cart' ? undefined : selectedDraft);
  } catch (error) {
    // Never leak provider error bodies, credentials, or unsafe model output.
    if (error instanceof CompositionRejected) {
      try { void Promise.resolve(input.onGroundingRejected?.(error.stage)).catch(() => {}); }
      catch { /* Diagnostics cannot change the existing checked fallback. */ }
    }
    if (error instanceof CompositionRejected && error.medical) return policyResponse(locale, 'medical');
    return policyResponse(locale, 'unavailable');
  }
}
