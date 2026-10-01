import { planSchema } from './openai-planner.js';
import { hasExplicitAddIntent, isMedicalRequest, usableFacts } from './policy.js';
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
  const facts = usableFacts(input.facts, shop.shop, locale);
  const base = { message: input.message, history: input.history.slice(-10), locale, facts };
  try {
    const initial = planSchema.parse(await planner.plan({ ...base, products: [] }));
    if (initial.intent === 'medical') return policyResponse(locale, 'medical');
    if (initial.intent === 'greeting' || initial.intent === 'unsupported') return policyResponse(locale, initial.intent);
    const context = { country, locale };
    const candidates = await catalog.search(initial.searchQuery, context);
    const allowedProductIds = new Set(candidates.map(product => product.id));
    const scopedFacts = facts.filter(fact => fact.productId === null || allowedProductIds.has(fact.productId));
    const plan = planSchema.parse(await planner.plan({ ...base, facts: scopedFacts, products: candidates }));
    if (plan.intent === 'medical') return policyResponse(locale, 'medical');
    if (plan.intent === 'unsupported' || plan.intent === 'greeting') return policyResponse(locale, plan.intent);
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
    return result;
  } catch {
    // Never leak provider error bodies, credentials, or unsafe model output.
    return policyResponse(locale, 'unavailable');
  }
}
