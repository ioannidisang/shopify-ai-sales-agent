import { isMedicalRequest, normalizeInput } from './policy.js';
import type { HistoryMessage } from './types.js';

const countWords: Record<string, number> = { ενα: 1, ενος: 1, δυο: 2, τρια: 3, τριων: 3, τεσσερα: 4, τεσσαρων: 4, one: 1, two: 2, three: 3, four: 4 };
const count = String.raw`(?:\d+|${Object.keys(countWords).join('|')})`;
const greekGenitive = String.raw`(?:των(?: ${count})? (?:παραπανω|προηγουμενων) προιοντων|αυτων(?: των)?(?: ${count})?(?: προιοντων)?|τους)`;
const greekAccusative = String.raw`(?:τα(?: ${count})? (?:παραπανω|προηγουμενα) προιοντα|αυτα(?: τα)?(?: ${count})?(?: προιοντα)?)`;
const englishReference = String.raw`(?:the(?: ${count})? (?:above|previous) products?|(?:the )?(?:${count} )?products? (?:above|previously shown)|(?:these|those)(?: ${count})?(?: products?)?|them)`;
const purePriceQuestions = [
  new RegExp(String.raw`^(?:ποιες ειναι οι τιμες|(?:και )?(?:οι )?τιμες)(?: και)? ${greekGenitive}$`, 'u'),
  new RegExp(String.raw`^(?:ποιες ειναι οι τιμες|τιμες) για ${greekAccusative}$`, 'u'),
  new RegExp(String.raw`^(?:ποσο (?:κοστιζουν|κανουν)|τι τιμες εχουν) ${greekAccusative}$`, 'u'),
  new RegExp(String.raw`^(?:what are the prices|prices) (?:of|for) ${englishReference}$`, 'u'),
  new RegExp(String.raw`^how much do ${englishReference} cost$`, 'u'),
  /^(?:what are their prices|how much (?:are they|do they cost))$/u,
];

/** A bounded commerce UI action, not a general intent classifier. Undefined is
 * unrecognized; null is an exact price-only follow-up without an explicit count.
 */
export function priceFollowupCount(message: string): number | null | undefined {
  const text = normalizeInput(message).trim().replace(/[?.!;;]+$/u, '').trim().replace(/\s+/gu, ' ');
  if (text.length > 160 || !purePriceQuestions.some(pattern => pattern.test(text))) return undefined;
  const cardinal = text.split(' ').find(word => /^\d+$/u.test(word) || Object.hasOwn(countWords, word));
  return cardinal === undefined ? null : countWords[cardinal] ?? Number(cardinal);
}

/** Resolve only server-retained display identities. Clinical uncertainty stays
 * on the existing model + independent-verifier path, even for a long follow-up.
 */
export function priceFollowupProductIds(message: string, history: HistoryMessage[]): string[] | undefined {
  const requestedCount = priceFollowupCount(message);
  if (requestedCount === undefined || isMedicalRequest(message, history)
    || history.some(turn => isMedicalRequest(turn.content))) return undefined;
  const lastDisplay = history.slice().reverse().find(turn => turn.role === 'assistant' && turn.context?.productIds.length);
  const ids = lastDisplay?.context?.productIds;
  if (!ids?.length || ids.length > 4 || new Set(ids).size !== ids.length
    || ids.some(id => !/^gid:\/\/shopify\/Product\/\d+$/u.test(id))
    || (requestedCount !== null && requestedCount !== ids.length)) return undefined;
  return [...ids];
}
