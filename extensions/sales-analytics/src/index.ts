import { register } from '@shopify/web-pixels-extension';

register(({ analytics, settings, init, customerPrivacy }) => {
  const endpoint = typeof settings.endpoint === 'string' ? settings.endpoint : '';
  const shop = typeof settings.shop === 'string' ? settings.shop : '';
  const ingestKey = typeof settings.ingestKey === 'string' ? settings.ingestKey : '';
  let collector: URL;
  try { collector = new URL(endpoint); } catch { return; }
  if (collector.protocol !== 'https:' || collector.username || collector.password || collector.search || collector.hash || collector.pathname !== '/api/pixel/events' || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || !ingestKey) return;
  let allowed = init.customerPrivacy.analyticsProcessingAllowed;
  let generation = 0;
  const requests = new Set<AbortController>();
  let assignment: { assignment: 'assistant' | 'control'; experimentId: string; conversationId: string } | undefined;
  customerPrivacy.subscribe('visitorConsentCollected', event => {
    allowed = event.customerPrivacy.analyticsProcessingAllowed;
    generation++;
    if (!allowed) {
      assignment = undefined;
      for (const request of requests) request.abort();
      requests.clear();
    }
  });
  async function send(event: { id: string; name: string; clientId: string; orderId?: string; assignment?: string; experimentId?: string; conversationId?: string }): Promise<void> {
    if (!allowed || !event.clientId || !event.id) return;
    const currentGeneration = generation;
    const controller = new AbortController();
    requests.add(controller);
    try {
      if (currentGeneration !== generation || !allowed) return;
      await fetch(collector.href, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit',
        body: JSON.stringify({ shop, ingestKey, event }), signal: controller.signal,
      });
    } catch { /* Events are best effort; never persist checkout or shopper data. */ }
    finally { requests.delete(controller); }
  }
  analytics.subscribe('sales_agent_assignment', event => {
    if (!allowed) return;
    const data = event.customData;
    if (!data || (data.assignment !== 'assistant' && data.assignment !== 'control') || typeof data.experimentId !== 'string' || typeof data.conversationId !== 'string') return;
    assignment = { assignment: data.assignment, experimentId: data.experimentId, conversationId: data.conversationId };
    void send({ id: event.id, name: 'experiment_exposure', clientId: event.clientId, ...assignment });
  });
  analytics.subscribe('checkout_started', event => {
    void send({ id: event.id, name: 'checkout_started', clientId: event.clientId, ...assignment });
  });
  analytics.subscribe('checkout_completed', event => {
    const orderId = event.data.checkout.order?.id;
    void send({ id: event.id, name: 'purchase', clientId: event.clientId, ...(orderId ? { orderId } : {}), ...assignment });
  });
});
