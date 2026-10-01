import { beforeEach, describe, expect, it, vi } from 'vitest';

const registration = vi.hoisted(() => ({ callback: undefined as undefined | ((api: unknown) => void) }));
vi.mock('@shopify/web-pixels-extension', () => ({ register: (callback: (api: unknown) => void) => { registration.callback = callback; } }));

await import('../extensions/sales-analytics/src/index.js');

function pixel(allowed = true) {
  const subscriptions = new Map<string, (event: unknown) => void>();
  const privacy = new Map<string, (event: unknown) => void>();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  registration.callback!({
    analytics: { subscribe: (name: string, callback: (event: unknown) => void) => subscriptions.set(name, callback) },
    settings: { endpoint: 'https://collector.example/api/pixel/events', shop: 'pilot.myshopify.com', ingestKey: 'public-collector-key' },
    init: { customerPrivacy: { analyticsProcessingAllowed: allowed } },
    customerPrivacy: { subscribe: (name: string, callback: (event: unknown) => void) => privacy.set(name, callback) },
  });
  return { subscriptions, privacy, fetcher };
}

describe('minimal Shopify web pixel', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  it('transmits only allowlisted purchase fields, without checkout/customer data', () => {
    const { subscriptions, fetcher } = pixel();
    subscriptions.get('checkout_completed')!({ id: 'shopify-event-1', clientId: 'browser-id', data: { checkout: { email: 'private@example.com', phone: 'private', shippingAddress: { address1: 'private' }, order: { id: 'gid://shopify/Order/123' } } } });
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({ shop: 'pilot.myshopify.com', ingestKey: 'public-collector-key', event: { id: 'shopify-event-1', name: 'purchase', clientId: 'browser-id', orderId: 'gid://shopify/Order/123' } });
  });
  it('links both experimental arms and preserves Shopify event id for deduplication', () => {
    const { subscriptions, fetcher } = pixel();
    subscriptions.get('sales_agent_assignment')!({ id: 'exposure-1', clientId: 'browser-id', customData: { assignment: 'control', experimentId: 'v1', conversationId: 'conversation-1', text: 'never collected' } });
    subscriptions.get('checkout_started')!({ id: 'checkout-1', clientId: 'browser-id' });
    const events = fetcher.mock.calls.map(call => JSON.parse(call[1]!.body as string).event);
    expect(events[0]).toEqual({ id: 'exposure-1', name: 'experiment_exposure', clientId: 'browser-id', assignment: 'control', experimentId: 'v1', conversationId: 'conversation-1' });
    expect(events[1].assignment).toBe('control');
    expect(events[1].id).toBe('checkout-1');
  });
  it.each(['openai', 'mistral', 'control'])('preserves %s assignment and emits only observed checkout amount and currency', assignment => {
    const { subscriptions, fetcher } = pixel();
    subscriptions.get('sales_agent_assignment')!({ id: 'exposure', clientId: 'browser-id', customData: { assignment, experimentId: 'abc-v1', conversationId: 'conversation-1' } });
    subscriptions.get('checkout_completed')!({ id: 'completed', clientId: 'browser-id', data: { checkout: { email: 'private@example.com', order: { id: '123' }, totalPrice: { amount: 49.95, currencyCode: 'EUR' } } } });
    const event = JSON.parse(fetcher.mock.calls[1]![1]!.body as string).event;
    expect(event).toEqual({ id: 'completed', name: 'purchase', clientId: 'browser-id', orderId: '123', assignment, experimentId: 'abc-v1', conversationId: 'conversation-1', totalAmount: '49.95', currency: 'EUR' });
  });
  it('stops immediately on consent withdrawal and aborts in-flight requests', () => {
    const { subscriptions, privacy, fetcher } = pixel();
    subscriptions.get('checkout_started')!({ id: 'checkout-1', clientId: 'browser-id' });
    const signal = fetcher.mock.calls[0]![1]!.signal;
    privacy.get('visitorConsentCollected')!({ customerPrivacy: { analyticsProcessingAllowed: false } });
    subscriptions.get('checkout_completed')!({ id: 'purchase-1', clientId: 'browser-id', data: { checkout: {} } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
  });
  it('does not transmit events without analytics consent', () => {
    const { subscriptions, fetcher } = pixel(false);
    subscriptions.get('sales_agent_assignment')!({ id: 'exposure-1', clientId: 'browser-id', customData: { assignment: 'assistant', experimentId: 'v1', conversationId: 'conversation-1' } });
    subscriptions.get('checkout_started')!({ id: 'checkout-1', clientId: 'browser-id' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
