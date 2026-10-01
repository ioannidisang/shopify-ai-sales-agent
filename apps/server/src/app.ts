import '@shopify/shopify-api/adapters/node';
import { shopifyApi, ApiVersion, LogSeverity } from '@shopify/shopify-api';
import Fastify, { type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { respond, MEDICAL_HISTORY_MARKER } from '../../../packages/core/src/index.js';
import type { Catalog, Planner, ShopConfig, ApprovedFact } from '../../../packages/core/src/types.js';
import { ShopifyCatalog } from '../../../packages/shopify/src/catalog.js';
import { OpenAIPlanner } from '../../../packages/core/src/openai-planner.js';
import { Security, constantEqual, shopDomain, type SessionClaims } from './security.js';
import { type Database, takeBudget, purgeExpired } from './database.js';
import { configSchema, factSchema, readTenantFiles, type readEnv } from './config.js';
import { registerInstallation, REQUIRED_SHOPIFY_SCOPES } from './installation.js';

declare module 'fastify' { interface FastifyRequest { rawBody?: string } }
type Environment = ReturnType<typeof readEnv>;
type Tenant = { config: ShopConfig; facts: ApprovedFact[]; credentials: string };
type History = { role: 'user' | 'assistant'; content: string }[];
type Services = { catalog?: (tenant: Tenant) => Catalog; planner?: Planner; verifyProxy?: (query: URLSearchParams) => Promise<boolean> };
const scopeList = [...REQUIRED_SHOPIFY_SCOPES];
const baseBody = z.object({ token: z.string().min(1).max(2048) });
const contextSchema = { country: z.string().regex(/^[A-Z]{2}$/), locale: z.enum(['el', 'en']) };
const eventNames = ['assistant_open', 'conversation_started', 'recommendation_shown', 'product_clicked', 'add_to_cart', 'cart_updated', 'experiment_exposure'] as const;
const eventSchema = z.object({ id: z.uuid(), name: z.enum(eventNames), productId: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/).optional(), variantId: z.string().regex(/^(gid:\/\/shopify\/ProductVariant\/)?\d+$/).optional(), quantity: z.number().int().min(0).max(99).optional() }).strict();
const pixelEvent = z.object({
  id: z.string().min(1).max(160), name: z.enum(['experiment_exposure', 'checkout_started', 'purchase']),
  clientId: z.string().min(1).max(160), assignment: z.enum(['assistant', 'control', 'untracked']).optional(),
  experimentId: z.string().max(80).optional(), conversationId: z.uuid().optional(),
  orderId: z.string().max(100).regex(/^(gid:\/\/shopify\/Order\/)?\d+$/).optional(),
}).strict();

class HttpError extends Error { constructor(public statusCode: number, message: string) { super(message); } }

export async function buildApp(env: Environment, db: Database, services: Services = {}) {
  const app = Fastify({ bodyLimit: 32768, requestTimeout: 35000, logger: { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] }, disableRequestLogging: true });
  await app.register(helmet);
  await app.register(rateLimit, { max: 240, timeWindow: 60000 });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try { req.rawBody = String(body); done(null, JSON.parse(String(body))); }
    catch { done(new HttpError(400, 'Invalid JSON')); }
  });
  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500;
    // Do not log exception text from vendors: it can contain prompts/credentials.
    if (status >= 500) app.log.error({ requestId: request.id, route: request.routeOptions.url, code: status }, 'Request failed');
    reply.code(status).send({ error: status >= 500 ? 'Service temporarily unavailable' : status === 429 ? 'Please wait before trying again' : status === 401 ? 'Session or signature invalid' : status === 403 ? 'Access unavailable' : 'Request could not be completed', requestId: request.id });
  });
  app.addHook('onSend', async (_req, reply) => { reply.header('Cache-Control', 'no-store'); });

  const ready = Boolean(env.apiKey && env.apiSecret && env.sessionSecret && env.encryptionKey && (services.planner || (env.openaiKey && env.openaiModel)));
  const security = env.sessionSecret && env.encryptionKey ? new Security(env.sessionSecret, env.encryptionKey) : null;
  const sdk = env.apiKey && env.apiSecret ? shopifyApi({ apiKey: env.apiKey, apiSecretKey: env.apiSecret, scopes: scopeList, hostName: new URL(env.appUrl).host, hostScheme: new URL(env.appUrl).protocol === 'https:' ? 'https' : 'http', apiVersion: ApiVersion.July26, isEmbeddedApp: false, logger: { level: LogSeverity.Error, log: () => {} } }) : null;
  const planner = services.planner ?? (env.openaiKey && env.openaiModel ? new OpenAIPlanner({ apiKey: env.openaiKey, model: env.openaiModel, timeoutMs: 12000 }) : null);

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    await db.query('SELECT 1');
    return reply.code(ready ? 200 : 503).send({ ready });
  });
  app.get('/', async (_req, reply) => reply.type('text/html').send(`<!doctype html><html lang="el"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Shopify AI Sales Agent</title><body style="font:18px system-ui;max-width:760px;margin:10vh auto;padding:24px;background:#111;color:#eee"><p style="color:#f4d538">NUTRI TIGER · AI SALES PLATFORM</p><h1>Shopify AI Sales Agent</h1><p>${ready ? 'Το backend είναι ρυθμισμένο. Η εγκατάσταση στο Shopify και η ενεργοποίηση στο draft theme ολοκληρώνουν τη σύνδεση.' : 'Το backend λειτουργεί. Εκκρεμούν τα Shopify app credentials, το OpenAI API και η σύνδεση του καταστήματος.'}</p><p>Text · Live product cards · Existing Shopify cart</p><p>Οι οδηγίες εγκατάστασης βρίσκονται στο repo, στο docs/INSTALLATION.md.</p></body></html>`));

  const requireSecurity = () => { if (!security || !ready || !planner) throw new HttpError(503, 'Not configured'); return security; };
  async function tenantFromProxy(req: FastifyRequest): Promise<Tenant> {
    requireSecurity();
    const params = new URL(req.url, env.appUrl).searchParams;
    let valid = false;
    try { valid = services.verifyProxy ? await services.verifyProxy(params) : await sdk!.utils.validateHmac(params, { signator: 'appProxy' }); } catch { /* reject */ }
    if (!valid) throw new HttpError(401, 'Invalid proxy');
    const shop = shopDomain.parse(params.get('shop'));
    if (!env.allowedShops.includes(shop)) throw new HttpError(403, 'Shop not permitted');
    const result = await db.query<{ config: unknown; facts: unknown; credentials: string }>('SELECT config,facts,credentials FROM shops WHERE shop=$1 AND active=true', [shop]);
    const row = result.rows[0];
    if (!row) throw new HttpError(403, 'Not installed');
    const config = configSchema.parse(row.config); const facts = z.array(factSchema).parse(row.facts);
    if (config.shop !== shop || facts.some(f => f.shop !== shop)) throw new HttpError(500, 'Tenant configuration invalid');
    if (!config.enabled) throw new HttpError(403, 'Disabled');
    return { config, facts, credentials: row.credentials };
  }
  function market(tenant: Tenant, country: string) { if (!tenant.config.allowedCountries.includes(country)) throw new HttpError(400, 'Unsupported market'); }
  async function session(req: FastifyRequest, token: string) {
    const tenant = await tenantFromProxy(req); let claims: SessionClaims;
    try { claims = security!.verify(token, tenant.config.shop); } catch { throw new HttpError(401, 'Invalid token'); }
    const result = await db.query<{ consent: boolean; assignment: string; experiment_id: string }>('SELECT consent,assignment,experiment_id FROM conversations WHERE shop=$1 AND id=$2 AND expires_at>now()', [claims.shop, claims.sid]);
    const row = result.rows[0];
    if (!row) throw new HttpError(401, 'Session expired');
    return { tenant, claims, row };
  }
  function catalog(tenant: Tenant): Catalog {
    if (services.catalog) return services.catalog(tenant);
    const credentials = security!.decrypt<{ storefrontToken: string }>(tenant.credentials, tenant.config.shop);
    return new ShopifyCatalog({ shop: tenant.config.shop, accessToken: credentials.storefrontToken, approvedImageUrls: tenant.config.approvedImageUrls });
  }

  app.post('/proxy/bootstrap', async (req) => {
    const body = z.object({ visitorId: z.uuid().optional(), analyticsConsent: z.boolean(), ...contextSchema }).strict().parse(req.body);
    const tenant = await tenantFromProxy(req); market(tenant, body.country);
    const shop = tenant.config.shop;
    const minute = new Date().toISOString().slice(0, 16);
    if (!await takeBudget(db, shop, `${minute}:bootstrap`, 300)) throw new HttpError(429, 'Bootstrap limit');
    const id = randomUUID(); const consent = body.analyticsConsent && Boolean(body.visitorId);
    const experiment = tenant.config.experiment;
    const assignment = !consent ? 'untracked' : experiment.enabled ? security!.assignment(shop, experiment.id, body.visitorId!, experiment.treatmentPercent) : 'assistant';
    const experimentId = experiment.enabled && consent ? experiment.id : 'off';
    const claims: SessionClaims = { shop, sid: id, exp: Math.floor(Date.now() / 1000) + 1800, assignment, experimentId, consent, country: body.country, locale: body.locale };
    const visitorHash = consent ? security!.hashClient(shop, `visitor:${body.visitorId!}`) : null;
    await db.query('INSERT INTO conversations(shop,id,history,expires_at,consent,assignment,experiment_id,visitor_hash) VALUES($1,$2,$3,to_timestamp($4),$5,$6,$7,$8)', [shop, id, security!.encrypt([], shop), claims.exp, consent, assignment, experimentId, visitorHash]);
    return { token: security!.sign(claims), conversationId: id, assignment, experimentId, brand: tenant.config.brand, enabled: true, knowledgeVersion: tenant.config.knowledgeVersion };
  });
  app.post('/proxy/chat', async (req) => {
    const body = baseBody.extend({ message: z.string().trim().min(1).max(2000), ...contextSchema }).strict().parse(req.body);
    const { tenant, claims } = await session(req, body.token);
    if (claims.assignment === 'control') throw new HttpError(403, 'Control arm');
    if (body.country !== claims.country || body.locale !== claims.locale) throw new HttpError(400, 'Market changed, start a new session');
    market(tenant, body.country);
    const lock = await db.query<{ history: string }>('UPDATE conversations SET busy_until=now()+interval \'45 seconds\', turns=turns+1 WHERE shop=$1 AND id=$2 AND expires_at>now() AND turns<30 AND (busy_until IS NULL OR busy_until<now()) RETURNING history', [claims.shop, claims.sid]);
    if (!lock.rows.length) throw new HttpError(429, 'Conversation busy or limit reached');
    try {
      const day = new Date().toISOString().slice(0, 10);
      if (!await takeBudget(db, claims.shop, `${day}:model`, 2000)) throw new HttpError(429, 'Daily limit');
      // Read the history held by the acquired turn lock; an earlier pre-lock read can be stale.
      const history = security!.decrypt<History>(lock.rows[0]!.history, claims.shop);
      const response = await respond({ shop: tenant.config, facts: tenant.facts, catalog: catalog(tenant), planner: planner!, message: body.message, history, country: body.country, locale: body.locale });
      // Keep the safety boundary for follow-ups without retaining a shopper's health disclosure.
      // Raw context is encrypted, expires after 30 minutes and never enters analytics or logs.
      const nextHistory = [...history, { role: 'user' as const, content: response.policy === 'medical' ? MEDICAL_HISTORY_MARKER : body.message }, { role: 'assistant' as const, content: response.text }].slice(-10);
      await db.query('UPDATE conversations SET history=$3 WHERE shop=$1 AND id=$2', [claims.shop, claims.sid, security!.encrypt(nextHistory, claims.shop)]);
      const { policy: _internalPolicy, ...publicResponse } = response;
      return publicResponse;
    } finally { await db.query('UPDATE conversations SET busy_until=NULL WHERE shop=$1 AND id=$2', [claims.shop, claims.sid]); }
  });
  app.post('/proxy/variants/verify', async (req) => {
    const body = baseBody.extend({ variantId: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/), ...contextSchema }).strict().parse(req.body);
    const { tenant, claims } = await session(req, body.token);
    if (claims.assignment === 'control') throw new HttpError(403, 'Control arm');
    if (body.country !== claims.country || body.locale !== claims.locale) throw new HttpError(400, 'Market mismatch');
    market(tenant, body.country);
    const result = await catalog(tenant).getVariant(body.variantId, { country: body.country, locale: body.locale });
    if (!result) throw new HttpError(404, 'Variant unavailable');
    return { variant: result.variant, requiresSellingPlan: Boolean(result.product.requiresSellingPlan) };
  });
  app.post('/proxy/events', async (req, reply) => {
    const body = baseBody.extend({ events: z.array(eventSchema).min(1).max(20) }).strict().parse(req.body);
    const { claims, row } = await session(req, body.token);
    if (!claims.consent || !row.consent) return reply.code(204).send();
    for (const event of body.events) {
      const { id, name, ...metadata } = event;
      if (claims.assignment === 'control' && name !== 'experiment_exposure') continue;
      await db.query('INSERT INTO events(shop,id,name,source,conversation_id,experiment_id,assignment,metadata) SELECT $1,$2,$3,$4,$5,$6,$7,$8 FROM conversations WHERE shop=$1 AND id=$5 AND consent=true AND expires_at>now() ON CONFLICT DO NOTHING', [claims.shop, id, name, 'widget', claims.sid, claims.experimentId, claims.assignment, JSON.stringify(metadata)]);
    }
    return reply.code(204).send();
  });
  app.post('/proxy/consent', async (req, reply) => {
    const body = baseBody.extend({ analyticsConsent: z.literal(false) }).strict().parse(req.body);
    const tenant = await tenantFromProxy(req); let claims: SessionClaims;
    // Revocation only: an expired session can still erase its 24-hour checkout mapping after
    // the 30-minute conversation has been purged. This grace never applies to commerce/events.
    try { claims = security!.verify(body.token, tenant.config.shop, Date.now(), 86_400_000); }
    catch { throw new HttpError(401, 'Invalid revocation token'); }
    // The same browser may have mappings from earlier sessions/experiments. Revoke all known
    // sessions for that pixel identity so an old tab cannot restore tracking after withdrawal.
    await db.query(`WITH affected AS (
      SELECT client_hash FROM pixel_assignments WHERE shop=$1 AND conversation_id=$2
    ), visitor AS (
      SELECT visitor_hash FROM conversations WHERE shop=$1 AND id=$2 AND visitor_hash IS NOT NULL
    ), revoked AS (
      UPDATE conversations SET consent=false WHERE shop=$1 AND (id=$2 OR visitor_hash IN (SELECT visitor_hash FROM visitor) OR id IN (
        SELECT conversation_id FROM pixel_assignments WHERE shop=$1 AND client_hash IN (SELECT client_hash FROM affected)
      )) RETURNING id
    ) DELETE FROM pixel_assignments WHERE shop=$1 AND (conversation_id=$2 OR conversation_id IN (SELECT id FROM revoked) OR client_hash IN (SELECT client_hash FROM affected))`, [claims.shop, claims.sid]);
    return reply.code(204).send();
  });

  app.options('/api/pixel/events', async (_req, reply) => reply.header('Access-Control-Allow-Origin', '*').header('Access-Control-Allow-Methods', 'POST,OPTIONS').header('Access-Control-Allow-Headers', 'Content-Type').code(204).send());
  app.post('/api/pixel/events', { config: { rateLimit: { max: 600, timeWindow: 60000 } } }, async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    const s = requireSecurity();
    const body = z.object({ shop: shopDomain, ingestKey: z.string().max(128), event: pixelEvent }).strict().parse(req.body);
    if (!env.allowedShops.includes(body.shop) || !constantEqual(body.ingestKey, s.pixelKey(body.shop))) throw new HttpError(401, 'Bad collector key');
    const installed = await db.query("SELECT shop FROM shops WHERE shop=$1 AND active=true AND config->>'enabled'='true'", [body.shop]);
    if (!installed.rows.length) throw new HttpError(403, 'Not installed');
    const minute = new Date().toISOString().slice(0, 16);
    if (!await takeBudget(db, body.shop, `${minute}:pixel`, 3000)) throw new HttpError(429, 'Collector limit');
    if (!await takeBudget(db, body.shop, `${minute.slice(0, 10)}:analytics`, 50000)) throw new HttpError(429, 'Daily collector limit');
    const event = body.event; const hash = s.hashClient(body.shop, event.clientId);
    if (event.name === 'experiment_exposure') {
      if (!event.conversationId || !event.experimentId || event.assignment === 'untracked') return reply.code(204).send();
      const conversation = await db.query<{ assignment: string; experiment_id: string }>('SELECT assignment,experiment_id FROM conversations WHERE shop=$1 AND id=$2 AND consent=true AND expires_at>now()', [body.shop, event.conversationId]);
      const row = conversation.rows[0];
      if (!row || row.assignment !== event.assignment || row.experiment_id !== event.experimentId) return reply.code(204).send();
      await db.query(`INSERT INTO pixel_assignments(shop,client_hash,experiment_id,assignment,conversation_id,expires_at)
        SELECT $1,$2,$3,$4,$5,now()+interval '1 day' FROM conversations WHERE shop=$1 AND id=$5 AND consent=true AND expires_at>now()
        ON CONFLICT(shop,client_hash,experiment_id) DO UPDATE SET assignment=$4,conversation_id=$5,expires_at=now()+interval '1 day'`, [body.shop, hash, row.experiment_id, row.assignment, event.conversationId]);
      return reply.code(204).send();
    }
    const mapping = await db.query<{ assignment: string; experiment_id: string; conversation_id: string }>('SELECT assignment,experiment_id,conversation_id FROM pixel_assignments WHERE shop=$1 AND client_hash=$2 AND expires_at>now() ORDER BY expires_at DESC LIMIT 1', [body.shop, hash]);
    const assignment = mapping.rows[0];
    if (!assignment) return reply.code(204).send();
    const orderId = event.orderId?.replace('gid://shopify/Order/', '');
    const id = event.name === 'purchase' && orderId ? `purchase:${s.hashClient(body.shop, `order:${orderId}`)}` : `pixel:${s.hashClient(body.shop, `event:${event.id}`)}`;
    await db.query(`INSERT INTO events(shop,id,name,source,conversation_id,client_hash,experiment_id,assignment,metadata)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9 WHERE EXISTS(
        SELECT 1 FROM pixel_assignments WHERE shop=$1 AND client_hash=$6 AND conversation_id=$5 AND expires_at>now()
      ) ON CONFLICT DO NOTHING`, [body.shop, id, event.name, 'pixel', assignment.conversation_id, hash, assignment.experiment_id, assignment.assignment, '{}']);
    return reply.code(204).send();
  });

  app.post('/webhooks', async (req, reply) => {
    if (!env.apiSecret || !req.rawBody) throw new HttpError(401, 'Webhook unavailable');
    const signature = req.headers['x-shopify-hmac-sha256'];
    const expected = createHmac('sha256', env.apiSecret).update(req.rawBody).digest('base64');
    if (typeof signature !== 'string' || !constantEqual(signature, expected)) throw new HttpError(401, 'Webhook HMAC');
    const shop = shopDomain.parse(req.headers['x-shopify-shop-domain']);
    const id = z.string().min(1).max(160).parse(req.headers['x-shopify-webhook-id']);
    const topic = req.headers['x-shopify-topic'];
    const previous = await db.query('SELECT id FROM webhooks WHERE shop=$1 AND id=$2', [shop, id]);
    if (previous.rows.length) return reply.code(200).send();
    if (topic === 'app/uninstalled') {
      await db.query("UPDATE shops SET active=false,credentials='' WHERE shop=$1", [shop]);
      await db.query('DELETE FROM conversations WHERE shop=$1', [shop]);
      await db.query('DELETE FROM pixel_assignments WHERE shop=$1', [shop]);
    } else if (topic === 'shop/redact') {
      await db.query('DELETE FROM shops WHERE shop=$1', [shop]);
    } else if (topic === 'customers/redact') {
      // No customer-account identity is attached to conversations. Conservatively remove all
      // short-lived context and attribution for this shop, including volunteered identifiers.
      await db.query('DELETE FROM conversations WHERE shop=$1', [shop]);
      await db.query('DELETE FROM pixel_assignments WHERE shop=$1', [shop]);
      await db.query('DELETE FROM events WHERE shop=$1', [shop]);
    } else if (topic !== 'customers/data_request' && topic !== 'customers/redact') {
      throw new HttpError(400, 'Unsupported topic');
    }
    // Events carry only pseudonymous hashes; shopper messages remain short-lived context.
    await db.query('INSERT INTO webhooks(shop,id) VALUES($1,$2) ON CONFLICT DO NOTHING', [shop, id]);
    return reply.code(200).send();
  });

  if (sdk && security) registerInstallation(app, {
    apiKey: env.apiKey!, apiSecret: env.apiSecret!, appUrl: env.appUrl, scopes: scopeList, allowedShops: env.allowedShops,
    pixelIngestKey: shop => security.pixelKey(shop),
    saveInstallation: async data => {
      const { config, facts } = await readTenantFiles(data.shop);
      await db.query(`INSERT INTO shops(shop,config,credentials,facts) VALUES($1,$2,$3,$4) ON CONFLICT(shop) DO UPDATE SET config=$2,credentials=$3,facts=$4,active=true,installed_at=now()`, [data.shop, JSON.stringify(config), security.encrypt(data, data.shop), JSON.stringify(facts)]);
    },
  });
  const timer = setInterval(() => { void purgeExpired(db).catch(() => app.log.error('Retention cleanup failed')); }, 60000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); });
  return app;
}
