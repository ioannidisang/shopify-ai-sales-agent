import type { Locale, Product } from '../../../packages/core/src/types.js';
import { normalizeInput } from '../../../packages/core/src/policy.js';
import { priceFollowupCount } from '../../../packages/core/src/price-followup.js';

/** Read a checked response's live card snapshot aloud, never model-authored amounts.
 * Kept outside conversation history: later turns must fetch commerce again.
 * Ambiguous/multi-variant cards remain visual until the shopper selects a variant.
 */
export function spokenPrices(message: string, products: Product[], locale: Locale): string {
  const query = normalizeInput(message);
  const followupCount = priceFollowupCount(message);
  if (followupCount !== undefined && followupCount !== null && followupCount !== products.length) return '';
  if (/(?:\b(?:no|without)\s+prices?\b|\b(?:don't|do\s+not)\b[^.!?;]{0,45}\b(?:price|prices|cost)\b|(?:χωρις|μην|δε(?:ν)?\s+(?:θελω|με\s+ενδιαφερ\p{L}*))[^.!?;]{0,45}(?:τιμ(?:η|ες)|κοστ\p{L}*))/u.test(query)) return '';
  if (followupCount === undefined && !/(?:\b(?:price|prices|cost|costs)\b|(?<!\p{L})(?:τιμη|τιμες|κοστιζει|κοστιζουν|κοστος)(?!\p{L}))/u.test(query)) return '';
  if (!products.length || products.length > 4) return '';
  const amounts: string[] = [];
  let currency: string | undefined;
  for (const product of products) {
    if (product.requiresSellingPlan || product.variants.length !== 1) return '';
    const variant = product.variants[0]!;
    // Mirror the cards that can display an unambiguous standalone price. This
    // does not assert inventory or promise that the item can be bought.
    if (variant.requiresComponents || !/^\d{1,9}(?:\.\d{1,2})?$/.test(variant.price.amount)) return '';
    const code = variant.price.currencyCode;
    if (code !== 'EUR' || (currency && currency !== code)) return '';
    currency = code;
    const formatted = new Intl.NumberFormat(locale === 'el' ? 'el-GR' : 'en-GB', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(Number(variant.price.amount));
    amounts.push(`${formatted} ${locale === 'el' ? 'ευρώ' : 'euros'}`);
  }
  if (amounts.length === 1) return locale === 'el'
    ? `Η τιμή στην κάρτα είναι ${amounts[0]}.` : `The price on the card is ${amounts[0]}.`;
  return locale === 'el'
    ? `Οι τιμές στις κάρτες, με τη σειρά που εμφανίζονται, είναι: ${amounts.join(', ')}.`
    : `The prices on the cards, in display order, are: ${amounts.join(', ')}.`;
}
