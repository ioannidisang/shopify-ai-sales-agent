import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approveFacts, canonicalSourceUrl, currentSourceFacts, importSourceFacts, MAX_SOURCE_BYTES, retrieveFacts, revokeFacts } from '../packages/core/src/knowledge.js';
import { runKnowledgeCommand } from '../scripts/knowledge.js';
import type { ApprovedFact } from '../packages/core/src/types.js';

const shop = 'pilot.myshopify.com';
const source = 'https://example.com/pages/shipping';
const product = 'gid://shopify/Product/123';
function imported(text = 'Παράδοση στην Ελλάδα σε τρεις εργάσιμες ημέρες.', existing: ApprovedFact[] = [], retrievedAt = '2026-01-01T00:00:00.000Z') {
  return importSourceFacts(existing, { shop, source, content: Buffer.from(text), format: 'text', locale: 'el', retrievedAt });
}
function approved(text?: string) {
  const { facts } = imported(text);
  return approveFacts(facts, shop, facts.map(fact => fact.id), 'Merchant', new Date('2026-01-02T00:00:00.000Z'));
}

describe('merchant source version lifecycle', () => {
  it('creates isolated drafts with byte-level provenance without approval or retrieval', () => {
    const { facts } = imported();
    expect(facts[0]).toMatchObject({ shop, status: 'draft', approvedBy: '', source });
    expect(facts[0]!.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(facts[0]!.sourceVersion).toBe(`sha256-${facts[0]!.sourceHash}`);
    expect(retrieveFacts(facts, shop, 'el', 'Παράδοση')).toEqual([]);
  });
  it('requires specific current draft IDs and explicit merchant identity for approval', () => {
    const { facts } = imported();
    expect(() => approveFacts(facts, shop, [], 'Merchant')).toThrow();
    expect(() => approveFacts(facts, shop, [facts[0]!.id], '')).toThrow();
    expect(() => approveFacts(facts, shop, ['invented'], 'Merchant')).toThrow();
    const accepted = approveFacts(facts, shop, [facts[0]!.id], 'Merchant');
    expect(retrieveFacts(accepted, shop, 'el', 'παραδοση')[0]!.text).toBe(facts[0]!.text);
    expect(accepted[0]!.approvedBy).toBe('Merchant');
    expect(facts[0]!.status).toBe('draft');
  });
  it('does not auto-approve clinical claims even when a merchant attempts approval', () => {
    const { facts } = imported('This product cures diabetes.');
    expect(() => approveFacts(facts, shop, [facts[0]!.id], 'Merchant')).toThrow('medical claim');
  });
  it('revokes previous source approvals when even a whitespace-only source revision is imported', () => {
    const old = approved();
    const replacement = imported(`${old[0]!.text}\n`, old, '2026-01-03T00:00:00.000Z');
    expect(replacement.revokedIds).toEqual([old[0]!.id]);
    expect(replacement.facts.map(fact => fact.status)).toEqual(['revoked', 'draft']);
    expect(replacement.facts[1]!.text).toBe(old[0]!.text);
    expect(replacement.facts[1]!.sourceHash).not.toBe(old[0]!.sourceHash);
    expect(retrieveFacts(replacement.facts, shop, 'el', 'παραδοση')).toEqual([]);
    expect(() => approveFacts(replacement.facts, shop, [old[0]!.id], 'Merchant')).toThrow('current draft');
  });
  it('keeps identical imports idempotent and never resurrects revoked records', () => {
    const facts = approved();
    expect(imported(facts[0]!.text, facts).unchanged).toBe(true);
    const revoked = revokeFacts(facts, shop, [facts[0]!.id]);
    expect(imported(facts[0]!.text, revoked).facts[0]!.status).toBe('revoked');
    const revision = imported('Νέα παράδοση στην Ελλάδα.', facts, '2026-01-03T00:00:00.000Z');
    expect(imported('Νέα παράδοση στην Ελλάδα.', revision.facts, '2026-01-04T00:00:00.000Z').unchanged).toBe(true);
  });
  it('fails closed for stale, malformed and ambiguous source revisions even if config manually leaves approval intact', () => {
    const facts = approved();
    const draft = imported('Νέα πολιτική παράδοσης.', facts, '2026-01-03T00:00:00.000Z').facts[1]!;
    expect(retrieveFacts([...facts, draft], shop, 'el', 'παραδοση')).toEqual([]);
    expect(currentSourceFacts([...facts, { ...draft, retrievedAt: 'invalid' }], shop)).toEqual([]);
    expect(currentSourceFacts([...facts, { ...draft, retrievedAt: facts[0]!.retrievedAt }], shop)).toEqual([]);
    expect(currentSourceFacts([{ ...facts[0]!, approvedAt: '2025-12-01T00:00:00.000Z' }], shop)).toEqual([]);
    expect(() => approveFacts([draft], shop, [draft.id], 'Merchant', new Date('2026-01-02T00:00:00.000Z'))).toThrow('current draft');
  });
  it.each([
    'http://example.com/page', 'https://example.com/page?token=secret', 'https://user:password@example.com/page',
    'https://example.com/page#secret', 'https://localhost/page', 'https://127.0.0.1/page',
    'https://[::1]/page', 'https://metadata.internal/page', 'https://example.com/oauth/callback',
  ])('rejects noncanonical or authenticated source references: %s', value => {
    expect(() => canonicalSourceUrl(value)).toThrow();
  });
  it('rejects foreign tenants, oversized or invalid UTF-8 sources, HTML and unrecognized JSON fields', () => {
    expect(() => imported('new', [{ ...approved()[0]!, shop: 'other.myshopify.com' }])).toThrow('Tenant');
    const base = { shop, source, format: 'text' as const, locale: 'el' as const };
    expect(() => importSourceFacts([], { ...base, content: Buffer.alloc(MAX_SOURCE_BYTES + 1) })).toThrow('256');
    expect(() => importSourceFacts([], { ...base, content: Buffer.from([0xc0, 0xaf]) })).toThrow('UTF-8');
    expect(() => imported('<html>Example</html>')).toThrow('plain text');
    expect(() => importSourceFacts([], { ...base, format: 'json', content: Buffer.from('{"facts":[{"text":"hello","approvedBy":"Fake"}]}') })).toThrow();
  });
});

describe('bounded grounded lexical retrieval', () => {
  it('filters tenant, language, status, expiry and product scope before showing any knowledge', () => {
    const facts = approved('Vanilla protein is available in a 500 g pack.').map(fact => ({ ...fact, locale: 'en' as const, productId: product }));
    const base = facts[0]!;
    const mixed: ApprovedFact[] = [base,
      { ...base, id: 'foreign', shop: 'other.myshopify.com' },
      { ...base, id: 'language', locale: 'el' }, { ...base, id: 'draft', status: 'draft' },
      { ...base, id: 'revoked', status: 'revoked' }, { ...base, id: 'expired', expiresAt: '2020-01-01T00:00:00.000Z' },
      { ...base, id: 'other-product', productId: 'gid://shopify/Product/456' },
      { ...base, id: 'unrelated-policy', text: 'Returns are accepted within fourteen days.', productId: null },
    ];
    expect(retrieveFacts(mixed, shop, 'en', 'vanilla', [product])).toEqual([base]);
    expect(retrieveFacts(mixed, shop, 'en', 'vanilla', [])).toEqual([]);
  });
  it('ranks all tenant facts before the legacy 100-item safety bound and normalizes Greek accents', () => {
    const base = approved()[0]!;
    const unrelated = Array.from({ length: 130 }, (_, i) => ({ ...base, id: `unrelated-${i}`, text: 'Επιστροφή προϊόντος.' }));
    expect(retrieveFacts([...unrelated, base], shop, 'el', 'ΠΑΡΑΔΟΣΗ')).toEqual([base]);
    expect(retrieveFacts([base], shop, 'el', 'άσχετο')).toEqual([]);
    expect(retrieveFacts([base], shop, 'el', 'παράδοση', undefined, 0)).toEqual([]);
  });
  it('includes selected product evidence without adding unrelated global claims and bounds output', () => {
    const base = approved()[0]!;
    const facts = Array.from({ length: 40 }, (_, i) => ({ ...base, id: `selected-${i}`, productId: product }));
    expect(retrieveFacts(facts, shop, 'el', 'αυτό', [product], 999)).toHaveLength(24);
    expect(retrieveFacts([base], shop, 'el', 'αυτό', [product])).toEqual([]);
    expect(retrieveFacts(Array.from({ length: 1001 }, (_, i) => ({ ...base, id: `excess-${i}` })), shop, 'el', 'παράδοση')).toEqual([]);
  });
});

const temporaryDirectories: string[] = [];
afterEach(async () => {
  // Each target is a test-owned mkdtemp result under the OS temporary directory.
  for (const directory of temporaryDirectories.splice(0)) {
    const target = resolve(directory);
    if (!target.startsWith(`${resolve(tmpdir())}${sep}`) || !basename(target).startsWith('sales-knowledge-test-')) throw new Error('Unsafe test cleanup target');
    await rm(target, { recursive: true, force: true });
  }
});
async function tenantFixture() {
  const root = await mkdtemp(join(tmpdir(), 'sales-knowledge-test-')); temporaryDirectories.push(root);
  const config = {
    shop, brand: 'Pilot', locale: 'el', allowedCountries: ['GR'], enabled: true,
    experiment: { id: 'test-v1', enabled: false, treatmentPercent: 50 }, approvedImageUrls: [], knowledgeVersion: '1',
  };
  const path = join(root, `${shop}.json`);
  await writeFile(path, JSON.stringify({ config, facts: [] }));
  return { root, path, sourceFile: join(root, 'shipping.txt'), profileFile: join(root, 'profile.json') };
}

describe('local merchant knowledge CLI', () => {
  it('keeps imported drafts in the tenant file and requires reviewed approval before retrieval', async () => {
    const fixture = await tenantFixture();
    await writeFile(fixture.sourceFile, 'Παράδοση σε τρεις εργάσιμες ημέρες.');
    const output: string[] = []; const settings = { root: fixture.root, output: (value: string) => output.push(value) };
    await runKnowledgeCommand(['import', shop, '--file', fixture.sourceFile, '--source', source], settings);
    const draft = JSON.parse(await readFile(fixture.path, 'utf8'));
    expect(draft.facts).toHaveLength(1); expect(draft.facts[0].status).toBe('draft');
    expect(retrieveFacts(draft.facts, shop, 'el', 'παραδοση')).toEqual([]);
    await expect(runKnowledgeCommand(['approve', shop, '--ids', draft.facts[0].id, '--by', 'Merchant'], settings)).rejects.toThrow('confirmed');
    expect(JSON.parse(await readFile(fixture.path, 'utf8')).facts[0].status).toBe('draft');
    await runKnowledgeCommand(['approve', shop, '--ids', draft.facts[0].id, '--by', 'Merchant', '--confirm-reviewed', 'true'], settings);
    const final = JSON.parse(await readFile(fixture.path, 'utf8'));
    expect(retrieveFacts(final.facts, shop, 'el', 'παραδοση')).toHaveLength(1);
    expect(final.config.knowledgeVersion).not.toBe(draft.config.knowledgeVersion);
    expect(output.join('\n')).not.toContain('Παράδοση'); // Only explicit review prints approved source content.
  });
  it('installs reviewed versioned conversation instructions separately from product facts', async () => {
    const fixture = await tenantFixture();
    const profile = { version: 'greek-v1', instructions: 'Μίλα στον ενικό. Ρώτα μία διευκρίνιση τη φορά.', examples: [] };
    await writeFile(fixture.profileFile, JSON.stringify(profile));
    const settings = { root: fixture.root, output: () => {} };
    await expect(runKnowledgeCommand(['training-import', shop, '--file', fixture.profileFile, '--by', 'Merchant'], settings)).rejects.toThrow('confirmed');
    await runKnowledgeCommand(['training-review', shop, '--file', fixture.profileFile], settings);
    expect(JSON.parse(await readFile(fixture.path, 'utf8')).config.conversation).toBeUndefined();
    await runKnowledgeCommand(['training-import', shop, '--file', fixture.profileFile, '--by', 'Merchant', '--confirm-reviewed', 'true'], settings);
    const stored = JSON.parse(await readFile(fixture.path, 'utf8'));
    expect(stored.config.conversation).toMatchObject({ ...profile, approvedBy: 'Merchant' });
    expect(stored.facts).toEqual([]);
    await expect(runKnowledgeCommand(['training-import', shop, '--file', fixture.profileFile, '--by', 'Merchant', '--confirm-reviewed', 'true'], settings)).rejects.toThrow('new conversation version');
  });
});
