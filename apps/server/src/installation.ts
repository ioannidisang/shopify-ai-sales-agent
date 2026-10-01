import '@shopify/shopify-api/adapters/node';
import { ApiVersion, LogSeverity, shopifyApi, type GraphqlClient } from '@shopify/shopify-api';
import type { FastifyInstance } from 'fastify';

export const REQUIRED_SHOPIFY_SCOPES = [
  'unauthenticated_read_product_listings', 'read_pixels', 'write_pixels',
  'read_customer_events', 'write_app_proxy',
];

export interface InstallationOptions {
  apiKey: string;
  apiSecret: string;
  appUrl: string;
  scopes: string[];
  allowedShops: string[];
  saveInstallation: (data: {
    shop: string;
    adminSession: Record<string, unknown>;
    storefrontToken: string;
    pixelId?: string;
  }) => Promise<void>;
  pixelIngestKey: (shop: string) => string;
}

// Operations are fixed server code. No user/model-supplied GraphQL is accepted.
const TOKEN_LIST = `query InstallationStorefrontTokens {
  shop { storefrontAccessTokens(first: 100) {
    nodes { title accessToken accessScopes { handle } }
  } }
}`;
const TOKEN_CREATE = `mutation InstallationStorefrontToken($input: StorefrontAccessTokenInput!) {
  storefrontAccessTokenCreate(input: $input) {
    storefrontAccessToken { accessToken accessScopes { handle } }
    userErrors { field message }
  }
}`;
const PIXEL_READ = `query InstallationPixel { webPixel { id } }`;
const PIXEL_CREATE = `mutation InstallationPixelCreate($webPixel: WebPixelInput!) {
  webPixelCreate(webPixel: $webPixel) {
    webPixel { id }
    userErrors { field message }
  }
}`;
const PIXEL_UPDATE = `mutation InstallationPixelUpdate($id: ID!, $webPixel: WebPixelInput!) {
  webPixelUpdate(id: $id, webPixel: $webPixel) {
    webPixel { id }
    userErrors { field message }
  }
}`;

type Token = { title?: string; accessToken: string; accessScopes: { handle: string }[] };
type MutationResult<T> = T & { userErrors: { field?: string[]; message: string }[] };
type Stage = 'oauth' | 'scopes' | 'storefront_access' | 'web_pixel' | 'persistence';

class InstallationFailure extends Error {
  constructor(readonly stage: Stage) { super('Installation step failed'); }
}

async function request<T>(client: GraphqlClient, operation: string, stage: Stage, variables?: Record<string, unknown>): Promise<T> {
  try {
    const result = await client.request<T>(operation, { variables, retries: 0, signal: AbortSignal.timeout(15_000) });
    if (!result.data) throw new InstallationFailure(stage);
    return result.data;
  } catch {
    // SDK errors can contain response bodies, tokens, or supplied settings. Never propagate them.
    throw new InstallationFailure(stage);
  }
}

async function storefrontToken(client: GraphqlClient, scopes: string[]): Promise<string> {
  const expected = scopes.filter((scope) => scope.startsWith('unauthenticated_'));
  const usable = (token: Token) => token.accessToken && expected.every((scope) => token.accessScopes.some((s) => s.handle === scope));
  const { shop } = await request<{ shop: { storefrontAccessTokens: { nodes: Token[] } } }>(client, TOKEN_LIST, 'storefront_access');
  // Tokens are scoped to this app; recover after an interrupted install instead of consuming the 100-token limit.
  const existing = shop.storefrontAccessTokens.nodes.find((token) => token.title === 'AI Sales Agent storefront v1' && usable(token));
  if (existing) return existing.accessToken;
  const result = await request<{ storefrontAccessTokenCreate: MutationResult<{ storefrontAccessToken: Token | null }> }>(
    client, TOKEN_CREATE, 'storefront_access', { input: { title: 'AI Sales Agent storefront v1' } },
  );
  const created = result.storefrontAccessTokenCreate;
  if (created.userErrors.length || !created.storefrontAccessToken || !usable(created.storefrontAccessToken)) {
    throw new InstallationFailure('storefront_access');
  }
  return created.storefrontAccessToken.accessToken;
}

async function readPixel(client: GraphqlClient): Promise<string | undefined> {
  // The lower-level official client preserves GraphQL error details. An absent pixel can be a null
  // object or Shopify's explicit "No web pixel was found for this app" GraphQL error.
  const result = await client.client.request<{ webPixel: { id: string } | null }>(PIXEL_READ, {
    retries: 0, signal: AbortSignal.timeout(15_000),
  });
  if (result.errors) {
    const errors = result.errors.graphQLErrors;
    const absent = errors?.length === 1 &&
      /^No web pixel was found for this app\.?$/.test(errors[0]?.message ?? '') &&
      errors[0]?.path?.[0] === 'webPixel';
    if (!absent) throw new InstallationFailure('web_pixel');
    return undefined;
  }
  if (!result.data || !('webPixel' in result.data)) throw new InstallationFailure('web_pixel');
  return result.data.webPixel?.id;
}

async function provisionPixel(client: GraphqlClient, settings: Record<string, string>): Promise<string> {
  const id = await readPixel(client);
  const webPixel = { settings: JSON.stringify(settings) };
  if (id) {
    const result = await request<{ webPixelUpdate: MutationResult<{ webPixel: { id: string } | null }> }>(
      client, PIXEL_UPDATE, 'web_pixel', { id, webPixel },
    );
    if (result.webPixelUpdate.userErrors.length || !result.webPixelUpdate.webPixel?.id) throw new InstallationFailure('web_pixel');
    return result.webPixelUpdate.webPixel.id;
  }
  const result = await request<{ webPixelCreate: MutationResult<{ webPixel: { id: string } | null }> }>(
    client, PIXEL_CREATE, 'web_pixel', { webPixel },
  );
  if (result.webPixelCreate.userErrors.length || !result.webPixelCreate.webPixel?.id) {
    throw new InstallationFailure('web_pixel');
  }
  return result.webPixelCreate.webPixel.id;
}

export function registerInstallation(app: FastifyInstance, options: InstallationOptions): void {
  const origin = new URL(options.appUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('APP_URL must be an HTTPS origin without a path or credentials');
  }
  if (!options.allowedShops.length || options.allowedShops.some((shop) => !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop))) {
    throw new Error('Installation requires an explicit valid shop allowlist');
  }
  if (!REQUIRED_SHOPIFY_SCOPES.every((scope) => options.scopes.includes(scope))) {
    throw new Error('Installation is missing required Shopify scopes');
  }
  const allowed = new Set(options.allowedShops);
  const shopify = shopifyApi({
    apiKey: options.apiKey, apiSecretKey: options.apiSecret,
    scopes: options.scopes, hostName: origin.host, hostScheme: 'https',
    apiVersion: ApiVersion.July26, isEmbeddedApp: false,
    // In particular suppress SDK OAuth debug URLs, cookie state and HTTP response bodies.
    logger: { log: () => {}, level: LogSeverity.Error, httpRequests: false },
  });
  const permittedShop = (query: unknown): string | undefined => {
    const value = (query as Record<string, unknown>)?.shop;
    if (typeof value !== 'string' || !allowed.has(value)) return undefined;
    return shopify.utils.sanitizeShop(value, true) ?? undefined;
  };

  app.get('/auth', async (req, reply) => {
    const shop = permittedShop(req.query);
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    if (!shop) return reply.code(403).send({ error: 'Shop is not permitted for this pilot' });
    // SDK Node adapter writes the redirect and signed, secure OAuth state cookies directly.
    reply.raw.setHeader('Cache-Control', 'no-store');
    reply.raw.setHeader('Referrer-Policy', 'no-referrer');
    reply.hijack();
    try {
      await shopify.auth.begin({ shop, callbackPath: '/auth/callback', isOnline: false, rawRequest: req.raw, rawResponse: reply.raw });
    } catch {
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 503;
        reply.raw.setHeader('Content-Type', 'application/json');
        reply.raw.end(JSON.stringify({ error: 'Unable to start installation' }));
      } else if (!reply.raw.writableEnded) reply.raw.end();
    }
  });

  app.get('/auth/callback', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const shop = permittedShop(req.query);
    if (!shop) return reply.code(403).send({ error: 'Shop is not permitted for this pilot' });
    // Reject ambiguous parameters before the SDK collapses URLSearchParams into an object.
    const params = new URL(req.raw.url ?? '', origin).searchParams;
    if ([...new Set(params.keys())].some((key) => params.getAll(key).length !== 1)) {
      return reply.code(400).send({ error: 'Invalid installation callback' });
    }
    let stage: Stage = 'oauth';
    try {
      // Official SDK validates HMAC, signed state cookie and timestamp, then exchanges the code.
      const { session } = await shopify.auth.callback({ rawRequest: req.raw, rawResponse: reply.raw, expiring: false });
      stage = 'scopes';
      if (session.shop !== shop || session.isOnline || !session.accessToken || !session.isScopeIncluded(options.scopes)) {
        throw new InstallationFailure(stage);
      }
      const client = new shopify.clients.Graphql({ session });
      stage = 'storefront_access';
      const token = await storefrontToken(client, options.scopes);
      stage = 'web_pixel';
      const pixelId = await provisionPixel(client, {
        endpoint: `${origin.origin}/api/pixel/events`, shop, ingestKey: options.pixelIngestKey(shop),
      });
      stage = 'persistence';
      // The caller encrypts and transactionally persists this payload. No credential is returned to the browser.
      await options.saveInstallation({ shop, adminSession: { ...session.toObject() }, storefrontToken: token, pixelId });
      return reply.type('text/html; charset=utf-8').send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Installation complete</title><h1>AI Sales Agent connected</h1><p>Storefront access and analytics are configured. Enable the app embed only in the dedicated unpublished theme preview, then complete the integration checklist.</p></html>');
    } catch {
      // Never log the caught error: Shopify errors may carry credentials or authenticated URLs.
      app.log.warn({ stage }, 'Shopify installation step failed');
      return reply.code(stage === 'oauth' ? 400 : 503).send({
        error: 'Installation incomplete', stage,
        next: stage === 'oauth' ? 'Restart installation in the same browser.' : 'Check this step on the backend, then restart installation. Existing app resources are reused.',
      });
    }
  });
}
