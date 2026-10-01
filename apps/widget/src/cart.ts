import type { Variant } from './types.js';

export interface CartLine {
  key: string;
  variant_id: number;
  product_id: number;
  title: string;
  quantity: number;
  final_line_price: number;
}
export interface Cart { items: CartLine[]; item_count: number; total_price: number; currency: string }
export type CartErrorCode = 'busy' | 'unavailable' | 'price_changed' | 'cart_changed' | 'uncertain' | 'rejected' | 'invalid' | 'product_page';
export class CartError extends Error {
  constructor(public readonly code: CartErrorCode, public readonly variant?: Variant) { super(code); }
}

export function localeRoot(value: string): string {
  if (!/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?$/i.test(value)) throw new CartError('invalid');
  return value;
}

export function validQuantity(variant: Variant, quantity: number): boolean {
  const rule = variant.quantityRule || { minimum: 1, maximum: null, increment: 1 };
  return Number.isInteger(quantity) && quantity >= rule.minimum && quantity <= Math.min(rule.maximum ?? 20, 20) && rule.increment > 0 && quantity % rule.increment === 0;
}

export class ThemeCart {
  private busy = false;
  private uncertain = false;
  private root: string;
  constructor(root: string, private readonly verify: (id: string) => Promise<Variant>, private readonly fetcher: typeof fetch = (...args) => globalThis.fetch(...args)) {
    this.root = localeRoot(root);
  }
  async read(): Promise<Cart> {
    const response = await this.fetcher(`${this.root}cart.js`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new CartError('rejected');
    const cart = await response.json() as Cart;
    if (!Array.isArray(cart.items) || typeof cart.currency !== 'string') throw new CartError('invalid');
    return cart;
  }
  async refresh(): Promise<Cart> {
    if (this.busy) throw new CartError('busy');
    const cart = await this.read();
    this.uncertain = false;
    return cart;
  }
  private async lock<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new CartError('busy');
    if (this.uncertain) throw new CartError('uncertain');
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }
  private async mutate(path: string, body: unknown): Promise<Cart> {
    try {
      const response = await this.fetcher(`${this.root}cart/${path}.js`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        // A rejected Shopify add can still partially add available inventory.
        this.uncertain = true;
        throw new CartError('rejected');
      }
      return await this.read();
    } catch (error) {
      this.uncertain = true;
      if (error instanceof CartError) throw error;
      throw new CartError('uncertain');
    }
  }
  async add(displayed: Variant, quantity: number): Promise<Cart> {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new CartError('invalid');
    return this.lock(async () => {
      const verified = await this.verify(displayed.id);
      if (verified.id !== displayed.id || verified.legacyId !== displayed.legacyId || !/^\d+$/.test(verified.legacyId)) throw new CartError('invalid');
      if (verified.requiresSellingPlan || verified.requiresComponents) throw new CartError('product_page', verified);
      if (!verified.availableForSale || verified.currentlyNotInStock) throw new CartError('unavailable', verified);
      if (!validQuantity(verified, quantity)) throw new CartError('invalid', verified);
      if (verified.price.amount !== displayed.price.amount || verified.price.currencyCode !== displayed.price.currencyCode || verified.currentlyNotInStock !== displayed.currentlyNotInStock) throw new CartError('price_changed', verified);
      const cart = await this.read();
      if (cart.currency !== verified.price.currencyCode) throw new CartError('cart_changed');
      const existing = cart.items.filter(line => String(line.variant_id) === verified.legacyId).reduce((total, line) => total + line.quantity, 0);
      if (!validQuantity(verified, existing + quantity)) throw new CartError('invalid', verified);
      return this.mutate('add', { items: [{ id: verified.legacyId, quantity }] });
    });
  }
  async change(key: string, quantity: number, expectedQuantity: number): Promise<Cart> {
    if (!key || !Number.isInteger(quantity) || quantity < 0 || quantity > 20) throw new CartError('invalid');
    return this.lock(async () => {
      const cart = await this.read();
      const line = cart.items.find(item => item.key === key);
      if (!line || line.quantity !== expectedQuantity) throw new CartError('cart_changed');
      if (quantity > 0) {
        const verified = await this.verify(`gid://shopify/ProductVariant/${line.variant_id}`);
        if (verified.requiresSellingPlan || verified.requiresComponents) throw new CartError('product_page', verified);
        if (!validQuantity(verified, quantity)) throw new CartError('invalid', verified);
        if (quantity > line.quantity && (!verified.availableForSale || verified.currentlyNotInStock)) throw new CartError('unavailable', verified);
        if (verified.price.currencyCode !== cart.currency) throw new CartError('cart_changed');
      }
      return this.mutate('change', { id: key, quantity });
    });
  }
}
