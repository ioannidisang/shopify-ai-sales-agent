import '@shopify/shopify-api/adapters/node';
import { shopifyApi, ApiVersion, LogSeverity } from '@shopify/shopify-api';
import Fastify, { type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { respond, MEDICAL_HISTORY_MARKER } from '../../../packages/core/src/index.js';
import type { Catalog, Planner, ShopConfig, ApprovedFact, HistoryMessage } from '../../../packages/core/src/types.js';
import type { ConversationModel, ModelUsage } from '../../../packages/core/src/conversation.js';
import { ShopifyCatalog } from '../../../packages/shopify/src/catalog.js';
import { OpenAIPlanner } from '../../../packages/core/src/openai-planner.js';
import { MistralPlanner } from '../../../packages/core/src/mistral-planner.js';
import { MODEL_PROTOCOL_VERSION } from '../../../packages/core/src/model-protocol.js';
import { Security, constantEqual, configurationFingerprint, assignmentSchema, shopDomain, type SessionClaims, type Provider } from './security.js';
import { type Database, takeBudget, purgeExpired } from './database.js';
import { configSchema, factSchema, readTenantFiles, type readEnv } from './config.js';
import { registerInstallation, REQUIRED_SHOPIFY_SCOPES } from './installation.js';
import { registerAvatarRoutes, avatarAvailable } from './tavus-routes.js';
import type { TavusProvider } from './tavus-client.js';

declare module 'fastify' { interface FastifyRequest { rawBody?: string } }
type Environment = ReturnType<typeof readEnv>;
type Tenant = { config: ShopConfig; facts: ApprovedFact[]; credentials: string };
type History = HistoryMessage[];
type Services = { tavus?: TavusProvider; catalog?: (tenant: Tenant) => Catalog; planner?: Planner; composer?: ConversationModel; planners?: Partial<Record<Provider, Planner>>; composers?: Partial<Record<Provider, ConversationModel>>; modelFactory?: (provider: Provider, onUsage: (usage: ModelUsage) => void) => { planner: Planner; composer?: ConversationModel }; verifyProxy?: (query: URLSearchParams) => Promise<boolean> };
const scopeList = [...REQUIRED_SHOPIFY_SCOPES];
const baseBody = z.object({ token: z.string().min(1).max(2048) });
const contextSchema = { country: z.string().regex(/^[A-Z]{2}$/), locale: z.enum(['el', 'en']) };
const eventNames = ['assistant_open', 'conversation_started', 'recommendation_shown', 'product_clicked', 'add_to_cart', 'cart_updated', 'experiment_exposure'] as const;
const eventSchema = z.object({ id: z.uuid(), name: z.enum(eventNames), productId: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/).optional(), variantId: z.string().regex(/^(gid:\/\/shopify\/ProductVariant\/)?\d+$/).optional(), quantity: z.number().int().min(0).max(99).optional() }).strict();
const pixelEvent = z.object({
  id: z.string().min(1).max(160), name: z.enum(['experiment_exposure', 'checkout_started', 'purchase']),
  clientId: z.string().min(1).max(160), assignment: assignmentSchema.optional(),
  experimentId: z.string().max(80).optional(), conversationId: z.uuid().optional(),
  orderId: z.string().max(100).regex(/^(gid:\/\/shopify\/Order\/)?\d+$/).optional(),
  totalAmount: z.string().regex(/^\d{1,9}(?:\.\d{1,4})?$/).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(),
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

  const configuredProvider = (provider: Provider) => Boolean(services.modelFactory || services.planners?.[provider] || services.planner || (provider === 'openai' ? env.openaiKey && env.openaiModel : env.mistralKey && env.mistralModel));
  const ready = Boolean(env.apiKey && env.apiSecret && env.sessionSecret && env.encryptionKey && (configuredProvider('openai') || configuredProvider('mistral')));
  const tenantProvidersReady = (config: ShopConfig) => [config.defaultProvider ?? 'openai', ...(config.experiment.enabled ? config.experiment.arms?.filter(arm => arm.id !== 'control').map(arm => arm.id) ?? [] : [])].every(provider => configuredProvider(provider as Provider));
  const security = env.sessionSecret && env.encryptionKey ? new Security(env.sessionSecret, env.encryptionKey) : null;
  const sdk = env.apiKey && env.apiSecret ? shopifyApi({ apiKey: env.apiKey, apiSecretKey: env.apiSecret, scopes: scopeList, hostName: new URL(env.appUrl).host, hostScheme: new URL(env.appUrl).protocol === 'https:' ? 'https' : 'http', apiVersion: ApiVersion.July26, isEmbeddedApp: false, logger: { level: LogSeverity.Error, log: () => {} } }) : null;
  function providerModel(provider: Provider, onUsage: (usage: ModelUsage) => void, signal: AbortSignal): { planner: Planner; composer?: ConversationModel } {
    if (services.modelFactory) return services.modelFactory(provider, onUsage);
    const injected = services.planners?.[provider] ?? services.planner;
    if (injected) return { planner: injected, composer: services.composers?.[provider] ?? services.composer };
    if (!configuredProvider(provider)) throw new HttpError(503, 'Assigned provider unavailable');
    const options = { apiKey: (provider === 'openai' ? env.openaiKey : env.mistralKey)!, model: (provider === 'openai' ? env.openaiModel : env.mistralModel)!, timeoutMs: 6000, onUsage, signal };
    const model = provider === 'openai' ? new OpenAIPlanner(options) : new MistralPlanner(options);
    return { planner: model, composer: model };
  }
  function experimentSpecification(tenant: Tenant) {
    const { enabled: _enabled, ...config } = tenant.config;
    const arms = config.experiment.arms ? [...config.experiment.arms].sort((a, b) => a.id.localeCompare(b.id)) : undefined;
    return { config: { ...config, experiment: { ...config.experiment, arms } }, protocolVersion: MODEL_PROTOCOL_VERSION, knowledgeDigest: configurationFingerprint([...tenant.facts].sort((a, b) => a.id.localeCompare(b.id))), models: { openai: env.openaiModel ?? 'injected', mistral: env.mistralModel ?? 'injected' } };
  }
  function fingerprint(tenant: Tenant) { return configurationFingerprint(experimentSpecification(tenant)); }
  async function preserveExperiment(tenant: Tenant, digest: string) {
    await db.query('INSERT INTO experiment_specs(shop,experiment_id,config_fingerprint,specification) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [tenant.config.shop, tenant.config.experiment.id, digest, JSON.stringify(experimentSpecification(tenant))]);
    const saved = await db.query<{ config_fingerprint: string }>('SELECT config_fingerprint FROM experiment_specs WHERE shop=$1 AND experiment_id=$2', [tenant.config.shop, tenant.config.experiment.id]);
    if (saved.rows[0]?.config_fingerprint !== digest) throw new HttpError(409, 'Experiment changed; use a new experiment ID');
  }

  // Provider probes must not inherit a traffic burst's rate-limit bucket.
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));
  app.get('/readyz', { config: { rateLimit: false } }, async (_req, reply) => {
    await db.query('SELECT 1');
    const installed = await db.query<{ config: unknown }>("SELECT config FROM shops WHERE active=true AND config->>'enabled'='true'");
    const providerReady = ready && installed.rows.every(row => { const parsed = configSchema.safeParse(row.config); return parsed.success && tenantProvidersReady(parsed.data); });
    return reply.code(providerReady ? 200 : 503).send({ ready: providerReady });
  });
  app.get('/', async (req, reply) => {
    const launchShops = new URL(req.url, env.appUrl).searchParams.getAll('shop');
    if (launchShops.length) {
      if (launchShops.length !== 1) throw new HttpError(400, 'Ambiguous launch shop');
      const shop = shopDomain.parse(launchShops[0]);
      if (!env.allowedShops.includes(shop)) throw new HttpError(403, 'Shop not permitted');
      if (!sdk || !security) throw new HttpError(503, 'Installation not configured');
      // Shopify opens application_url for installation. Start the existing OAuth flow,
      // forwarding only the allowlisted shop; the callback authenticates before writes.
      return reply.redirect(`/auth?shop=${encodeURIComponent(shop)}`);
    }
    return reply.type('text/html').send(`<!doctype html><html lang="el"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Shopify AI Sales Agent</title><body style="font:18px system-ui;max-width:760px;margin:10vh auto;padding:24px;background:#111;color:#eee"><p style="color:#f4d538">SHOPIFY AI SALES PLATFORM</p><h1>Shopify AI Sales Agent</h1><p>${ready ? 'Το backend είναι ρυθμισμένο. Η εγκατάσταση στο Shopify και η ενεργοποίηση στο draft theme ολοκληρώνουν τη σύνδεση.' : 'Το backend λειτουργεί. Εκκρεμούν τα Shopify app credentials, το OpenAI API και η σύνδεση του καταστήματος.'}</p><p>Text · Live product cards · Existing Shopify cart</p><p>Οι οδηγίες εγκατάστασης βρίσκονται στο repo, στο docs/INSTALLATION.md.</p></body></html>`);
  });

  const requireSecurity = () => { if (!security || !sdk) throw new HttpError(503, 'Not configured'); return security; };
  async function proxyShop(req: FastifyRequest): Promise<string> {
    requireSecurity();
    const params = new URL(req.url, env.appUrl).searchParams;
    let valid = false;
    try { valid = services.verifyProxy ? await services.verifyProxy(params) : await sdk!.utils.validateHmac(params, { signator: 'appProxy' }); } catch { /* reject */ }
    if (!valid) throw new HttpError(401, 'Invalid proxy');
    const shop = shopDomain.parse(params.get('shop'));
    if (!env.allowedShops.includes(shop)) throw new HttpError(403, 'Shop not permitted');
    return shop;
  }
  async function tenantFromProxy(req: FastifyRequest): Promise<Tenant> {
    return tenantForShop(await proxyShop(req));
  }
  async function tenantForShop(shop: string): Promise<Tenant> {
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
    return validatedSession(tenant, claims);
  }
  async function validatedSession(tenant: Tenant, claims: SessionClaims) {
    if (claims.shop !== tenant.config.shop || claims.exp <= Date.now() / 1000) throw new HttpError(401, 'Session expired');
    const result = await db.query<{ consent: boolean; assignment: string; experiment_id: string; config_fingerprint: string; provider: Provider | null }>('SELECT consent,assignment,experiment_id,config_fingerprint,provider FROM conversations WHERE shop=$1 AND id=$2 AND expires_at>now()', [claims.shop, claims.sid]);
    const row = result.rows[0];
    if (!row) throw new HttpError(401, 'Session expired');
    if (claims.configFingerprint !== fingerprint(tenant) || row.config_fingerprint !== claims.configFingerprint || row.assignment !== claims.assignment || row.experiment_id !== claims.experimentId || row.provider !== (claims.provider ?? null)) throw new HttpError(401, 'Experiment configuration changed');
    return { tenant, claims, row };
  }
  function catalog(tenant: Tenant): Catalog {
    if (services.catalog) return services.catalog(tenant);
    const credentials = security!.decrypt<{ storefrontToken: string }>(tenant.credentials, tenant.config.shop);
    return new ShopifyCatalog({ shop: tenant.config.shop, accessToken: credentials.storefrontToken, approvedImageUrls: tenant.config.approvedImageUrls,
      previewCatalog: tenant.config.previewCatalog, experimentEnabled: tenant.config.experiment.enabled });
  }
  async function eraseLateAnalytics(shop: string, conversationId: string): Promise<void> {
    // Use a fresh statement snapshot after an analytics write. If revocation committed
    // during its earlier INSERT snapshot, remove the late write before returning.
    await db.query(`WITH removed_events AS (
      DELETE FROM events WHERE shop=$1 AND conversation_id=$2 AND NOT EXISTS(
        SELECT 1 FROM conversations WHERE shop=$1 AND id=$2 AND consent=true
      )
    ) DELETE FROM pixel_assignments WHERE shop=$1 AND conversation_id=$2 AND NOT EXISTS(
      SELECT 1 FROM conversations WHERE shop=$1 AND id=$2 AND consent=true
    )`, [shop, conversationId]);
  }

  app.post('/proxy/bootstrap', async (req) => {
    const body = z.object({ visitorId: z.uuid().optional(), analyticsConsent: z.boolean(), ...contextSchema }).strict().parse(req.body);
    const tenant = await tenantFromProxy(req); market(tenant, body.country);
    if (!tenantProvidersReady(tenant.config)) throw new HttpError(503, 'Experiment providers not configured');
    const shop = tenant.config.shop;
    const minute = new Date().toISOString().slice(0, 16);
    if (!await takeBudget(db, shop, `${minute}:bootstrap`, 300)) throw new HttpError(429, 'Bootstrap limit');
    const id = randomUUID(); const consent = body.analyticsConsent && Boolean(body.visitorId);
    const experiment = tenant.config.experiment;
    const digest = fingerprint(tenant);
    if (experiment.enabled && consent) await preserveExperiment(tenant, digest);
    const assignment = !consent ? 'untracked' : experiment.enabled ? (experiment.arms ? security!.weightedAssignment(shop, `${experiment.id}:${digest}`, body.visitorId!, experiment.arms) : security!.assignment(shop, `${experiment.id}:${digest}`, body.visitorId!, experiment.treatmentPercent ?? 50)) : 'assistant';
    const experimentId = experiment.enabled && consent ? experiment.id : 'off';
    const provider = assignment === 'control' ? undefined : assignment === 'openai' || assignment === 'mistral' ? assignment : tenant.config.defaultProvider ?? 'openai';
    const visitorHash = consent ? security!.hashClient(shop, `visitor:${body.visitorId!}`) : null;
    const claims: SessionClaims = { shop, sid: id, exp: Math.floor(Date.now() / 1000) + 1800, assignment, experimentId, consent, country: body.country, locale: body.locale, provider, configFingerprint: digest, ...(visitorHash ? { visitorHash } : {}) };
    await db.query('INSERT INTO conversations(shop,id,history,expires_at,consent,assignment,experiment_id,visitor_hash,config_fingerprint,provider) VALUES($1,$2,$3,to_timestamp($4),$5,$6,$7,$8,$9,$10)', [shop, id, security!.encrypt([], shop), claims.exp, consent, assignment, experimentId, visitorHash, digest, provider ?? null]);
    if (experiment.enabled && visitorHash) await db.query('INSERT INTO eligible_exposures(shop,experiment_id,visitor_hash,assignment,config_fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [shop, experimentId, visitorHash, assignment, digest]);
    return { token: security!.sign(claims), conversationId: id, assignment, experimentId, brand: tenant.config.brand, enabled: true, knowledgeVersion: tenant.config.knowledgeVersion,
      ...(avatarAvailable(env, tenant.config) ? { avatar: { provider: 'tavus', previewOnly: true, maxDurationSeconds: 180 } } : {}) };
  });
  app.post('/proxy/chat', async (req) => {
    const body = baseBody.extend({ message: z.string().trim().min(1).max(2000), ...contextSchema }).strict().parse(req.body);
    const { tenant, claims, row } = await session(req, body.token);
    if (claims.assignment === 'control') throw new HttpError(403, 'Control arm');
    if (body.country !== claims.country || body.locale !== claims.locale) throw new HttpError(400, 'Market changed, start a new session');
    return groundedTurn({ tenant, claims, row }, body.message);
  });
  async function groundedTurn({ tenant, claims, row }: Awaited<ReturnType<typeof session>>, message: string) {
    const body = { message, country: claims.country, locale: claims.locale };
    if (claims.assignment === 'control') throw new HttpError(403, 'Control arm');
    market(tenant, body.country);
    const usage: ModelUsage[] = [];
    const turnSignal = AbortSignal.timeout(25000);
    const model = providerModel(claims.provider!, item => usage.push(item), turnSignal);
    const lock = await db.query<{ history: string }>('UPDATE conversations SET busy_until=now()+interval \'45 seconds\', turns=turns+1 WHERE shop=$1 AND id=$2 AND expires_at>now() AND turns<30 AND (busy_until IS NULL OR busy_until<now()) RETURNING history', [claims.shop, claims.sid]);
    if (!lock.rows.length) throw new HttpError(429, 'Conversation busy or limit reached');
    try {
      const day = new Date().toISOString().slice(0, 10);
      if (!await takeBudget(db, claims.shop, `${day}:model`, 2000)) throw new HttpError(429, 'Daily limit');
      // Read the history held by the acquired turn lock; an earlier pre-lock read can be stale.
      const history = security!.decrypt<History>(lock.rows[0]!.history, claims.shop);
      const response = await respond({ shop: tenant.config, facts: tenant.facts, catalog: catalog(tenant), ...model, message: body.message, history, country: body.country, locale: body.locale, signal: turnSignal });
      // Merchant revocation/config changes during generation must not release the older evidence.
      const latest = await db.query<{ config: unknown; facts: unknown }>('SELECT config,facts FROM shops WHERE shop=$1 AND active=true', [claims.shop]);
      const current = latest.rows[0];
      if (!current) throw new HttpError(403, 'Shop no longer active');
      const currentConfig = configSchema.parse(current.config);
      if (!currentConfig.enabled || fingerprint({ ...tenant, config: currentConfig, facts: z.array(factSchema).parse(current.facts) }) !== claims.configFingerprint) throw new HttpError(409, 'Knowledge changed during generation');
      // Keep the safety boundary for follow-ups without retaining a shopper's health disclosure.
      // Raw context is encrypted, expires after 30 minutes and never enters analytics or logs.
      const nextHistory = [...history, { role: 'user' as const, content: response.policy === 'medical' ? MEDICAL_HISTORY_MARKER : body.message }, { role: 'assistant' as const, content: response.text, context: { productIds: response.products.map(product => product.id), factIds: response.facts.map(fact => fact.id) } }].slice(-10);
      await db.query('UPDATE conversations SET history=$3 WHERE shop=$1 AND id=$2', [claims.shop, claims.sid, security!.encrypt(nextHistory, claims.shop)]);
      const { policy: _internalPolicy, ...publicResponse } = response;
      return publicResponse;
    } finally {
      await db.query('UPDATE conversations SET busy_until=NULL WHERE shop=$1 AND id=$2', [claims.shop, claims.sid]);
      // Operational totals never contain a visitor/session ID or customer text, even with consent.
      for (const item of usage) await db.query(`INSERT INTO model_usage(shop,day,experiment_id,assignment,provider,model,knowledge_version,config_fingerprint,operation,requests,successful_requests,input_tokens,output_tokens,unknown_token_requests,duration_ms)
        VALUES($1,current_date,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12,$13)
        ON CONFLICT(shop,day,experiment_id,assignment,provider,model,knowledge_version,config_fingerprint,operation) DO UPDATE SET
        requests=model_usage.requests+1,successful_requests=model_usage.successful_requests+EXCLUDED.successful_requests,input_tokens=model_usage.input_tokens+EXCLUDED.input_tokens,output_tokens=model_usage.output_tokens+EXCLUDED.output_tokens,unknown_token_requests=model_usage.unknown_token_requests+EXCLUDED.unknown_token_requests,duration_ms=model_usage.duration_ms+EXCLUDED.duration_ms`, [claims.shop, row.consent ? claims.experimentId : 'off', row.consent ? claims.assignment : 'untracked', item.provider, item.model, tenant.config.knowledgeVersion, claims.configFingerprint, item.operation, item.success ? 1 : 0, item.inputTokens ?? 0, item.outputTokens ?? 0, item.inputTokens === null || item.outputTokens === null ? 1 : 0, Math.round(item.durationMs)]);
    }
  }
  const avatars = security ? registerAvatarRoutes(app, env, db, security, {
    authenticate: session,
    authenticateEnd: async (req, token) => {
      const shop = await proxyShop(req);
      try { return security.verify(token, shop, Date.now(), 3600000); }
      catch { throw new HttpError(401, 'Invalid session'); }
    },
    validate: async claims => validatedSession(await tenantForShop(claims.shop), claims),
    chat: async (claims, message) => groundedTurn(await validatedSession(await tenantForShop(claims.shop), claims), message),
    provider: services.tavus,
  }) : undefined;
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
      await db.query('INSERT INTO events(shop,id,name,source,conversation_id,experiment_id,assignment,metadata,visitor_hash) SELECT $1,$2,$3,$4,$5,$6,$7,$8,visitor_hash FROM conversations WHERE shop=$1 AND id=$5 AND consent=true AND expires_at>now() ON CONFLICT DO NOTHING', [claims.shop, id, name, 'widget', claims.sid, claims.experimentId, claims.assignment, JSON.stringify(metadata)]);
    }
    await eraseLateAnalytics(claims.shop, claims.sid);
    return reply.code(204).send();
  });
  app.post('/proxy/consent', async (req, reply) => {
    const body = baseBody.extend({ analyticsConsent: z.literal(false) }).strict().parse(req.body);
    // Erasure remains available when the merchant disables the app or its model/config fails.
    const shop = await proxyShop(req); let claims: SessionClaims;
    // Revocation only: an idle tab can erase its retained 90-day exposure after the
    // conversation and checkout mapping expire. This grace never enables commerce/events.
    try { claims = security!.verify(body.token, shop, Date.now(), 90 * 86_400_000); }
    catch { throw new HttpError(401, 'Invalid revocation token'); }
    // The same browser may have mappings from earlier sessions/experiments. Revoke all known
    // sessions for that pixel identity so an old tab cannot restore tracking after withdrawal.
    const revoked = await db.query<{ visitors: string[]; clients: string[]; sessions: string[] }>(`WITH affected AS (
      SELECT client_hash FROM pixel_assignments WHERE shop=$1 AND conversation_id=$2
    ), visitor AS (
      SELECT visitor_hash FROM conversations WHERE shop=$1 AND id=$2 AND visitor_hash IS NOT NULL
      UNION SELECT visitor_hash FROM pixel_assignments WHERE shop=$1 AND client_hash IN (SELECT client_hash FROM affected) AND visitor_hash IS NOT NULL
      UNION SELECT $3::text WHERE $3::text IS NOT NULL
    ), revoked AS (
      UPDATE conversations SET consent=false,visitor_hash=NULL WHERE shop=$1 AND (id=$2 OR visitor_hash IN (SELECT visitor_hash FROM visitor) OR id IN (
        SELECT conversation_id FROM pixel_assignments WHERE shop=$1 AND client_hash IN (SELECT client_hash FROM affected)
      )) RETURNING id
    ), removed_events AS (
      DELETE FROM events WHERE shop=$1 AND (conversation_id=$2 OR conversation_id IN (SELECT id FROM revoked) OR visitor_hash IN (SELECT visitor_hash FROM visitor) OR client_hash IN (SELECT client_hash FROM affected))
    ), removed_mappings AS (
      DELETE FROM pixel_assignments WHERE shop=$1 AND (conversation_id=$2 OR conversation_id IN (SELECT id FROM revoked) OR client_hash IN (SELECT client_hash FROM affected) OR visitor_hash IN (SELECT visitor_hash FROM visitor))
    ), removed_exposures AS (
      DELETE FROM eligible_exposures WHERE shop=$1 AND visitor_hash IN (SELECT visitor_hash FROM visitor)
    ) SELECT ARRAY(SELECT visitor_hash FROM visitor) AS visitors,ARRAY(SELECT client_hash FROM affected) AS clients,ARRAY(SELECT id FROM revoked) AS sessions`, [claims.shop, claims.sid, claims.visitorHash ?? null]);
    // A writer may have committed after the previous statement's snapshot but before
    // its consent update committed. This fresh snapshot closes that commit ordering;
    // writers also run eraseLateAnalytics for the opposite ordering.
    const erased = revoked.rows[0]!;
    await db.query(`WITH removed_events AS (
      DELETE FROM events WHERE shop=$1 AND (conversation_id=$2 OR conversation_id=ANY($5::uuid[]) OR visitor_hash=ANY($3::text[]) OR client_hash=ANY($4::text[]))
    ), removed_mappings AS (
      DELETE FROM pixel_assignments WHERE shop=$1 AND (conversation_id=$2 OR conversation_id=ANY($5::uuid[]) OR visitor_hash=ANY($3::text[]) OR client_hash=ANY($4::text[]))
    ) DELETE FROM eligible_exposures WHERE shop=$1 AND visitor_hash=ANY($3::text[])`, [claims.shop, claims.sid, erased.visitors, erased.clients, erased.sessions]);
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
      const conversation = await db.query<{ assignment: string; experiment_id: string; visitor_hash: string | null }>('SELECT assignment,experiment_id,visitor_hash FROM conversations WHERE shop=$1 AND id=$2 AND consent=true AND expires_at>now()', [body.shop, event.conversationId]);
      const row = conversation.rows[0];
      if (!row || row.assignment !== event.assignment || row.experiment_id !== event.experimentId) return reply.code(204).send();
      await db.query(`INSERT INTO pixel_assignments(shop,client_hash,experiment_id,assignment,conversation_id,expires_at,visitor_hash)
        SELECT $1,$2,$3,$4,$5,now()+interval '1 day',visitor_hash FROM conversations WHERE shop=$1 AND id=$5 AND consent=true AND expires_at>now()
        ON CONFLICT(shop,client_hash,experiment_id) DO UPDATE SET conversation_id=$5,expires_at=now()+interval '1 day',visitor_hash=EXCLUDED.visitor_hash,
        ambiguous=pixel_assignments.ambiguous OR pixel_assignments.assignment<>EXCLUDED.assignment OR pixel_assignments.visitor_hash IS DISTINCT FROM EXCLUDED.visitor_hash`, [body.shop, hash, row.experiment_id, row.assignment, event.conversationId]);
      await eraseLateAnalytics(body.shop, event.conversationId);
      return reply.code(204).send();
    }
    const mapping = await db.query<{ assignment: string; experiment_id: string; conversation_id: string; visitor_hash: string | null; ambiguous: boolean }>('SELECT assignment,experiment_id,conversation_id,visitor_hash,ambiguous FROM pixel_assignments WHERE shop=$1 AND client_hash=$2 AND expires_at>now() ORDER BY expires_at DESC,experiment_id DESC LIMIT 1', [body.shop, hash]);
    const assignment = mapping.rows[0];
    if (!assignment || assignment.ambiguous) return reply.code(204).send();
    const orderId = event.orderId?.replace('gid://shopify/Order/', '');
    // A missing order ID cannot be safely deduplicated as a purchase.
    if (event.name === 'purchase' && !orderId) return reply.code(204).send();
    const id = event.name === 'purchase' && orderId ? `purchase:${s.hashClient(body.shop, `order:${orderId}`)}` : `pixel:${s.hashClient(body.shop, `event:${event.id}`)}`;
    const metadata = event.name === 'purchase' ? { settlementVerified: false, ...(event.totalAmount && event.currency ? { totalAmount: event.totalAmount, currency: event.currency } : {}) } : {};
    await db.query(`INSERT INTO events(shop,id,name,source,conversation_id,client_hash,experiment_id,assignment,metadata,visitor_hash)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10 WHERE EXISTS(
        SELECT 1 FROM pixel_assignments WHERE shop=$1 AND client_hash=$6 AND conversation_id=$5 AND expires_at>now() AND ambiguous=false
      ) ON CONFLICT DO NOTHING`, [body.shop, id, event.name, 'pixel', assignment.conversation_id, hash, assignment.experiment_id, assignment.assignment, JSON.stringify(metadata), assignment.visitor_hash]);
    // Checkout intentionally outlives conversation expiry; only missing/revoked mappings
    // invalidate it. Check those in a fresh snapshot after the insert.
    await db.query(`DELETE FROM events WHERE shop=$1 AND source='pixel' AND id=$2 AND NOT EXISTS(
      SELECT 1 FROM pixel_assignments WHERE shop=$1 AND client_hash=$3 AND conversation_id=$4 AND expires_at>now() AND ambiguous=false
    )`, [body.shop, id, hash, assignment.conversation_id]);
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
    if (topic === 'app/uninstalled' || topic === 'shop/redact' || topic === 'customers/redact') await avatars?.stopShop(shop);
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
      await db.query('DELETE FROM eligible_exposures WHERE shop=$1', [shop]);
    } else if (topic !== 'customers/data_request' && topic !== 'customers/redact') {
      throw new HttpError(400, 'Unsupported topic');
    }
    // Events carry only pseudonymous hashes; shopper messages remain short-lived context.
    await db.query('INSERT INTO webhooks(shop,id) VALUES($1,$2) ON CONFLICT DO NOTHING', [shop, id]);
    return reply.code(200).send();
  });

  if (sdk && security) registerInstallation(app, {
    apiKey: env.apiKey!, apiSecret: env.apiSecret!, appUrl: env.appUrl, callbackPath: env.authCallbackPath, scopes: scopeList, allowedShops: env.allowedShops,
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
