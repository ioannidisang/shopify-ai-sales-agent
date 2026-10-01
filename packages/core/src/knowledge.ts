import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { normalizeInput, usableFacts } from './policy.js';
import type { ApprovedFact, Locale } from './types.js';

export const MAX_SOURCE_BYTES = 256 * 1024;
export const MAX_TENANT_FACTS = 1000;
const MAX_IMPORT_FACTS = 200;
const shopPattern = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const productPattern = /^gid:\/\/shopify\/Product\/\d+$/;
const hashPattern = /^[a-f0-9]{64}$/;
const draftApprovalDate = '1970-01-01T00:00:00.000Z';

/** Canonical public source references only. This module never fetches URLs. */
export function canonicalSourceUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('A public canonical HTTPS source URL is required'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port
    || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.')
    || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host)
    || /(?:^|\/)(?:oauth|callback|access[_-]?token|session|login|signin)(?:\/|$)/i.test(url.pathname)
    || value.length > 500) throw new Error('Source must be a public HTTPS URL without credentials, query, fragment, or private host');
  return url.toString();
}

const sourceFactSchema = z.object({
  text: z.string().trim().min(1).max(1200),
  productId: z.string().regex(productPattern).nullable().optional(),
  locale: z.enum(['el', 'en']).optional(),
}).strict();
const sourceDocumentSchema = z.object({ facts: z.array(sourceFactSchema).min(1).max(MAX_IMPORT_FACTS) }).strict();

function splitText(text: string): string[] {
  const chunks: string[] = [];
  for (let paragraph of text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(value => value.trim()).filter(Boolean)) {
    while (paragraph.length > 1200) {
      const boundary = paragraph.lastIndexOf(' ', 1200);
      const end = boundary >= 600 ? boundary : 1200;
      chunks.push(paragraph.slice(0, end).trim());
      paragraph = paragraph.slice(end).trim();
    }
    if (paragraph) chunks.push(paragraph);
  }
  if (!chunks.length || chunks.length > MAX_IMPORT_FACTS) throw new Error('Source must contain between 1 and 200 bounded fact passages');
  return chunks;
}

export interface SourceImport {
  shop: string; source: string; content: Uint8Array; format: 'text' | 'json';
  locale: Locale; productId?: string | null; retrievedAt?: string;
}

/** Imports create drafts. A changed source invalidates all its previous approvals. */
export function importSourceFacts(existing: ApprovedFact[], input: SourceImport): {
  facts: ApprovedFact[]; importedIds: string[]; revokedIds: string[]; unchanged: boolean;
} {
  if (!shopPattern.test(input.shop) || existing.some(fact => fact.shop !== input.shop)) throw new Error('Tenant config mismatch');
  if (!['el', 'en'].includes(input.locale) || (input.productId && !productPattern.test(input.productId))) throw new Error('Invalid import scope');
  if (input.content.byteLength === 0 || input.content.byteLength > MAX_SOURCE_BYTES) throw new Error('Source must be a UTF-8 file of at most 256 KiB');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(input.content); } catch { throw new Error('Source must be valid UTF-8'); }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text) || /<(?:html|script|iframe|body)\b/i.test(text)) throw new Error('Import visible plain text, Markdown, or the documented JSON format');
  const source = canonicalSourceUrl(input.source);
  const sourceHash = createHash('sha256').update(input.content).digest('hex');
  const sourceVersion = `sha256-${sourceHash}`;
  const retrievedAt = input.retrievedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(retrievedAt)) || Date.parse(retrievedAt) > Date.now()) throw new Error('Invalid source retrieval date');
  const passages = input.format === 'json'
    ? sourceDocumentSchema.parse(JSON.parse(text) as unknown).facts
    : splitText(text).map(value => ({ text: value, productId: input.productId ?? null, locale: input.locale }));
  const drafts: ApprovedFact[] = passages.map((passage, index) => {
    const productId = passage.productId === undefined ? input.productId ?? null : passage.productId;
    const locale = passage.locale ?? input.locale;
    const identity = JSON.stringify([input.shop, source, sourceHash, locale, productId, index]);
    return {
      id: `knowledge_${createHash('sha256').update(identity).digest('hex').slice(0, 40)}`,
      shop: input.shop, productId, locale, text: passage.text, source, sourceHash, sourceVersion, retrievedAt,
      approvedBy: '', approvedAt: draftApprovalDate, status: 'draft', expiresAt: null,
    };
  });
  const revokedIds: string[] = [];
  const existingIds = new Set(existing.map(fact => fact.id));
  const facts = existing.map(fact => {
    if (fact.source === source && fact.sourceHash !== sourceHash && fact.status !== 'revoked') {
      revokedIds.push(fact.id);
      return { ...fact, status: 'revoked' as const };
    }
    return { ...fact };
  });
  const importedIds: string[] = [];
  for (const draft of drafts) {
    if (existingIds.has(draft.id)) continue; // Reimporting identical bytes cannot reset or resurrect approval.
    facts.push(draft); importedIds.push(draft.id);
  }
  if (facts.length > MAX_TENANT_FACTS) throw new Error('Tenant fact limit reached; archive superseded records through a reviewed config change');
  return { facts, importedIds, revokedIds, unchanged: !revokedIds.length && !importedIds.length };
}

/** Fail closed when any newer source snapshot exists, including an unapproved draft. */
export function currentSourceFacts(facts: ApprovedFact[], shop: string): ApprovedFact[] {
  const local = facts.filter(fact => fact.shop === shop);
  const latest = new Map<string, { time: number; hashes: Set<string> }>();
  for (const fact of local) {
    if (!fact.sourceVersion && !fact.sourceHash && !fact.retrievedAt) continue;
    const time = Date.parse(fact.retrievedAt ?? '');
    if (!Number.isFinite(time) || time > Date.now() || !hashPattern.test(fact.sourceHash ?? '')
      || fact.sourceVersion !== `sha256-${fact.sourceHash}`) {
      latest.set(fact.source, { time: Infinity, hashes: new Set() });
      continue;
    }
    const previous = latest.get(fact.source);
    if (!previous || time > previous.time) latest.set(fact.source, { time, hashes: new Set([fact.sourceHash!]) });
    else if (time === previous.time) previous.hashes.add(fact.sourceHash!);
  }
  return local.filter(fact => {
    const source = latest.get(fact.source);
    if (!source) return true; // Existing manually approved records remain backward compatible.
    return source.hashes.size === 1 && source.hashes.has(fact.sourceHash ?? '')
      && fact.sourceVersion === `sha256-${fact.sourceHash}`
      && Number.isFinite(Date.parse(fact.retrievedAt ?? ''))
      && (fact.status !== 'approved' || Date.parse(fact.approvedAt) >= Date.parse(fact.retrievedAt!));
  });
}

export function approveFacts(facts: ApprovedFact[], shop: string, ids: string[], approvedBy: string, now = new Date()): ApprovedFact[] {
  if (!approvedBy.trim() || approvedBy.length > 100 || !ids.length || ids.length > MAX_IMPORT_FACTS) throw new Error('Explicit fact IDs and merchant approver are required');
  if (facts.some(fact => fact.shop !== shop)) throw new Error('Tenant config mismatch');
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) throw new Error('Duplicate fact IDs');
  const current = new Set(currentSourceFacts(facts, shop).map(fact => fact.id));
  const candidates = facts.filter(fact => uniqueIds.has(fact.id));
  if (candidates.length !== ids.length || candidates.some(fact => fact.status !== 'draft' || !current.has(fact.id)
    || (fact.retrievedAt && Date.parse(fact.retrievedAt) > now.getTime()))) throw new Error('Only current draft fact IDs can be approved');
  const approved = candidates.map(fact => ({ ...fact, approvedBy: approvedBy.trim(), approvedAt: now.toISOString(), status: 'approved' as const }));
  if (approved.some(fact => usableFacts([fact], shop, fact.locale, now.getTime()).length !== 1)) throw new Error('A selected fact violates the expiry or medical claim boundary');
  const byId = new Map(approved.map(fact => [fact.id, fact]));
  return facts.map(fact => byId.get(fact.id) ?? { ...fact });
}

export function revokeFacts(facts: ApprovedFact[], shop: string, ids: string[]): ApprovedFact[] {
  if (facts.some(fact => fact.shop !== shop)) throw new Error('Tenant config mismatch');
  const selected = new Set(ids);
  if (!ids.length || selected.size !== ids.length || facts.filter(fact => selected.has(fact.id)).length !== ids.length) throw new Error('Explicit existing fact IDs are required');
  return facts.map(fact => selected.has(fact.id) ? { ...fact, status: 'revoked' as const } : { ...fact });
}

const stopwords = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'what', 'you', 'can', 'are', 'how', 'μου', 'σου', 'και', 'για', 'απο', 'στο', 'την', 'τον', 'μια', 'ενα', 'ειναι', 'θελω', 'εχει', 'εχετε', 'ποιο', 'αυτο']);
function terms(value: string): Set<string> {
  return new Set(normalizeInput(value).replace(/ς/g, 'σ').split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 2 && !stopwords.has(term)).slice(0, 160));
}

/** Bounded lexical retrieval. Pass latest message plus recent user-only context as query. */
export function retrieveFacts(facts: ApprovedFact[], shop: string, locale: Locale, query: string, productIds?: string[], limit = 12): ApprovedFact[] {
  if (facts.length > MAX_TENANT_FACTS) return [];
  const requested = new Set(terms(query.slice(0, 8000)));
  const products = productIds === undefined ? undefined : new Set(productIds.slice(0, 12));
  const take = Number.isFinite(limit) ? Math.max(0, Math.min(24, Math.floor(limit))) : 12;
  const ranked = currentSourceFacts(facts, shop).filter(fact =>
    fact.locale === locale && (products === undefined || fact.productId === null || products.has(fact.productId)))
    .map(fact => {
      const words = terms(fact.text);
      const overlap = [...requested].filter(word => words.has(word)).length;
      // Product-specific facts support an explicit product selection, while unrelated global policies stay out.
      const score = overlap * 10 + (fact.productId && products?.has(fact.productId) ? 1 : 0);
      return { fact, score };
    }).filter(item => item.score > 0).sort((left, right) => right.score - left.score || left.fact.id.localeCompare(right.fact.id));
  return usableFacts(ranked.map(item => item.fact), shop, locale).slice(0, take);
}
