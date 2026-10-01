import { describe, expect, it, vi } from 'vitest';
import { CartError, ThemeCart, localeRoot } from '../apps/widget/src/cart.js';
import { visitorId } from '../apps/widget/src/consent.js';
import type { Variant } from '../apps/widget/src/types.js';

const variant: Variant = { id: 'gid://shopify/ProductVariant/123', legacyId: '123', title: 'One', price: { amount: '20.00', currencyCode: 'EUR' }, availableForSale: true, currentlyNotInStock: false };
const cart = { items: [{ key: '123:line-key', variant_id: 123, product_id: 100, title: 'Item', quantity: 1, final_line_price: 2000 }], currency: 'EUR', total_price: 2000, item_count: 1 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('theme cart authorization and consistency', () => {
  it('preserves the browser fetch receiver when no test transport is supplied', async () => {
    const browserFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(json(cart));
    });
    vi.stubGlobal('fetch', browserFetch);
    try {
      const gateway = new ThemeCart('/', async () => variant);
      await expect(gateway.add(variant, 1)).resolves.toEqual(cart);
      expect(browserFetch).toHaveBeenCalledTimes(3);
    } finally { vi.unstubAllGlobals(); }
  });
  it('does not mutate when live verification reports a price change', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const gateway = new ThemeCart('/el/', async () => ({ ...variant, price: { ...variant.price, amount: '21.00' } }), fetcher);
    await expect(gateway.add(variant, 1)).rejects.toMatchObject({ code: 'price_changed' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not mutate a sold-out variant', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const gateway = new ThemeCart('/', async () => ({ ...variant, availableForSale: false }), fetcher);
    await expect(gateway.add(variant, 1)).rejects.toMatchObject({ code: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { currentlyNotInStock: true },
    { requiresSellingPlan: true },
    { requiresComponents: true },
    { quantityRule: { minimum: 2, maximum: 10, increment: 2 } },
  ])('blocks unsupported inventory and purchase constraints %o', async patch => {
    const fetcher = vi.fn<typeof fetch>();
    const gateway = new ThemeCart('/', async () => ({ ...variant, ...patch }), fetcher);
    await expect(gateway.add(variant, 1)).rejects.toBeInstanceOf(CartError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('applies maximum to quantity already in the cart plus the requested addition', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(cart));
    const gateway = new ThemeCart('/', async () => ({ ...variant, quantityRule: { minimum: 1, maximum: 2, increment: 1 } }), fetcher);
    await expect(gateway.add(variant, 2)).rejects.toMatchObject({ code: 'invalid' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses locale Ajax cart and live variant ID only after verification', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(cart)).mockResolvedValueOnce(json({})).mockResolvedValueOnce(json(cart));
    const verify = vi.fn(async () => variant);
    const gateway = new ThemeCart('/el/', verify, fetcher);
    await gateway.add(variant, 2);
    expect(verify).toHaveBeenCalledWith(variant.id);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/el/cart.js', '/el/cart/add.js', '/el/cart.js']);
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({ items: [{ id: '123', quantity: 2 }] });
  });
  it('updates a line by key and refuses stale quantities', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(cart));
    const gateway = new ThemeCart('/', async () => variant, fetcher);
    await expect(gateway.change('123:line-key', 0, 2)).rejects.toMatchObject({ code: 'cart_changed' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await gateway.change('123:line-key', 0, 1);
    const mutation = fetcher.mock.calls.find(call => call[0] === '/cart/change.js');
    expect(JSON.parse(mutation![1]!.body as string)).toEqual({ id: '123:line-key', quantity: 0 });
  });
  it('serializes mutations and never blindly retries ambiguous network results', async () => {
    let release: (value: Variant) => void = () => undefined;
    const verify = vi.fn(() => new Promise<Variant>(resolve => { release = resolve; }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(cart)).mockRejectedValueOnce(new Error('connection lost'));
    const gateway = new ThemeCart('/', verify, fetcher);
    const first = gateway.add(variant, 1);
    await expect(gateway.add(variant, 1)).rejects.toMatchObject({ code: 'busy' });
    release(variant);
    await expect(first).rejects.toMatchObject({ code: 'uncertain' });
    await expect(gateway.add(variant, 1)).rejects.toMatchObject({ code: 'uncertain' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(json(cart));
    await expect(gateway.refresh()).resolves.toEqual(cart);
  });
  it('requires a cart refresh after Shopify rejects a potentially partial mutation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ ...cart, items: [] })).mockResolvedValueOnce(json({ status: 422 }, 422));
    const gateway = new ThemeCart('/', async () => variant, fetcher);
    await expect(gateway.add(variant, 20)).rejects.toMatchObject({ code: 'rejected' });
    await expect(gateway.add(variant, 1)).rejects.toMatchObject({ code: 'uncertain' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects off-origin roots and invalid quantities', async () => {
    expect(() => localeRoot('//evil.example/')).toThrow(CartError);
    expect(() => localeRoot('/foo/../')).toThrow(CartError);
    const gateway = new ThemeCart('/', async () => variant, vi.fn());
    await expect(gateway.add(variant, -1)).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('analytics consent', () => {
  it('never reads or creates a stable identifier without consent and clears on withdrawal', () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    const random = vi.fn(() => 'dcda1f0b-8c73-46c2-978f-b8bfb8c0f4f4');
    expect(visitorId(false, storage, random)).toBeUndefined();
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    expect(storage.removeItem).toHaveBeenCalled();
    expect(visitorId(true, storage, random)).toBe(random.mock.results[0]!.value);
  });
  it('does not enroll if persistence is blocked', () => {
    const storage = { getItem: () => { throw new Error('denied'); }, setItem: vi.fn(), removeItem: vi.fn() };
    expect(visitorId(true, storage)).toBeUndefined();
  });
});
