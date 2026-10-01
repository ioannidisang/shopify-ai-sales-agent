import { analyticsAllowed, loadConsent, visitorId } from './consent.js';
import type { AnalyticsEventName, Bootstrap } from './types.js';

export type EventDetail = { productId?: string; variantId?: string; quantity?: number };

/** Shared by the light page loader and the interaction-loaded shopping UI. */
export class WidgetConnection {
  session?: Bootstrap;
  generation = 0;
  private bootstrapPromise?: Promise<void>;
  private consent = false;
  private exposed = false;
  private readonly analyticsRequests = new Set<AbortController>();
  private readonly listeners = new Set<() => void>();

  constructor(readonly endpoint: string, readonly country: string, readonly locale: string) {
    if (!/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?apps\/[a-z0-9-]+$/.test(endpoint)) throw new Error('Invalid assistant endpoint');
  }

  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  private notify(): void { for (const callback of this.listeners) callback(); }

  async post<T>(path: string, body: unknown, controller?: AbortController): Promise<T> {
    const response = await globalThis.fetch(`${this.endpoint}${path}`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
      signal: controller ? AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const token = body && typeof body === 'object' && 'token' in body ? body.token : undefined;
      if (response.status === 401 && token && token === this.session?.token) {
        this.generation++;
        this.session = undefined;
        this.bootstrapPromise = undefined;
        this.exposed = false;
        this.notify();
        // Renew an expired session without retrying the shopper's request or cart action.
        void this.ensureSession().catch(() => { /* Stay hidden until assignment is known. */ });
      }
      throw new Error('Assistant request unavailable');
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  async initialize(): Promise<void> {
    await loadConsent();
    this.consent = analyticsAllowed();
    await this.ensureSession();
  }

  async consentChanged(): Promise<void> {
    const allowed = analyticsAllowed();
    if (allowed === this.consent) return;
    const previousToken = this.session?.token;
    this.consent = allowed;
    this.generation++;
    this.session = undefined;
    this.bootstrapPromise = undefined;
    this.exposed = false;
    for (const controller of this.analyticsRequests) controller.abort();
    this.analyticsRequests.clear();
    try { visitorId(false, window.localStorage); } catch { /* Storage may be disabled. */ }
    this.notify();
    if (!allowed && previousToken) {
      try { await this.post('/consent', { token: previousToken, analyticsConsent: false }); } catch { /* Tracking remains stopped. */ }
    }
    await this.ensureSession();
  }

  async ensureSession(): Promise<void> {
    if (this.session) return;
    if (this.bootstrapPromise) return this.bootstrapPromise;
    const generation = this.generation;
    this.bootstrapPromise = (async () => {
      let id: string | undefined;
      try { id = visitorId(this.consent, window.localStorage); } catch { /* No persisted analytics identity. */ }
      const session = await this.post<Bootstrap>('/bootstrap', {
        ...(id ? { visitorId: id } : {}), analyticsConsent: this.consent && !!id, country: this.country, locale: this.locale,
      });
      if (generation !== this.generation) {
        // Bootstrap may have enrolled the consented visitor before withdrawal reached
        // the browser. Erase that discarded session's exposure as soon as its token arrives.
        if (session.assignment !== 'untracked') {
          try { await this.post('/consent', { token: session.token, analyticsConsent: false }); } catch { /* Local tracking remains stopped. */ }
        }
        return;
      }
      this.session = session;
      this.notify();
      this.publishAssignment();
    })();
    try { await this.bootstrapPromise; } finally { if (generation === this.generation) this.bootstrapPromise = undefined; }
  }

  private publishAssignment(): void {
    const session = this.session;
    if (!session || !session.enabled || !this.consent || !analyticsAllowed() || session.assignment === 'untracked' || this.exposed) return;
    this.exposed = true;
    void this.track('experiment_exposure');
    try {
      window.Shopify?.analytics?.publish('sales_agent_assignment', {
        assignment: session.assignment, experimentId: session.experimentId, conversationId: session.conversationId,
      });
    } catch { /* Analytics must not block shopping. */ }
  }

  async track(name: AnalyticsEventName, detail: EventDetail = {}): Promise<void> {
    const session = this.session;
    if (!session || !this.consent || !analyticsAllowed() || session.assignment === 'untracked') return;
    const controller = new AbortController();
    this.analyticsRequests.add(controller);
    try { await this.post('/events', { token: session.token, events: [{ id: crypto.randomUUID(), name, ...detail }] }, controller); } catch { /* No event persistence or retry queue. */ }
    finally { this.analyticsRequests.delete(controller); }
  }
}
