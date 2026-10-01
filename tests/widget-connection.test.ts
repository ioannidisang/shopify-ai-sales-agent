import { afterEach, describe, expect, it, vi } from 'vitest';
import { WidgetConnection } from '../apps/widget/src/connection.js';
import { widgetModuleUrl } from '../apps/widget/src/module-url.js';
import type { Bootstrap } from '../apps/widget/src/types.js';

function session(assignment: Bootstrap['assignment'], token = 'session-1'): Bootstrap {
  return { token, conversationId: token, assignment, experimentId: 'test-v1', brand: 'Test', enabled: true, knowledgeVersion: '1' };
}

function fixture(allowed = true) {
  const consent = { allowed };
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
  const publish = vi.fn();
  vi.stubGlobal('window', { localStorage: storage, Shopify: { customerPrivacy: { analyticsProcessingAllowed: () => consent.allowed }, analytics: { publish } } });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  return { consent, storage, values, publish, fetcher, connection: new WidgetConnection('/apps/sales-agent', 'GR', 'el') };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('connection shared by launcher and lazy shopping UI', () => {
  it('deduplicates simultaneous bootstrap requests and does not persist identity or track without consent', async () => {
    const { connection, fetcher, storage, publish } = fixture(false);
    const result = deferred<Response>();
    fetcher.mockReturnValueOnce(result.promise);
    const first = connection.ensureSession();
    const second = connection.ensureSession();
    result.resolve(Response.json(session('untracked')));
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ analyticsConsent: false, country: 'GR', locale: 'el' });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    await connection.track('assistant_open');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['assistant', 'openai', 'mistral', 'control'] as const)('records %s exposure before UI load, exactly once', async assignment => {
    const { connection, fetcher, publish } = fixture();
    fetcher.mockImplementation(async path => String(path).endsWith('/bootstrap') ? Response.json(session(assignment)) : Response.json({}));
    await connection.initialize();
    await connection.ensureSession();
    expect(publish).toHaveBeenCalledExactlyOnceWith('sales_agent_assignment', { assignment, experimentId: 'test-v1', conversationId: 'session-1' });
    const events = fetcher.mock.calls.filter(([path]) => String(path).endsWith('/events'));
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]![1]!.body as string).events[0].name).toBe('experiment_exposure');
  });

  it('withdraws consent, aborts pending analytics and keeps a late old bootstrap from replacing the new assignment', async () => {
    const { connection, fetcher, consent, storage, publish } = fixture();
    const oldBootstrap = deferred<Response>();
    fetcher.mockReturnValueOnce(oldBootstrap.promise);
    const first = connection.initialize();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    consent.allowed = false;
    fetcher.mockResolvedValue(Response.json(session('untracked', 'new-session')));
    await connection.consentChanged();
    oldBootstrap.resolve(Response.json(session('assistant', 'old-session')));
    await first;
    expect(connection.session?.token).toBe('new-session');
    expect(publish).not.toHaveBeenCalled();
    expect(storage.removeItem).toHaveBeenCalled();
    const revocation = fetcher.mock.calls.find(([path]) => String(path).endsWith('/consent'));
    expect(JSON.parse(revocation![1]!.body as string)).toEqual({ token: 'old-session', analyticsConsent: false });
  });

  it('aborts an in-flight event when consent is revoked and omits all later events', async () => {
    const { connection, fetcher, consent, publish } = fixture();
    let eventSignal: AbortSignal | undefined;
    fetcher.mockImplementation(async (path, init) => {
      if (String(path).endsWith('/bootstrap')) return Response.json(session(consent.allowed ? 'assistant' : 'untracked', consent.allowed ? 'before' : 'after'));
      if (String(path).endsWith('/events')) {
        eventSignal = init?.signal as AbortSignal;
        return new Promise((_resolve, reject) => eventSignal!.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
      }
      return Response.json({});
    });
    await connection.initialize();
    expect(eventSignal?.aborted).toBe(false);
    consent.allowed = false;
    await connection.consentChanged();
    expect(eventSignal?.aborted).toBe(true);
    await connection.track('assistant_open');
    expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith('/events'))).toHaveLength(1);
    const revocation = fetcher.mock.calls.find(([path]) => String(path).endsWith('/consent'));
    expect(JSON.parse(revocation![1]!.body as string)).toEqual({ token: 'before', analyticsConsent: false });
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it('revokes an abandoned consented bootstrap even when consent was quickly granted again', async () => {
    const { connection, fetcher, consent } = fixture(); const old = deferred<Response>(); let bootstraps = 0;
    fetcher.mockImplementation(async path => {
      if (!String(path).endsWith('/bootstrap')) return Response.json({});
      bootstraps++;
      if (bootstraps === 1) return old.promise;
      return Response.json(session(bootstraps === 2 ? 'untracked' : 'mistral', `session-${bootstraps}`));
    });
    const first = connection.initialize(); await vi.waitFor(() => expect(bootstraps).toBe(1));
    consent.allowed = false; await connection.consentChanged();
    consent.allowed = true; await connection.consentChanged();
    old.resolve(Response.json(session('openai', 'abandoned'))); await first;
    expect(connection.session?.token).toBe('session-3'); expect(connection.session?.assignment).toBe('mistral');
    const revocations = fetcher.mock.calls.filter(([path]) => String(path).endsWith('/consent')).map(([, init]) => JSON.parse(init!.body as string));
    expect(revocations).toContainEqual({ token: 'abandoned', analyticsConsent: false });
  });

  it('renews an expired session without retrying its operation, and ignores a stale 401 for a different session', async () => {
    const { connection, fetcher } = fixture(false);
    connection.session = session('untracked', 'expired');
    fetcher.mockImplementation(async path => String(path).endsWith('/bootstrap') ? Response.json(session('untracked', 'renewed')) : new Response('', { status: 401 }));
    await expect(connection.post('/chat', { token: 'expired', message: 'test' })).rejects.toThrow('Assistant request unavailable');
    await vi.waitFor(() => expect(connection.session?.token).toBe('renewed'));
    expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith('/chat'))).toHaveLength(1);
    const generation = connection.generation;
    await expect(connection.post('/events', { token: 'expired' })).rejects.toThrow();
    expect(connection.session?.token).toBe('renewed');
    expect(connection.generation).toBe(generation);
  });
});

describe('interaction-loaded module URL', () => {
  it('accepts the Shopify CDN and same-origin asset paths', () => {
    expect(widgetModuleUrl('//cdn.shopify.com/extensions/123/assets/sales-assistant-ui.js?v=1', 'https://shop.example')).toBe('https://cdn.shopify.com/extensions/123/assets/sales-assistant-ui.js?v=1');
    expect(widgetModuleUrl('/cdn/shop/t/1/assets/sales-assistant-ui.js', 'https://shop.example')).toBe('https://shop.example/cdn/shop/t/1/assets/sales-assistant-ui.js');
  });
  it.each(['https://attacker.example/sales-assistant-ui.js', 'https://cdn.shopify.com.attacker.example/sales-assistant-ui.js', 'https://user:pass@cdn.shopify.com/sales-assistant-ui.js', 'http://cdn.shopify.com/sales-assistant-ui.js', '/other-module.js', 'javascript:alert(1)'])('rejects unexpected module location %s', value => {
    expect(() => widgetModuleUrl(value, 'https://shop.example')).toThrow();
  });
});
