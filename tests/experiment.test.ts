import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../apps/server/src/app.js';
import { openDatabase, type Database } from '../apps/server/src/database.js';
import { Security } from '../apps/server/src/security.js';
import { experimentReport } from '../scripts/analytics-report.js';
import type { Catalog, Planner, ShopConfig } from '../packages/core/src/types.js';

const shop = 'abc-pilot.myshopify.com';
const env = { port: 3000, appUrl: 'https://test.example', allowedShops: [shop], apiKey: 'fixture-key', apiSecret: 'fixture-secret'.repeat(3), sessionSecret: 'fixture-session'.repeat(3), encryptionKey: randomBytes(32).toString('base64'), openaiKey: undefined, openaiModel: 'openai-fixture-v1', mistralKey: undefined, mistralModel: 'mistral-fixture-v1', databaseUrl: undefined };
const security = new Security(env.sessionSecret, env.encryptionKey);
const config: ShopConfig = { shop, brand: 'Fixture', locale: 'el', allowedCountries: ['GR'], enabled: true, defaultProvider: 'openai', experiment: { id: 'abc-v1', enabled: true, treatmentPercent: 50, arms: [{ id: 'openai', weight: 33 }, { id: 'mistral', weight: 33 }, { id: 'control', weight: 34 }] }, approvedImageUrls: [], knowledgeVersion: 'fixture-v1' };
const calls = { openai: 0, mistral: 0 };
const planner = (provider: 'openai' | 'mistral'): Planner => ({ plan: async () => { calls[provider]++; return { intent: 'greeting', searchQuery: '', productIds: [], factIds: [], variantId: null, quantity: null }; } });
const catalog: Catalog = { search: async () => [], getProducts: async () => [], getVariant: async () => null };
const db = await openDatabase(undefined, 'memory://');
const services = { planners: { openai: planner('openai'), mistral: planner('mistral') }, catalog: () => catalog, verifyProxy: async () => true };
const app = await buildApp(env, db, services);
const url = (path: string) => `/proxy/${path}?shop=${shop}`;
type Session = { token: string; conversationId: string; assignment: string; experimentId: string };
async function bootstrap(visitorId = randomUUID(), analyticsConsent = true) {
  const response = await app.inject({ method: 'POST', url: url('bootstrap'), payload: { visitorId, analyticsConsent, country: 'GR', locale: 'el' } });
  expect(response.statusCode).toBe(200); return response.json() as Session;
}
const chat = (session: Session, extra = {}) => app.inject({ method: 'POST', url: url('chat'), payload: { token: session.token, message: 'hello', country: 'GR', locale: 'el', ...extra } });
async function sessionsForAllArms() {
  const found = new Map<string, Session>();
  for (let n = 0; n < 40 && found.size < 3; n++) { const s = await bootstrap(); found.set(s.assignment, s); }
  expect(found.size).toBe(3); return found;
}
beforeAll(async () => { await db.query('INSERT INTO shops(shop,config,credentials,facts) VALUES($1,$2,$3,$4)', [shop, JSON.stringify(config), security.encrypt({ storefrontToken: 'fixture' }, shop), '[]']); });
beforeEach(async () => {
  for (const table of ['conversations', 'events', 'pixel_assignments', 'eligible_exposures', 'experiment_specs', 'model_usage', 'usage_buckets']) await db.query(`DELETE FROM ${table}`);
  await db.query('UPDATE shops SET config=$2,facts=$3 WHERE shop=$1', [shop, JSON.stringify(config), '[]']);
  calls.openai = 0; calls.mistral = 0;
});
afterAll(async () => { await app.close(); await db.close(); });

describe('three-arm experiment and server-selected providers', () => {
  it('keeps one visitor in one arm across sessions and never counts repeats or unconsented visitors twice', async () => {
    const visitor = randomUUID(); const first = await bootstrap(visitor); const second = await bootstrap(visitor);
    expect(first.conversationId).not.toBe(second.conversationId); expect(first.assignment).toBe(second.assignment);
    const untracked = await bootstrap(randomUUID(), false); expect(untracked.assignment).toBe('untracked');
    expect((await db.query('SELECT visitor_hash FROM eligible_exposures')).rows).toHaveLength(1);
    const report = await experimentReport(db, shop);
    expect(report.cohorts[0]!.eligible_visitors).toBe(1);
    expect(report.cohorts[0]!.visitors_opened).toBe(0);
  });
  it('routes solely from signed assignment and denies control and client-supplied provider overrides', async () => {
    const sessions = await sessionsForAllArms();
    expect((await chat(sessions.get('openai')!)).statusCode).toBe(200);
    expect((await chat(sessions.get('mistral')!)).statusCode).toBe(200);
    expect((await chat(sessions.get('control')!)).statusCode).toBe(403);
    expect((await chat(sessions.get('openai')!, { provider: 'mistral' })).statusCode).toBe(400);
    expect(calls).toEqual({ openai: 1, mistral: 1 });
    const claims = security.verify(sessions.get('openai')!.token, shop);
    const altered = security.sign({ ...claims, assignment: 'mistral', provider: 'mistral' });
    expect((await chat({ ...sessions.get('openai')!, token: altered })).statusCode).toBe(401);
  });
  it('does not silently fall back when the assigned provider is unavailable', async () => {
    const sessions = await sessionsForAllArms();
    const isolated = await buildApp(env, db, { ...services, planners: { openai: planner('openai') } });
    try {
      const session = sessions.get('mistral')!;
      expect((await isolated.inject('/readyz')).statusCode).toBe(503);
      expect((await isolated.inject({ method: 'POST', url: url('bootstrap'), payload: { visitorId: randomUUID(), analyticsConsent: true, country: 'GR', locale: 'el' } })).statusCode).toBe(503);
      const response = await isolated.inject({ method: 'POST', url: url('chat'), payload: { token: session.token, message: 'hello', country: 'GR', locale: 'el' } });
      expect(response.statusCode).toBe(503); expect(calls.openai).toBe(0);
      expect((await db.query<{ assignment: string }>('SELECT assignment FROM conversations WHERE id=$1', [session.conversationId])).rows[0]!.assignment).toBe('mistral');
    } finally { await isolated.close(); }
  });
  it('rejects old sessions and reused experiment IDs after knowledge or instructions change', async () => {
    const session = await bootstrap();
    await db.query('UPDATE shops SET config=$2 WHERE shop=$1', [shop, JSON.stringify({ ...config, knowledgeVersion: 'fixture-v2' })]);
    expect((await chat(session)).statusCode).toBe(401);
    const response = await app.inject({ method: 'POST', url: url('bootstrap'), payload: { visitorId: randomUUID(), analyticsConsent: true, country: 'GR', locale: 'el' } });
    expect(response.statusCode).toBe(409);
    expect((await db.query('SELECT config_fingerprint FROM experiment_specs')).rows).toHaveLength(1);
    await db.query('UPDATE shops SET config=$2 WHERE shop=$1', [shop, JSON.stringify({ ...config, knowledgeVersion: 'fixture-v2', experiment: { ...config.experiment, id: 'abc-v2' } })]);
    expect((await bootstrap()).experimentId).toBe('abc-v2');
  });
  it('withholds an in-flight reply when merchant knowledge changes during generation', async () => {
    const session = (await sessionsForAllArms()).get('openai')!;
    const changing: Planner = { plan: async () => {
      await db.query('UPDATE shops SET config=$2 WHERE shop=$1', [shop, JSON.stringify({ ...config, knowledgeVersion: 'revoked-during-turn' })]);
      return { intent: 'greeting', searchQuery: '', productIds: [], factIds: [], variantId: null, quantity: null };
    } };
    const isolated = await buildApp(env, db, { ...services, planners: { openai: changing, mistral: planner('mistral') } });
    try {
      const response = await isolated.inject({ method: 'POST', url: url('chat'), payload: { token: session.token, message: 'hello', country: 'GR', locale: 'el' } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).not.toHaveProperty('text');
      const row = (await db.query<{ history: string }>('SELECT history FROM conversations WHERE shop=$1 AND id=$2', [shop, session.conversationId])).rows[0]!;
      expect(security.decrypt(row.history, shop)).toEqual([]);
    } finally { await isolated.close(); }
  });
  it('counts unique purchasing visitors, deduplicates orders, and keeps currencies separate', async () => {
    const visitor = randomUUID(); const session = await bootstrap(visitor); await bootstrap(visitor);
    const clientId = randomUUID();
    const send = (event: unknown) => app.inject({ method: 'POST', url: '/api/pixel/events', payload: { shop, ingestKey: security.pixelKey(shop), event } });
    await send({ id: randomUUID(), name: 'experiment_exposure', clientId, conversationId: session.conversationId, experimentId: session.experimentId, assignment: session.assignment });
    for (const orderId of ['123', 'gid://shopify/Order/123', '124']) await send({ id: randomUUID(), name: 'purchase', clientId, orderId, totalAmount: '50.00', currency: 'EUR' });
    await send({ id: randomUUID(), name: 'purchase', clientId, orderId: '125', totalAmount: '60', currency: 'USD' });
    await send({ id: randomUUID(), name: 'purchase', clientId, totalAmount: '999', currency: 'EUR' });
    const report = await experimentReport(db, shop);
    expect(report.cohorts[0]).toMatchObject({ eligible_visitors: 1, visitors_checkout_completed: 1, checkout_completions: 3 });
    expect(report.checkoutValues).toEqual(expect.arrayContaining([expect.objectContaining({ currency: 'EUR', observed_checkout_value: '100.00' }), expect.objectContaining({ currency: 'USD', observed_checkout_value: '60' })]));
  });
  it('withholds attribution when one pixel identity has conflicting enrolled visitors', async () => {
    const old = await bootstrap(); const next = await bootstrap(); const clientId = randomUUID();
    const send = (event: unknown) => app.inject({ method: 'POST', url: '/api/pixel/events', payload: { shop, ingestKey: security.pixelKey(shop), event } });
    for (const session of [old, next]) await send({ id: randomUUID(), name: 'experiment_exposure', clientId, conversationId: session.conversationId, experimentId: session.experimentId, assignment: session.assignment });
    await send({ id: randomUUID(), name: 'purchase', clientId, orderId: '999' });
    expect((await db.query('SELECT id FROM events WHERE name=$1', ['purchase'])).rows).toHaveLength(0);
    expect((await db.query<{ ambiguous: boolean }>('SELECT ambiguous FROM pixel_assignments')).rows[0]?.ambiguous).toBe(true);
  });
  it('removes all visitor exposure/event links after consent withdrawal even after the session was purged', async () => {
    const visitor = randomUUID(); const old = await bootstrap(visitor); const current = await bootstrap(visitor);
    await app.inject({ method: 'POST', url: url('events'), payload: { token: old.token, events: [{ id: randomUUID(), name: 'experiment_exposure' }] } });
    await db.query('DELETE FROM conversations WHERE id=$1', [current.conversationId]);
    const response = await app.inject({ method: 'POST', url: url('consent'), payload: { token: current.token, analyticsConsent: false } });
    expect(response.statusCode).toBe(204);
    for (const table of ['eligible_exposures', 'events', 'pixel_assignments']) expect((await db.query(`SELECT shop FROM ${table}`)).rows).toHaveLength(0);
    expect((await db.query<{ consent: boolean; visitor_hash: string | null }>('SELECT consent,visitor_hash FROM conversations WHERE id=$1', [old.conversationId])).rows[0]).toEqual({ consent: false, visitor_hash: null });
    expect((await chat(old)).statusCode).toBe(old.assignment === 'control' ? 403 : 200);
  });
  it('accepts valid consent withdrawal after disablement and removal of model credentials', async () => {
    const session = await bootstrap();
    await db.query('UPDATE shops SET config=$2,active=false WHERE shop=$1', [shop, JSON.stringify({ ...config, enabled: false })]);
    const isolated = await buildApp(env, db, { verifyProxy: async () => true });
    try {
      expect((await isolated.inject('/readyz')).statusCode).toBe(503);
      const response = await isolated.inject({ method: 'POST', url: url('consent'), payload: { token: session.token, analyticsConsent: false } });
      expect(response.statusCode).toBe(204);
      expect((await db.query('SELECT visitor_hash FROM eligible_exposures')).rows).toHaveLength(0);
    } finally { await isolated.close(); await db.query('UPDATE shops SET active=true WHERE shop=$1', [shop]); }
  });
  it('allows an idle old tab to revoke retained exposures for the full 90-day analytics window', async () => {
    const session = await bootstrap();
    const old = security.sign({ ...security.verify(session.token, shop), exp: Math.floor(Date.now() / 1000) - 40 * 86400 });
    expect((await chat({ ...session, token: old })).statusCode).toBe(401);
    await db.query('DELETE FROM conversations WHERE id=$1', [session.conversationId]);
    expect((await app.inject({ method: 'POST', url: url('consent'), payload: { token: old, analyticsConsent: false } })).statusCode).toBe(204);
    expect((await db.query('SELECT visitor_hash FROM eligible_exposures')).rows).toHaveLength(0);
    const tooOld = security.sign({ ...security.verify(session.token, shop), exp: Math.floor(Date.now() / 1000) - 91 * 86400 });
    expect((await app.inject({ method: 'POST', url: url('consent'), payload: { token: tooOld, analyticsConsent: false } })).statusCode).toBe(401);
  });
  it('uses a fresh revocation snapshot to erase simulated concurrent commits missed by its first snapshot', async () => {
    const session = await bootstrap(); const claims = security.verify(session.token, shop); const clientHash = security.hashClient(shop, randomUUID());
    // This adapter models the committed result of a READ COMMITTED snapshot missing a
    // concurrent write. It is deterministic interleaving coverage, not a real multi-connection PG test.
    const interleaved: Database = { ...db, query: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const result = await db.query<T>(sql, params);
      if (sql.startsWith('WITH affected AS')) {
        await db.query("INSERT INTO events(shop,id,name,source,conversation_id,visitor_hash) VALUES($1,$2,'experiment_exposure','widget',$3,$4)", [shop, randomUUID(), session.conversationId, claims.visitorHash]);
        await db.query("INSERT INTO pixel_assignments(shop,client_hash,experiment_id,assignment,conversation_id,expires_at,visitor_hash) VALUES($1,$2,$3,$4,$5,now()+interval '1 day',$6)", [shop, clientHash, session.experimentId, session.assignment, session.conversationId, claims.visitorHash]);
        await db.query('INSERT INTO eligible_exposures(shop,experiment_id,visitor_hash,assignment,config_fingerprint) VALUES($1,$2,$3,$4,$5)', [shop, session.experimentId, claims.visitorHash, session.assignment, claims.configFingerprint]);
      }
      return result;
    } };
    const isolated = await buildApp(env, interleaved, services);
    try {
      expect((await isolated.inject({ method: 'POST', url: url('consent'), payload: { token: session.token, analyticsConsent: false } })).statusCode).toBe(204);
      for (const table of ['events', 'pixel_assignments', 'eligible_exposures']) expect((await db.query(`SELECT shop FROM ${table}`)).rows).toHaveLength(0);
    } finally { await isolated.close(); }
  });
  it.each(['widget', 'mapping', 'purchase'] as const)('cleans a simulated %s write that commits after revocation finished', async kind => {
    const session = await bootstrap(); const claims = security.verify(session.token, shop); const clientId = randomUUID(); const clientHash = security.hashClient(shop, clientId); const id = randomUUID();
    const expose = { id: randomUUID(), name: 'experiment_exposure', clientId, conversationId: session.conversationId, assignment: session.assignment, experimentId: session.experimentId };
    if (kind === 'purchase') await app.inject({ method: 'POST', url: '/api/pixel/events', payload: { shop, ingestKey: security.pixelKey(shop), event: expose } });
    let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const paused = new Promise<void>(resolve => { release = resolve; });
    const interleaved: Database = { ...db, query: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const target = kind === 'mapping' ? sql.startsWith('INSERT INTO pixel_assignments') : sql.startsWith('INSERT INTO events');
      if (target) {
        entered(); await paused;
        // Reproduce a write admitted by an earlier consent=true snapshot without pretending
        // that PGlite's single connection implements PostgreSQL concurrent snapshots.
        if (kind === 'mapping') await db.query("INSERT INTO pixel_assignments(shop,client_hash,experiment_id,assignment,conversation_id,expires_at,visitor_hash) VALUES($1,$2,$3,$4,$5,now()+interval '1 day',$6)", [shop, clientHash, session.experimentId, session.assignment, session.conversationId, claims.visitorHash]);
        else await db.query('INSERT INTO events(shop,id,name,source,conversation_id,client_hash,visitor_hash) VALUES($1,$2,$3,$4,$5,$6,$7)', [shop, params![1], kind === 'purchase' ? 'purchase' : 'experiment_exposure', kind === 'purchase' ? 'pixel' : 'widget', session.conversationId, kind === 'purchase' ? clientHash : null, claims.visitorHash]);
        return { rows: [] as T[] };
      }
      return db.query<T>(sql, params);
    } };
    const isolated = await buildApp(env, interleaved, services);
    try {
      const request = kind === 'widget'
        ? isolated.inject({ method: 'POST', url: url('events'), payload: { token: session.token, events: [{ id, name: 'experiment_exposure' }] } })
        : isolated.inject({ method: 'POST', url: '/api/pixel/events', payload: { shop, ingestKey: security.pixelKey(shop), event: kind === 'mapping' ? expose : { id, name: 'purchase', clientId, orderId: '54321' } } });
      // inject is lazy until observed.
      const completed = Promise.resolve(request);
      await reached;
      expect((await app.inject({ method: 'POST', url: url('consent'), payload: { token: session.token, analyticsConsent: false } })).statusCode).toBe(204);
      release(); expect((await completed).statusCode).toBe(204);
      for (const table of ['events', 'pixel_assignments', 'eligible_exposures']) expect((await db.query(`SELECT shop FROM ${table}`)).rows).toHaveLength(0);
    } finally { release(); await isolated.close(); }
  });
  it('retains anonymous operational usage with unknown tokens explicitly counted', async () => {
    const isolated = await buildApp(env, db, { ...services, modelFactory: (provider, onUsage) => ({ planner: { plan: async input => {
      onUsage({ provider, model: 'fixture-model', operation: 'plan', inputTokens: null, outputTokens: 7, durationMs: 20, success: true });
      return planner(provider).plan(input);
    } } }) });
    try {
      const session = await bootstrap(randomUUID(), false);
      await isolated.inject({ method: 'POST', url: url('chat'), payload: { token: session.token, message: 'private test message', country: 'GR', locale: 'el' } });
      const usage = (await db.query('SELECT * FROM model_usage')).rows;
      expect(usage).toHaveLength(1); expect(usage[0]).toMatchObject({ experiment_id: 'off', assignment: 'untracked', provider: 'openai', unknown_token_requests: 1, requests: 1 });
      expect(JSON.stringify(usage)).not.toContain(session.conversationId); expect(JSON.stringify(usage)).not.toContain('private test message');
      expect(usage[0]).not.toHaveProperty('visitor_hash');
    } finally { await isolated.close(); }
  });
});
