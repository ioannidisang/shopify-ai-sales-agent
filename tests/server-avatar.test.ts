import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { buildApp } from '../apps/server/src/app.js';
import { openDatabase, type Database } from '../apps/server/src/database.js';
import type { RuntimeEnvironment } from '../apps/server/src/config.js';
import { Security } from '../apps/server/src/security.js';
import { TavusAllocationCleanupError, type TavusProvider } from '../apps/server/src/tavus-client.js';
import { MEDICAL_HISTORY_MARKER } from '../packages/core/src/index.js';
import type { Catalog, Planner, ShopConfig } from '../packages/core/src/types.js';
import type { ConversationModel } from '../packages/core/src/conversation.js';

const shop = 'bionera-gr.myshopify.com';
const secondShop = 'second.myshopify.com';
const accessCode = 'private-test-access-code-only';
const approvedText = 'Θέλεις να δούμε τις διαθέσιμες επιλογές;';
const apiSecret = 'test-shopify-secret'.repeat(3);
const environment: RuntimeEnvironment = {
  port: 3000, appUrl: 'https://app.example.com', allowedShops: [shop, secondShop],
  apiKey: 'test-shopify-client', apiSecret, sessionSecret: 'test-session-secret'.repeat(4),
  encryptionKey: randomBytes(32).toString('base64'), databaseUrl: undefined,
  openaiKey: undefined, openaiModel: undefined, mistralKey: undefined, mistralModel: undefined,
  tavus: { apiKey: 'test-tavus-api-key-only', faceId: 'r123trial', pilotShop: shop,
    accessCodeHash: createHash('sha256').update(accessCode).digest('hex') },
};
const security = new Security(environment.sessionSecret!, environment.encryptionKey!);
const baseConfig: ShopConfig = {
  shop, brand: 'Bionera', locale: 'el', allowedCountries: ['GR'], enabled: true,
  experiment: { id: 'private-v1', enabled: false, treatmentPercent: 100 },
  approvedImageUrls: [], knowledgeVersion: 'approved-v1',
  conversation: { version: 'style-v1', instructions: 'Μίλα σύντομα.', examples: [], approvedBy: 'Merchant', approvedAt: '2026-01-01T00:00:00Z' },
};
const catalog: Catalog = { search: async () => [], getProducts: async () => [], getVariant: async () => null };
type Bootstrap = { token: string; conversationId: string; avatar?: unknown };
type Started = { sessionId: string; conversationId: string; conversationUrl: string; meetingToken: string; expiresAt: string };
let db: Database;
let app: FastifyInstance | undefined;
let provider: ReturnType<typeof mockProvider>;
let planner: { plan: ReturnType<typeof vi.fn<Planner['plan']>> };
let composer: { compose: ReturnType<typeof vi.fn<ConversationModel['compose']>>; verify: ReturnType<typeof vi.fn<ConversationModel['verify']>> };

function mockProvider() {
  return {
    createPal: vi.fn<TavusProvider['createPal']>().mockImplementation(async () => ({ palId: `p${randomBytes(6).toString('hex')}` })),
    createConversation: vi.fn<TavusProvider['createConversation']>().mockImplementation(async () => {
      const id = `c${randomBytes(6).toString('hex')}`;
      return { conversationId: id, conversationUrl: `https://tavus.daily.co/${id}`, meetingToken: 'header.payload.signature', status: 'active' };
    }),
    endConversation: vi.fn<TavusProvider['endConversation']>().mockResolvedValue(undefined),
    deleteConversation: vi.fn<TavusProvider['deleteConversation']>().mockResolvedValue(undefined),
    deletePal: vi.fn<TavusProvider['deletePal']>().mockResolvedValue(undefined),
    getConversationDiagnostics: vi.fn<NonNullable<TavusProvider['getConversationDiagnostics']>>().mockResolvedValue(undefined),
  };
}
function proxy(path: string, tenant = shop) {
  const values: Record<string, string> = { shop: tenant, timestamp: String(Math.floor(Date.now() / 1000)), path_prefix: '/apps/sales-agent', logged_in_customer_id: '' };
  const input = Object.keys(values).sort().map(key => `${key}=${values[key]}`).join('');
  const params = new URLSearchParams(values);
  params.set('signature', createHmac('sha256', apiSecret).update(input).digest('hex'));
  return `/proxy/${path}?${params}`;
}
async function build(env = environment) {
  app = await buildApp(env, db, { tavus: provider, planner, composer, catalog: () => catalog });
  return app;
}
async function bootstrap(tenant = shop) {
  const response = await app!.inject({ method: 'POST', url: proxy('bootstrap', tenant), payload: { analyticsConsent: false, country: 'GR', locale: 'el' } });
  expect(response.statusCode).toBe(200);
  return response.json<Bootstrap>();
}
function start(session: Bootstrap, code: string | undefined = accessCode) {
  return app!.inject({ method: 'POST', url: proxy('avatar/start'), payload: { token: session.token, ...(code === undefined ? {} : { accessCode: code }) } });
}
async function started(session: Bootstrap) {
  const response = await start(session);
  expect(response.statusCode).toBe(200);
  return response.json<Started>();
}
function secret(index = 0) { return provider.createPal.mock.calls[index]![0].callbackSecret; }
function callback(room: Started, text = 'Γεια σου', bearer = secret(), messages?: unknown[]) {
  return app!.inject({ method: 'POST', url: `/api/avatar/${room.sessionId}/v1/chat/completions`,
    headers: { authorization: `Bearer ${bearer}` }, payload: { model: 'shopify-grounded', stream: true, messages: messages ?? [{ role: 'user', content: text }] } });
}
function callbackClient(room: Started) {
  return new OpenAI({ apiKey: secret(), baseURL: `https://app.example.com/api/avatar/${room.sessionId}/v1`, maxRetries: 0,
    // The SDK talks only to Fastify injection. Split UTF-8 bytes across chunks to
    // exercise the real SSE decoder, including Greek multibyte characters.
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const response = await app!.inject({ method: 'POST', url: new URL(request.url).pathname,
        headers: { authorization: request.headers.get('authorization')!, 'content-type': 'application/json' }, payload: await request.text() });
      const bytes = new TextEncoder().encode(response.body);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
        controller.close();
      } }), { status: response.statusCode, headers: { 'content-type': String(response.headers['content-type']) } });
    },
  });
}
function end(session: Bootstrap, room: Started, tenant = shop) {
  return app!.inject({ method: 'POST', url: proxy('avatar/end', tenant), payload: { token: session.token, sessionId: room.sessionId } });
}
function poll(session: Bootstrap, room: Started, after = 0, tenant = shop) {
  return app!.inject({ method: 'POST', url: proxy('avatar/result', tenant), payload: { token: session.token, sessionId: room.sessionId, after } });
}
async function row(room: Started) { return (await db.query('SELECT * FROM avatar_sessions WHERE id=$1', [room.sessionId])).rows[0]!; }
async function configure(changes: Partial<ShopConfig>) {
  await db.query('UPDATE shops SET config=$2 WHERE shop=$1', [shop, JSON.stringify({ ...baseConfig, ...changes })]);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeAll(async () => { db = await openDatabase(undefined, 'memory://'); }, 20000);
beforeEach(async () => {
  await db.query('DELETE FROM shops');
  for (const tenant of [shop, secondShop]) {
    await db.query('INSERT INTO shops(shop,config,credentials,facts) VALUES($1,$2,$3,$4)', [tenant,
      JSON.stringify({ ...baseConfig, shop: tenant }), security.encrypt({ storefrontToken: 'test-only' }, tenant), '[]']);
  }
  provider = mockProvider();
  planner = { plan: vi.fn<Planner['plan']>().mockResolvedValue({ intent: 'greeting', searchQuery: '', productIds: [], factIds: [], variantId: null, quantity: null }) };
  composer = {
    compose: vi.fn<ConversationModel['compose']>().mockResolvedValue({ segments: [{ text: approvedText, productIds: [], factIds: [] }] }),
    verify: vi.fn<ConversationModel['verify']>().mockResolvedValue({ supported: true, medical: false }),
  };
});
afterEach(async () => { await app?.close(); app = undefined; });
afterAll(async () => { await db.close(); });

describe('private Tavus pilot with real PostgreSQL and signed Shopify sessions', () => {
  it('captures an allowlisted provider shutdown before ending and deleting without logging private data', async () => {
    await build();
    const session = await bootstrap(); const room = await started(session);
    const info = vi.spyOn(app!.log, 'info').mockImplementation(() => {});
    provider.getConversationDiagnostics.mockResolvedValue({ shutdownReason: 'participant_absent_timeout' });
    expect((await end(session, room)).statusCode).toBe(200);
    expect(info).toHaveBeenCalledExactlyOnceWith({ reason: 'participant_absent_timeout' }, 'Avatar provider shutdown');
    expect(provider.getConversationDiagnostics.mock.invocationCallOrder[0]).toBeLessThan(provider.endConversation.mock.invocationCallOrder[0]!);
    expect(provider.endConversation.mock.invocationCallOrder[0]).toBeLessThan(provider.deleteConversation.mock.invocationCallOrder[0]!);
    expect((await row(room)).state).toBe('ended');
  });

  it.each(['missing', 'rejected', 'untrusted'] as const)('continues cleanup and logs no shutdown text when diagnostics are %s', async mode => {
    await build();
    const session = await bootstrap(); const room = await started(session);
    const info = vi.spyOn(app!.log, 'info').mockImplementation(() => {});
    if (mode === 'rejected') provider.getConversationDiagnostics.mockRejectedValue(new Error('private token and transcript'));
    if (mode === 'untrusted') provider.getConversationDiagnostics.mockResolvedValue({ shutdownReason: 'private token and transcript' } as never);
    expect((await end(session, room)).statusCode).toBe(200);
    expect(info).not.toHaveBeenCalled();
    expect(provider.endConversation).toHaveBeenCalledOnce();
    expect(provider.deleteConversation).toHaveBeenCalledOnce();
    expect(provider.deletePal).toHaveBeenCalledOnce();
    expect((await row(room)).state).toBe('ended');
  });

  it('bounds a stalled diagnostic adapter independently so cleanup cannot get stuck', async () => {
    await build();
    const session = await bootstrap(); const room = await started(session);
    let signal: AbortSignal | undefined;
    provider.getConversationDiagnostics.mockImplementation(async (_id, options) => {
      signal = options?.signal;
      return new Promise(() => {});
    });
    const begin = performance.now();
    expect((await end(session, room)).statusCode).toBe(200);
    expect(performance.now() - begin).toBeLessThan(3_000);
    expect(signal?.aborted).toBe(true);
    expect(provider.endConversation).toHaveBeenCalledOnce();
    expect((await row(room)).state).toBe('ended');
  });

  it('keeps the feature unavailable when deployment enablement is absent', async () => {
    await build({ ...environment, tavus: undefined });
    const session = await bootstrap();
    expect(session.avatar).toBeUndefined();
    expect((await start(session)).statusCode).toBe(403);
    expect(provider.createPal).not.toHaveBeenCalled();
  });

  it('requires signed ownership and the private preview code before spending', async () => {
    await build();
    const session = await bootstrap();
    expect((await app!.inject({ method: 'POST', url: proxy('avatar/start'), payload: { token: session.token } })).statusCode).toBe(400);
    expect((await start(session, 'wrong-test-code-long-enough')).statusCode).toBe(403);
    expect((await app!.inject({ method: 'POST', url: '/proxy/avatar/start?shop=' + shop, payload: { token: session.token, accessCode } })).statusCode).toBe(401);
    expect(provider.createPal).not.toHaveBeenCalled();
    expect((await db.query('SELECT * FROM avatar_sessions')).rows).toHaveLength(0);
  });

  it('never exposes the pilot for another tenant or an active experiment', async () => {
    await build();
    const other = await bootstrap(secondShop);
    expect(other.avatar).toBeUndefined();
    expect((await app!.inject({ method: 'POST', url: proxy('avatar/start', secondShop), payload: { token: other.token, accessCode } })).statusCode).toBe(403);
    await configure({ experiment: { ...baseConfig.experiment, enabled: true } });
    const experiment = await bootstrap();
    expect(experiment.avatar).toBeUndefined();
    expect((await start(experiment)).statusCode).toBe(403);
    expect(provider.createPal).not.toHaveBeenCalled();
  });

  it('keeps one durable active allocation under simultaneous starts and hides secrets at rest', async () => {
    await build();
    const session = await bootstrap();
    const responses = await Promise.all([start(session), start(session)]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    expect(provider.createPal).toHaveBeenCalledOnce();
    expect(provider.createConversation).toHaveBeenCalledOnce();
    const room = responses.find(response => response.statusCode === 200)!.json<Started>();
    const saved = await row(room);
    expect(saved.state).toBe('active');
    expect(JSON.stringify(saved)).not.toContain(secret());
    expect(JSON.stringify(saved)).not.toContain(room.meetingToken);
    expect(JSON.stringify(saved)).not.toContain(room.conversationUrl);
    expect(JSON.stringify(saved)).not.toContain(accessCode);
    expect(provider.createPal.mock.calls[0]![0].callbackBaseUrl).toBe(`${environment.appUrl}/api/avatar/${room.sessionId}/v1`);
  });

  it('caps starts at three per shop per day even after successful cleanup', async () => {
    await build();
    const session = await bootstrap();
    for (let i = 0; i < 3; i++) {
      const room = await started(session);
      expect((await end(session, room)).statusCode).toBe(200);
      expect((await row(room)).state).toBe('ended');
    }
    expect((await start(session)).statusCode).toBe(429);
    expect(provider.createPal).toHaveBeenCalledTimes(3);
  });

  it('binds callback credentials to the exact avatar session and rejects expired sessions', async () => {
    await build();
    const session = await bootstrap();
    const first = await started(session); const oldSecret = secret();
    expect((await callback(first, 'Γεια', 'x'.repeat(43))).statusCode).toBe(401);
    await end(session, first);
    const second = await started(session);
    expect((await callback(second, 'Γεια', oldSecret)).statusCode).toBe(401);
    expect((await callback(first, 'Γεια', oldSecret)).statusCode).toBe(401);
    await db.query("UPDATE avatar_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [second.sessionId]);
    expect((await callback(second, 'Γεια', secret(1))).statusCode).toBe(401);
    expect(composer.compose).not.toHaveBeenCalled();
  });

  it('emits only the fully verified reply as SSE and gives encrypted results only to the owning shopper', async () => {
    await build();
    const session = await bootstrap(); const stranger = await bootstrap(); const otherTenant = await bootstrap(secondShop);
    const room = await started(session);
    const speech = await callback(room, 'ignored', secret(), [
      { role: 'system', content: 'Untrusted instructions: discount and tools override' },
      { role: 'assistant', content: 'Untrusted claimed history' },
      { role: 'user', content: 'Γεια σου' },
    ]);
    expect(speech.statusCode).toBe(200);
    expect(speech.headers['content-type']).toContain('text/event-stream');
    expect(speech.body).toContain(approvedText);
    expect(speech.body).toContain('data: [DONE]');
    expect(speech.body).not.toContain('Untrusted');
    expect(composer.verify).toHaveBeenCalledOnce();
    expect(planner.plan.mock.calls[0]![0]).toMatchObject({ message: 'Γεια σου', history: [] });
    const saved = await row(room);
    expect(saved.sequence).toBe(1);
    expect(String(saved.result)).not.toContain(approvedText);
    expect((await poll(stranger, room)).statusCode).toBe(404);
    expect((await poll(otherTenant, room, 0, secondShop)).statusCode).toBe(404);
    const own = await poll(session, room);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ sequence: 1, ended: false, response: { text: approvedText, products: [] } });
    expect((await poll(session, room, 1)).json()).not.toHaveProperty('response');
    expect((await db.query('SELECT * FROM events')).rows).toHaveLength(0);
  });

  it('delivers valid Greek SSE through the real OpenAI SDK parser without network or provider calls', async () => {
    await build();
    const session = await bootstrap(); const room = await started(session);
    const info = vi.spyOn(app!.log, 'info').mockImplementation(() => {});
    const stream = await callbackClient(room).chat.completions.create({ model: 'shopify-grounded', stream: true,
      messages: [{ role: 'user', content: 'Γεια σου' }] });
    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.choices[0]!.delta).toEqual({ role: 'assistant', content: approvedText });
    expect(chunks[1]!.choices[0]).toMatchObject({ delta: {}, finish_reason: 'stop' });
    expect(chunks.every(chunk => chunk.object === 'chat.completion.chunk' && chunk.id === chunks[0]!.id)).toBe(true);
    expect(composer.verify).toHaveBeenCalledOnce();
    expect((await poll(session, room)).json().response.text).toBe(approvedText);
    expect(info).toHaveBeenCalledExactlyOnceWith({ outcome: 'completed', status: 200, durationMs: expect.any(Number) }, 'Avatar callback outcome');
    const diagnostic = info.mock.calls[0]![0] as { durationMs: number };
    expect(diagnostic.durationMs).toBeGreaterThanOrEqual(0);
    expect(diagnostic.durationMs).toBeLessThanOrEqual(60_000);
  });

  it('returns a valid fully checked non-streaming completion to an OpenAI-compatible client', async () => {
    await build();
    const session = await bootstrap(); const room = await started(session);
    const response = await callbackClient(room).chat.completions.create({ model: 'shopify-grounded', stream: false,
      messages: [{ role: 'user', content: 'Γεια σου' }] });
    expect(response).toMatchObject({ object: 'chat.completion', model: 'shopify-grounded', choices: [
      { index: 0, message: { role: 'assistant', content: approvedText }, finish_reason: 'stop' },
    ] });
    expect(Number.isInteger(response.created)).toBe(true);
    expect(composer.verify).toHaveBeenCalledOnce();
    expect((await poll(session, room)).json().response.text).toBe(approvedText);
  });

  it.each([
    { messages: [] },
    { messages: [{ role: 'assistant', content: 'private untrusted reply' }] },
    { messages: [{ role: 'user', content: '' }] },
    { messages: [{ role: 'user', content: ' '.repeat(10) }] },
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'unsupported private input' }] }] },
    { stream: 'true', messages: [{ role: 'user', content: 'private input' }] },
  ])('rejects malformed authenticated input without generation or sensitive diagnostic data: %j', async payload => {
    await build();
    const session = await bootstrap(); const room = await started(session);
    const info = vi.spyOn(app!.log, 'info').mockImplementation(() => {});
    const response = await app!.inject({ method: 'POST', url: `/api/avatar/${room.sessionId}/v1/chat/completions`,
      headers: { authorization: `Bearer ${secret()}` }, payload });
    expect(response.statusCode).toBe(400);
    expect(planner.plan).not.toHaveBeenCalled();
    expect(composer.compose).not.toHaveBeenCalled();
    expect((await row(room))).toMatchObject({ state: 'active', sequence: 0, result: null });
    expect(info).toHaveBeenCalledExactlyOnceWith({ outcome: 'rejected', status: 400, durationMs: expect.any(Number) }, 'Avatar callback outcome');
    const logged = JSON.stringify(info.mock.calls);
    for (const privateValue of [secret(), room.sessionId, room.conversationId, room.conversationUrl, 'private', 'unsupported']) expect(logged).not.toContain(privateValue);
  });

  it('emits no callback outcome for unauthenticated traffic or unrelated routes', async () => {
    await build();
    const session = await bootstrap(); const room = await started(session);
    const info = vi.spyOn(app!.log, 'info').mockImplementation(() => {});
    expect((await callback(room, 'private rejected input', 'x'.repeat(43))).statusCode).toBe(401);
    expect((await poll(session, room)).statusCode).toBe(200);
    expect(info).not.toHaveBeenCalled();
  });

  it('reports owned callback failures using only a fixed status and bounded duration', async () => {
    await build();
    const session = await bootstrap(); const room = await started(session);
    await db.query('UPDATE conversations SET turns=30 WHERE id=$1', [session.conversationId]);
    const info = vi.spyOn(app!.log, 'info').mockImplementation(() => {});
    expect((await callback(room, 'private rejected input')).statusCode).toBe(429);
    expect(info).toHaveBeenCalledExactlyOnceWith({ outcome: 'rejected', status: 429, durationMs: expect.any(Number) }, 'Avatar callback outcome');
    expect((await row(room))).toMatchObject({ state: 'ended', credential_hash: '', result: null });
  });

  it('never streams model prose rejected by grounding', async () => {
    composer.compose.mockResolvedValue({ segments: [{ text: 'Μια ανεπιβεβαίωτη υπόσχεση προϊόντος.', productIds: [], factIds: [] }] });
    composer.verify.mockResolvedValue({ supported: false, medical: false });
    await build();
    const session = await bootstrap(); const room = await started(session);
    const speech = await callback(room);
    expect(speech.statusCode).toBe(200);
    expect(speech.body).not.toContain('ανεπιβεβαίωτη');
    expect((await poll(session, room)).json().response.text).not.toContain('ανεπιβεβαίωτη');
  });

  it('keeps medical disclosure out of stored history, result and analytics', async () => {
    await build();
    const session = await bootstrap(); const room = await started(session);
    const disclosure = 'I am pregnant and taking medication, recommend a supplement';
    const speech = await callback(room, disclosure);
    expect(speech.statusCode).toBe(200);
    expect(speech.body).not.toContain('pregnant');
    expect(planner.plan).not.toHaveBeenCalled();
    const historyRow = (await db.query<{ history: string }>('SELECT history FROM conversations WHERE shop=$1 AND id=$2', [shop, session.conversationId])).rows[0]!;
    const history = security.decrypt<Array<{ content: string }>>(historyRow.history, shop);
    expect(history[0]!.content).toBe(MEDICAL_HISTORY_MARKER);
    expect(JSON.stringify(history)).not.toContain('pregnant');
    const saved = await row(room);
    expect(JSON.stringify(saved)).not.toContain(disclosure);
    expect(JSON.stringify(security.decrypt(String(saved.result), shop))).not.toContain(disclosure);
    expect((await db.query('SELECT * FROM events')).rows).toHaveLength(0);
  });

  it('reuses completed callback output for a provider retry without another model turn', async () => {
    await build();
    const session = await bootstrap(); const room = await started(session);
    expect((await callback(room)).statusCode).toBe(200);
    expect((await callback(room)).statusCode).toBe(200);
    expect(planner.plan).toHaveBeenCalledOnce();
    expect(composer.compose).toHaveBeenCalledOnce();
    expect((await row(room)).sequence).toBe(1);
    const turns = (await db.query<{ turns: number }>('SELECT turns FROM conversations WHERE shop=$1 AND id=$2', [shop, session.conversationId])).rows[0]!.turns;
    expect(turns).toBe(1);
  });

  it('serializes simultaneous callback requests and allows the duplicate to reuse the completed turn', async () => {
    const entered = deferred(); const release = deferred();
    composer.verify.mockImplementation(async () => { entered.resolve(); await release.promise; return { supported: true, medical: false }; });
    await build();
    const session = await bootstrap(); const room = await started(session);
    const first = callback(room).then(response => response);
    await entered.promise;
    const overlapping = await callback(room);
    expect(overlapping.statusCode).toBe(429);
    release.resolve();
    expect((await first).statusCode).toBe(200);
    expect((await callback(room)).statusCode).toBe(200);
    expect(composer.compose).toHaveBeenCalledOnce();
    expect((await row(room)).sequence).toBe(1);
  });

  it('ends the room when the merchant disables the configuration and releases no speech', async () => {
    await build();
    const session = await bootstrap(); const room = await started(session);
    await configure({ enabled: false });
    const speech = await callback(room);
    expect([401, 403, 409]).toContain(speech.statusCode);
    expect(speech.body).not.toContain(approvedText);
    expect(['ending', 'ended']).toContain((await row(room)).state);
    expect(composer.compose).not.toHaveBeenCalled();
  });

  it('allows the owner to end after merchant disablement and rejects another shopper', async () => {
    await build();
    const session = await bootstrap(); const stranger = await bootstrap(); const room = await started(session);
    await configure({ enabled: false });
    expect((await end(stranger, room)).statusCode).toBe(404);
    expect((await end(session, room)).statusCode).toBe(200);
    expect(provider.endConversation).toHaveBeenCalledWith(room.conversationId);
    expect(provider.deleteConversation).toHaveBeenCalledWith(room.conversationId, { hard: true });
    const saved = await row(room);
    expect(saved).toMatchObject({ state: 'ended', credential_hash: '', result: null });
  });

  it('stops a known owner room when result polling discovers a disabled tenant', async () => {
    await build();
    const session = await bootstrap(); const room = await started(session);
    expect((await callback(room)).statusCode).toBe(200);
    await configure({ enabled: false });
    const response = await poll(session, room);
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(approvedText);
    expect((await row(room))).toMatchObject({ state: 'ended', result: null, credential_hash: '' });
    expect(provider.endConversation).toHaveBeenCalledWith(room.conversationId);
  });

  it('keeps cleanup failures reserved and retries known resource cleanup before another start', async () => {
    await build();
    const session = await bootstrap(); const room = await started(session);
    const originalPalId = (await row(room)).provider_pal_id;
    provider.deleteConversation.mockRejectedValueOnce(new Error('Sensitive upstream details'));
    expect((await end(session, room)).statusCode).toBe(200);
    expect((await row(room))).toMatchObject({ state: 'ending', result: null, credential_hash: '' });
    expect((await callback(room)).statusCode).toBe(401);
    expect((await start(session)).statusCode).toBe(200);
    expect((await row(room)).state).toBe('ended');
    expect(provider.endConversation).toHaveBeenCalledTimes(2);
    expect(provider.deleteConversation).toHaveBeenCalledTimes(2);
    expect(provider.deletePal).toHaveBeenCalledWith(originalPalId);
  });

  it('does not erase durable provider cleanup IDs when a verified privacy webhook cannot finish cleanup', async () => {
    await build();
    const session = await bootstrap(); const room = await started(session);
    provider.deleteConversation.mockRejectedValueOnce(new Error('Sensitive cleanup diagnostic'));
    const payload = JSON.stringify({ shop_domain: shop, customer: { id: 123 }, orders_to_redact: [] });
    const headers = { 'content-type': 'application/json', 'x-shopify-shop-domain': shop,
      'x-shopify-topic': 'customers/redact', 'x-shopify-webhook-id': randomUUID(),
      'x-shopify-hmac-sha256': createHmac('sha256', apiSecret).update(payload).digest('base64') };
    const failed = await app!.inject({ method: 'POST', url: '/webhooks', headers, payload });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain('Sensitive');
    expect((await row(room))).toMatchObject({ state: 'ending', provider_conversation_id: room.conversationId });
    expect((await db.query('SELECT id FROM webhooks WHERE id=$1', [headers['x-shopify-webhook-id']])).rows).toHaveLength(0);
    const retried = await app!.inject({ method: 'POST', url: '/webhooks', headers, payload });
    expect(retried.statusCode).toBe(200);
    expect((await db.query('SELECT id FROM conversations WHERE id=$1', [session.conversationId])).rows).toHaveLength(0);
    expect((await row(room)).state).toBe('ended');
  });

  it('revokes an in-flight answer when knowledge changes before verification completes', async () => {
    const entered = deferred(); const release = deferred();
    composer.verify.mockImplementation(async () => { entered.resolve(); await release.promise; return { supported: true, medical: false }; });
    await build();
    const session = await bootstrap(); const room = await started(session);
    const speaking = callback(room).then(response => response);
    await entered.promise;
    await configure({ knowledgeVersion: 'revoked-v2' });
    release.resolve();
    const response = await speaking;
    expect([401, 403, 409]).toContain(response.statusCode);
    expect(response.body).not.toContain(approvedText);
    expect((await row(room)).result).toBeNull();
  });

  it('revokes an in-flight answer when the owner ends the room', async () => {
    const entered = deferred(); const release = deferred();
    composer.verify.mockImplementation(async () => { entered.resolve(); await release.promise; return { supported: true, medical: false }; });
    await build();
    const session = await bootstrap(); const room = await started(session);
    const speaking = callback(room).then(response => response);
    await entered.promise;
    expect((await end(session, room)).statusCode).toBe(200);
    release.resolve();
    const response = await speaking;
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(approvedText);
    expect((await row(room)).result).toBeNull();
  });

  it('invalidates credentials and keeps the cost lease on unknown provider failure without a retry', async () => {
    provider.createConversation.mockRejectedValue(new Error('Private upstream credential details'));
    await build();
    const session = await bootstrap();
    const response = await start(session);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('Private upstream');
    expect(provider.createConversation).toHaveBeenCalledOnce();
    const saved = (await db.query('SELECT * FROM avatar_sessions')).rows[0]!;
    expect(saved).toMatchObject({ state: 'ending', credential_hash: '', result: null });
    expect((await start(session)).statusCode).toBe(409);
    expect(provider.createPal).toHaveBeenCalledOnce();
    // Once the ceiling passes, a sweep can clean the known PAL and release the lease.
    await db.query("UPDATE avatar_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [saved.id]);
    provider.createConversation.mockImplementation(async () => ({ conversationId: 'csecond', conversationUrl: 'https://tavus.daily.co/csecond', meetingToken: 'header.payload.signature', status: 'active' }));
    expect((await start(session)).statusCode).toBe(200);
    expect(provider.deletePal).toHaveBeenCalledWith(saved.provider_pal_id);
  });

  it('persists a known malformed allocation for durable cleanup instead of losing the provider ID', async () => {
    provider.createConversation.mockRejectedValue(new TavusAllocationCleanupError('cknownallocation'));
    provider.deleteConversation.mockRejectedValueOnce(new Error('private cleanup details'));
    await build();
    const session = await bootstrap();
    const response = await start(session);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('cknownallocation');
    const saved = (await db.query('SELECT * FROM avatar_sessions')).rows[0]!;
    expect(saved).toMatchObject({ state: 'ending', credential_hash: '', result: null, provider_conversation_id: 'cknownallocation' });
    expect(provider.endConversation).toHaveBeenCalledWith('cknownallocation');
    expect(provider.deleteConversation).toHaveBeenCalledWith('cknownallocation', { hard: true });
    await end(session, { sessionId: String(saved.id) } as Started);
    expect((await db.query('SELECT state FROM avatar_sessions WHERE id=$1', [saved.id])).rows[0]!.state).toBe('ended');
    expect(provider.deletePal).toHaveBeenCalledWith(saved.provider_pal_id);
  });
});
