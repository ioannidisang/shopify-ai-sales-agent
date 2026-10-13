import type { ApprovedFact, HistoryMessage, Locale } from './types.js';

export const MEDICAL_HISTORY_MARKER = '[medical context withheld]';

export function normalizeInput(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').toLowerCase();
}

// Defense in depth. The separate structured planner also classifies medical intent;
// neither may bypass the deterministic response/fact allowlist.
const medicalTerms = /(?:diagnos|medicat|prescri|pregnan|breastfeed|treat(?:ment|ing)?\b|cure\b|disease|diabet|cancer|depress|anxiety|blood\s*(?:pressure|sugar)|symptom|contraindicat|side\s*effect|drug\s*interact|dosage|overdose|anticoagul|warfarin|insulin|kidney|liver\s*disease|antidepress|παθησ|ασθενει|διαγνω|θεραπ|φαρμακ|εγκυ|θηλασ|διαβητ|καρκιν|συμπτω|αντενδει|παρενεργ|δοσολογ|υπερδοσ|αντικαταθλιπ|νεφρ|υπερτασ|πιεση|καταθλιψ|αγχ)/u;
const personalSuitability = /(?:safe\s+(?:for|to)|can\s+i\s+take|should\s+i\s+take|how\s+much\s+(?:should|can)\s+i|(?:for|my)\s+(?:child|baby|toddler)|μπορω\s+να\s+παρω|ποσο\s+να\s+παρω|ασφαλε[σς]\s+για|καταλληλ\S*\s+για\s+(?:μενα|εμενα|παιδ))/u;
const capsuleCountQuestion = /(?:ποσεσ?|ποσες)\s+καψουλ\p{L}*/gu;
const packageCountPredicate = /^\s+(?:εχει|περιεχει|περιλαμβανει)(?=$|[^\p{L}])/u;
const consumptionContext = /(?<!\p{L})(?:(?:ξανα)?(?:παιρν|παρ(?:ω|ει|ουμε|ετε|ουν|τε)|λαμβαν|καταπιν|καταναλων)|χορηγ|ληψ|δοση|δοσε[ιςσ]|ημερησι|καθημεριν|(?:την|τη|ανα|καθε)\s+(?:ημερα|μερα)|ανα\s+ωρα|πρωι|βραδ|(?:take|swallow|consume|daily|dose|dosing)\b|per\s+(?:day|dose))/u;
const hiddenMedical = /(?:pregnant|pregnancy|diabetes|diagnose|medication|warfarin|εγκυος|φαρμακα|διαβητης)/u;

function hasCapsuleDosageQuestion(text: string): boolean {
  const questions = [...text.matchAll(capsuleCountQuestion)];
  if (!questions.length) return false;
  // A pack's contents are shopping information, not a dose. Keep ambiguous count
  // questions and any mixed consumption context blocked; inspect every occurrence.
  if (consumptionContext.test(text)) return true;
  return questions.some(match => !packageCountPredicate.test(text.slice(match.index + match[0].length)));
}

export function isMedicalRequest(message: string, history: HistoryMessage[] = []): boolean {
  const text = normalizeInput(message);
  if (text === MEDICAL_HISTORY_MARKER) return true;
  if (medicalTerms.test(text) || personalSuitability.test(text) || hasCapsuleDosageQuestion(text) || hiddenMedical.test(text.replace(/[^\p{L}\p{N}]/gu, ''))) return true;
  // A short follow-up must not turn an earlier clinical request into a product sale.
  const followup = /^(?:yes|ok|okay|sure|that|it|add|buy|ναι|ενταξει|αυτο|βαλε|προσθεσε)\b/u.test(text.trim()) || text.trim().length < 35;
  return followup && history.slice(-6).some(turn => turn.role === 'user' && isMedicalRequest(turn.content));
}

export function hasExplicitAddIntent(message: string): boolean {
  const text = normalizeInput(message);
  if (/(?:\bdon'?t\b|\bdo not\b|\bnever\b|\bnot\b|\bremove\b|\bwithout\b|μην|μη\s|χωρισ|αφαιρεσ)/u.test(text)) return false;
  return /(?:\badd\b|\bput\b.{0,50}\bcart\b|προσθεσ|βαλε|βάλτε|προσθηκ)/u.test(text);
}

export function containsForbiddenClaim(text: string): boolean {
  return /(?:\b(?:cures?|treats?|diagnoses?|prevents?\s+(?:disease|cancer|diabetes))\b|θεραπευ|διαγνωσ|ιαση)/u.test(normalizeInput(text));
}

export function usableFacts(facts: ApprovedFact[], shop: string, locale: Locale, now = Date.now()): ApprovedFact[] {
  const seen = new Set<string>();
  return facts.filter(fact => {
    const approvedAt = Date.parse(fact.approvedAt);
    const expiresAt = fact.expiresAt == null ? Infinity : Date.parse(fact.expiresAt);
    if (fact.shop !== shop || fact.locale !== locale || fact.status !== 'approved' || !fact.approvedBy.trim()
      || !fact.source.trim() || !fact.text.trim() || fact.text.length > 2000 || !Number.isFinite(approvedAt)
      || approvedAt > now || Number.isNaN(expiresAt) || expiresAt <= now || seen.has(fact.id)) return false;
    // Approval is necessary, but medical/diagnostic marketing claims stay out.
    if (containsForbiddenClaim(fact.text)) return false;
    seen.add(fact.id);
    return true;
  }).slice(0, 100);
}
