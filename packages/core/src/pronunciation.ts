import { z } from 'zod';

// Provider IDs are opaque references, never keys or URLs. Tavus documents the pd_ prefix.
export const pronunciationDictionaryIdSchema = z.string().regex(/^pd_[A-Za-z0-9_-]{1,125}$/);
const plainPhrase = (max: number) => z.string().min(1).max(max)
  .refine(value => value === value.trim() && /^[\p{L}\p{M}\p{N} .,'’()+/-]+$/u.test(value), 'Pronunciation rules require plain words');

const fields = {
  shop: z.string().max(100).regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
  locale: z.enum(['el', 'en']),
  version: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  approvedBy: z.string().trim().min(1).max(100),
  approvedAt: z.iso.datetime().refine(value => Date.parse(value) <= Date.now(), 'Pronunciation approval cannot be in the future'),
  rules: z.array(z.object({
    text: plainPhrase(200), pronunciation: plainPhrase(500), type: z.literal('alias'),
    // Whole-word matching is documented for ElevenLabs only. Never use these
    // profiles with automatic provider selection or general substring rewriting.
    case_sensitive: z.literal(false), word_boundaries: z.literal(true),
  }).strict()).min(1).max(100).refine(rules => {
    const sources = rules.map(rule => rule.text.normalize('NFC').toLocaleLowerCase('en'));
    return new Set(sources).size === sources.length;
  }, 'Pronunciation source terms must be unique'),
};

/** Merchant-approved speech aliases; these are never product facts or LLM instructions. */
export const pronunciationProfileSchema = z.object(fields).strict();
export const pronunciationConfigSchema = z.object({ ...fields, dictionaryId: pronunciationDictionaryIdSchema }).strict();
export type PronunciationProfile = z.infer<typeof pronunciationProfileSchema>;
export type PronunciationConfig = z.infer<typeof pronunciationConfigSchema>;

/** One immutable provider dictionary per tenant/profile version; do not patch a shared dictionary. */
export function pronunciationDictionaryPayload(input: unknown) {
  const profile = pronunciationProfileSchema.parse(input);
  return { name: `${profile.shop}/${profile.version}`, rules: profile.rules };
}
