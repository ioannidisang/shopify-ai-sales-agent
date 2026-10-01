const VISITOR_KEY = 'sales-agent:visitor:v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function visitorId(allowed: boolean, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, randomUUID: () => string = () => crypto.randomUUID()): string | undefined {
  try {
    if (!allowed) { storage.removeItem(VISITOR_KEY); return undefined; }
    const previous = storage.getItem(VISITOR_KEY);
    if (previous && UUID.test(previous)) return previous;
    const id = randomUUID();
    storage.setItem(VISITOR_KEY, id);
    return id;
  } catch { return undefined; }
}

export function analyticsAllowed(): boolean {
  try { return window.Shopify?.customerPrivacy?.analyticsProcessingAllowed() === true; } catch { return false; }
}

export async function loadConsent(): Promise<void> {
  if (window.Shopify?.customerPrivacy || !window.Shopify?.loadFeatures) return;
  await new Promise<void>(resolve => {
    const timeout = setTimeout(resolve, 2_000);
    window.Shopify?.loadFeatures?.([{ name: 'consent-tracking-api', version: '0.1' }], () => { clearTimeout(timeout); resolve(); });
  });
}
