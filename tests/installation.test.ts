import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAbstractFetchFunc } from '@shopify/shopify-api/runtime';
import { registerInstallation, REQUIRED_SHOPIFY_SCOPES } from '../apps/server/src/installation.js';
import { readEnv } from '../apps/server/src/config.js';

const secret = 'test-only-oauth-secret-never-a-real-credential';
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const scopes = REQUIRED_SHOPIFY_SCOPES.join(',');
const tokenScopes = [{ handle: 'unauthenticated_read_product_listings' }];

describe.each([
  { shop: 'ym5fhx-fa.myshopify.com', callbackPath: undefined, route: '/auth/callback' },
  { shop: 'bionera-gr.myshopify.com', callbackPath: '/auth/bionera/callback', route: '/auth/bionera/callback' },
])('Shopify installation using the official OAuth SDK at $route', ({ shop, callbackPath, route }) => {
  let app: FastifyInstance;
  const save = vi.fn();
  const network = vi.fn<typeof fetch>();

  beforeEach(() => {
    save.mockReset();
    network.mockReset();
    network.mockRejectedValue(new Error('Unexpected external network request'));
    setAbstractFetchFunc(network);
    app = Fastify({ logger: false });
    registerInstallation(app, {
      apiKey: 'test-public-client-id', apiSecret: secret,
      appUrl: 'https://assistant.example', callbackPath, scopes: REQUIRED_SHOPIFY_SCOPES,
      allowedShops: [shop], saveInstallation: save,
      pixelIngestKey: () => 'test-client-visible-ingestion-key',
    });
  });

  afterEach(async () => { await app.close(); setAbstractFetchFunc(globalThis.fetch); });

  function respond(payload: unknown, status = 200) {
    network.mockResolvedValueOnce(new Response(JSON.stringify(payload), {
      status, headers: { 'content-type': 'application/json', 'x-shopify-api-version': '2026-07' },
    }));
  }

  async function begin() {
    const response = await app.inject({ url: `/auth?shop=${shop}`, headers: { 'user-agent': userAgent } });
    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location!);
    const cookies = response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    return { response, state: location.searchParams.get('state')!, cookies, location };
  }

  async function callback(state: string, cookies: string, override: Record<string, string> = {}) {
    const params = new URLSearchParams({
      code: 'test-authorization-code', shop, state,
      timestamp: String(Math.floor(Date.now() / 1000)), ...override,
    });
    const canonical = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&');
    params.set('hmac', createHmac('sha256', secret).update(canonical).digest('hex'));
    return app.inject({ url: `${route}?${params.toString()}`, headers: { cookie: cookies, 'user-agent': userAgent } });
  }

  it('rejects missing, malformed, ambiguous and non-allowlisted shops without calling Shopify', async () => {
    for (const query of ['', '?shop=other.myshopify.com', `?shop=https://${shop}`, `?shop=${shop}&shop=other.myshopify.com`]) {
      expect((await app.inject(`/auth${query}`)).statusCode).toBe(403);
      expect((await app.inject(`${route}${query}`)).statusCode).toBe(403);
    }
    expect(network).not.toHaveBeenCalled();
  });

  it('starts offline OAuth with secure state cookies and the configured callback', async () => {
    const { response, location } = await begin();
    expect(location.origin).toBe(`https://${shop}`);
    expect(location.pathname).toBe('/admin/oauth/authorize');
    expect(location.searchParams.get('redirect_uri')).toBe(`https://assistant.example${route}`);
    expect(location.searchParams.get('grant_options[]')).toBe('');
    expect(String(response.headers['cache-control'])).toBe('no-store');
    expect(response.cookies.some((cookie) => cookie.name === 'shopify_app_state' && cookie.secure)).toBe(true);
    expect(String(response.headers['set-cookie']).toLowerCase()).toContain('samesite=lax');
    expect(response.cookies.some((cookie) => cookie.name === 'shopify_app_state.sig')).toBe(true);
    expect(response.cookies.filter((cookie) => cookie.name.startsWith('shopify_app_state')).every((cookie) => cookie.path === route)).toBe(true);
  });

  it('registers only the active callback route', async () => {
    const inactiveRoute = route === '/auth/callback' ? '/auth/bionera/callback' : '/auth/callback';
    expect((await app.inject(`${inactiveRoute}?shop=${shop}`)).statusCode).toBe(404);
    expect(network).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects invalid state even with a valid callback HMAC', async () => {
    const { cookies } = await begin();
    const response = await callback('tampered-state', cookies);
    expect(response.statusCode).toBe(400);
    expect(response.json().stage).toBe('oauth');
    expect(network).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects callback without signed cookies, or with tampered HMAC', async () => {
    const { state, cookies } = await begin();
    expect((await callback(state, '')).statusCode).toBe(400);
    const response = await app.inject({
      url: `${route}?shop=${shop}&state=${state}&code=test&timestamp=${Math.floor(Date.now() / 1000)}&hmac=bad`,
      headers: { cookie: cookies, 'user-agent': userAgent },
    });
    expect(response.statusCode).toBe(400);
    expect(network).not.toHaveBeenCalled();
  });

  it('requires all granted scopes before provisioning resources', async () => {
    const { state, cookies } = await begin();
    respond({ access_token: 'test-offline-token', scope: 'unauthenticated_read_product_listings' });
    const response = await callback(state, cookies);
    expect(response.statusCode).toBe(503);
    expect(response.json().stage).toBe('scopes');
    expect(network).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('reuses its Storefront token and updates the existing pixel during reinstall', async () => {
    const { state, cookies } = await begin();
    respond({ access_token: 'test-offline-token', scope: scopes });
    respond({ data: { shop: { storefrontAccessTokens: { nodes: [{ title: 'AI Sales Agent storefront v1', accessToken: 'test-storefront-token', accessScopes: tokenScopes }] } } } });
    respond({ data: { webPixel: { id: 'gid://shopify/WebPixel/123' } } });
    respond({ data: { webPixelUpdate: { webPixel: { id: 'gid://shopify/WebPixel/123' }, userErrors: [] } } });
    const response = await callback(state, cookies);
    expect(response.statusCode).toBe(200);
    expect(network).toHaveBeenCalledTimes(4);
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      shop, storefrontToken: 'test-storefront-token', pixelId: 'gid://shopify/WebPixel/123',
      adminSession: expect.objectContaining({ accessToken: 'test-offline-token', isOnline: false, shop }),
    }));
    const pixelCall = JSON.parse(String(network.mock.calls[3]?.[1]?.body));
    expect(pixelCall.query).toContain('webPixelUpdate');
    expect(JSON.parse(pixelCall.variables.webPixel.settings)).toEqual({
      endpoint: 'https://assistant.example/api/pixel/events', shop, ingestKey: 'test-client-visible-ingestion-key',
    });
    expect(response.body).not.toContain('test-offline-token');
    expect(response.body).not.toContain('test-storefront-token');
  });

  it('creates resources only when the app has none and persists the verified result', async () => {
    const { state, cookies } = await begin();
    respond({ access_token: 'test-offline-token', scope: scopes });
    respond({ data: { shop: { storefrontAccessTokens: { nodes: [] } } } });
    respond({ data: { storefrontAccessTokenCreate: { storefrontAccessToken: { accessToken: 'test-new-storefront-token', accessScopes: tokenScopes }, userErrors: [] } } });
    respond({ data: { webPixel: null } });
    respond({ data: { webPixelCreate: { webPixel: { id: 'gid://shopify/WebPixel/123' }, userErrors: [] } } });
    const response = await callback(state, cookies);
    expect(response.statusCode).toBe(200);
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ storefrontToken: 'test-new-storefront-token' }));
    expect(JSON.parse(String(network.mock.calls[4]?.[1]?.body)).query).toContain('webPixelCreate');
  });

  it('fails closed on pixel permission errors without attempting pixel creation or saving credentials', async () => {
    const { state, cookies } = await begin();
    respond({ access_token: 'test-offline-token', scope: scopes });
    respond({ data: { shop: { storefrontAccessTokens: { nodes: [{ title: 'AI Sales Agent storefront v1', accessToken: 'test-storefront-token', accessScopes: tokenScopes }] } } } });
    respond({ errors: [{ message: 'Access denied. Sensitive provider details', path: ['webPixel'], extensions: { code: 'ACCESS_DENIED' } }], data: { webPixel: null } });
    const response = await callback(state, cookies);
    expect(response.statusCode).toBe(503);
    expect(response.json().stage).toBe('web_pixel');
    expect(response.body).not.toContain('Sensitive');
    expect(network).toHaveBeenCalledTimes(3);
    expect(save).not.toHaveBeenCalled();
  });

  it('reports failed persistence without claiming installation success or exposing the error', async () => {
    const { state, cookies } = await begin();
    respond({ access_token: 'test-offline-token', scope: scopes });
    respond({ data: { shop: { storefrontAccessTokens: { nodes: [{ title: 'AI Sales Agent storefront v1', accessToken: 'test-storefront-token', accessScopes: tokenScopes }] } } } });
    respond({ data: { webPixel: { id: 'gid://shopify/WebPixel/123' } } });
    respond({ data: { webPixelUpdate: { webPixel: { id: 'gid://shopify/WebPixel/123' }, userErrors: [] } } });
    save.mockRejectedValueOnce(new Error('test-secret-in-database-error'));
    const response = await callback(state, cookies);
    expect(response.statusCode).toBe(503);
    expect(response.json().stage).toBe('persistence');
    expect(response.body).not.toContain('test-secret');
  });
});

describe('active Shopify callback configuration', () => {
  const invalidPaths = [
    '', 'https://other.example/auth/bionera/callback', '//auth/bionera/callback',
    '/auth//callback', '/auth/bionera/callback/', '/auth/bionera/callback?shop=other',
    '/auth/bionera/callback#fragment', '/auth/bionera\\callback', '/auth/%62ionera/callback',
    '/auth/bionera%2fother/callback', '/auth/../callback', '/auth/Bionera/callback',
    '/auth/bionera/other/callback', '/different/callback', `/auth/${'a'.repeat(41)}/callback`,
    '/auth/bionera/callback\n', '/auth/bionera/callback\r\n',
  ];

  afterEach(() => { vi.unstubAllEnvs(); });

  function developmentEnv(callbackPath: string | undefined) {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PORT', '3000');
    vi.stubEnv('APP_URL', 'https://assistant.example');
    vi.stubEnv('ALLOWED_SHOPS', 'bionera-gr.myshopify.com');
    vi.stubEnv('SHOPIFY_AUTH_CALLBACK_PATH', callbackPath);
    return readEnv();
  }

  it('defaults unset environment configuration to the legacy callback', () => {
    expect(developmentEnv(undefined).authCallbackPath).toBe('/auth/callback');
  });

  it('reads the explicit active registration route without deriving a second app', () => {
    const env = developmentEnv('/auth/bionera/callback');
    expect(env.authCallbackPath).toBe('/auth/bionera/callback');
    expect(env.allowedShops).toEqual(['bionera-gr.myshopify.com']);
  });

  it.each(invalidPaths)('rejects noncanonical callback configuration %j before registering routes', async path => {
    expect(() => developmentEnv(path)).toThrow('Shopify callback must be');
    const app = Fastify({ logger: false });
    try {
      expect(() => registerInstallation(app, {
        apiKey: 'test-public-client-id', apiSecret: secret, appUrl: 'https://assistant.example',
        callbackPath: path, scopes: REQUIRED_SHOPIFY_SCOPES, allowedShops: ['bionera-gr.myshopify.com'],
        saveInstallation: async () => {}, pixelIngestKey: () => 'test-ingestion-key',
      })).toThrow('Shopify callback must be');
      expect(app.hasRoute({ method: 'GET', url: '/auth' })).toBe(false);
    } finally { await app.close(); }
  });
});
