import { ThemeCart, CartError, localeRoot, validQuantity, type Cart } from './cart.js';
import { analyticsAllowed, loadConsent, visitorId } from './consent.js';
import { styles } from './styles.js';
import { brandVariables, lockPageScroll } from './appearance.js';
import type { AnalyticsEventName, Bootstrap, ChatResponse, Product, Variant } from './types.js';

const copy = {
  en: {
    launch: 'Shopping assistant', subtitle: 'AI assistant · Product information', hello: 'Find your next pick.',
    intro: 'Ask about products, compare options and manage your cart.', placeholder: 'Which product are you looking for?', send: 'Send', close: 'Close assistant',
    cart: 'Your cart', refresh: 'Refresh cart', checkout: 'Continue to checkout', empty: 'Your cart is empty.', you: 'You', assistant: 'Assistant',
    thinking: 'Checking the store…', unavailable: 'The assistant is temporarily unavailable. Please try again.', retry: 'Try again',
    add: 'Add to cart', confirm: 'Confirm add', quantity: 'Quantity', option: 'Product option', view: 'View product', available: 'Available to order', preorder: 'Available to order · currently out of stock', soldout: 'Unavailable',
    added: 'Your cart has been updated.', update: 'Update', remove: 'Remove', checking: 'Checking current price and availability…',
    priceChanged: 'The price or availability changed. Review the updated card and confirm again.',
    cartChanged: 'Your cart changed in another window. Refresh it before continuing.',
    uncertain: 'The result could not be confirmed. Refresh your cart before trying again.',
    rejected: 'Shopify could not complete the request. Refresh your cart to check its current contents.',
    boundary: 'Product information only. For health advice, consult a qualified healthcare professional.',
    privacy: 'Messages are sent to our AI provider to process your request. Avoid personal or health details.', sources: 'Approved information',
    live: 'Price and availability checked with Shopify. Final totals at checkout.', noVariant: 'Open the product page for available options.',
  },
  el: {
    launch: 'Βοηθός αγορών', subtitle: 'AI βοηθός · Πληροφορίες προϊόντων', hello: 'Βρες αυτό που ψάχνεις.',
    intro: 'Ρώτησε για προϊόντα, σύγκρινε επιλογές και διαχειρίσου το καλάθι σου.', placeholder: 'Ποιο προϊόν αναζητάς;', send: 'Αποστολή', close: 'Κλείσιμο βοηθού',
    cart: 'Το καλάθι σου', refresh: 'Ανανέωση καλαθιού', checkout: 'Συνέχεια στην ολοκλήρωση', empty: 'Το καλάθι σου είναι άδειο.', you: 'Εσύ', assistant: 'Βοηθός',
    thinking: 'Ελέγχω το κατάστημα…', unavailable: 'Ο βοηθός δεν είναι διαθέσιμος προσωρινά. Δοκίμασε ξανά.', retry: 'Νέα προσπάθεια',
    add: 'Προσθήκη στο καλάθι', confirm: 'Επιβεβαίωση προσθήκης', quantity: 'Ποσότητα', option: 'Επιλογή προϊόντος', view: 'Δες το προϊόν', available: 'Διαθέσιμο για παραγγελία', preorder: 'Διαθέσιμο για παραγγελία · χωρίς άμεσο απόθεμα', soldout: 'Μη διαθέσιμο',
    added: 'Το καλάθι σου ενημερώθηκε.', update: 'Ενημέρωση', remove: 'Αφαίρεση', checking: 'Ελέγχω την τρέχουσα τιμή και διαθεσιμότητα…',
    priceChanged: 'Η τιμή ή η διαθεσιμότητα άλλαξε. Έλεγξε την ενημερωμένη κάρτα και επιβεβαίωσε ξανά.',
    cartChanged: 'Το καλάθι σου άλλαξε σε άλλο παράθυρο. Ανανέωσέ το πριν συνεχίσεις.',
    uncertain: 'Δεν επιβεβαιώθηκε το αποτέλεσμα. Ανανέωσε το καλάθι σου πριν δοκιμάσεις ξανά.',
    rejected: 'Το Shopify δεν ολοκλήρωσε το αίτημα. Ανανέωσε το καλάθι για να ελέγξεις το περιεχόμενό του.',
    boundary: 'Μόνο πληροφορίες προϊόντων. Για θέματα υγείας, συμβουλέψου επαγγελματία υγείας.',
    privacy: 'Τα μηνύματα αποστέλλονται στον πάροχο AI για επεξεργασία. Απόφυγε προσωπικά δεδομένα ή στοιχεία υγείας.', sources: 'Εγκεκριμένες πληροφορίες',
    live: 'Τιμή και διαθεσιμότητα από Shopify. Το τελικό σύνολο εμφανίζεται στην ολοκλήρωση.', noVariant: 'Δες τη σελίδα του προϊόντος για διαθέσιμες επιλογές.',
  },
} as const;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(text: string, action: () => void | Promise<void>, className?: string): HTMLButtonElement {
  const element = node('button', text, className);
  element.type = 'button';
  element.addEventListener('click', () => { void action(); });
  return element;
}

function productUrl(value: string): string | undefined {
  try {
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin || !/\/(?:products)\/[a-z0-9-]+\/?$/i.test(url.pathname)) return undefined;
    return url.href;
  } catch { return undefined; }
}

class SalesAssistant {
  private readonly shadow: ShadowRoot;
  private readonly locale: string;
  private readonly country: string;
  private readonly root: string;
  private readonly endpoint: string;
  private readonly t: typeof copy.en | typeof copy.el;
  private readonly cart: ThemeCart;
  private readonly launcher: HTMLButtonElement;
  private readonly dialog = node('dialog');
  private readonly log = node('div', undefined, 'scroll');
  private readonly status = node('p', '', 'status');
  private readonly input = node('textarea');
  private readonly send: HTMLButtonElement;
  private readonly title = node('h1');
  private session?: Bootstrap;
  private bootstrapPromise?: Promise<void>;
  private consent = false;
  private generation = 0;
  private chatPending = false;
  private started = false;
  private exposed = false;
  private openTracked = false;
  private readonly analyticsRequests = new Set<AbortController>();
  private cartView?: HTMLElement;
  private built = false;
  private restoreScroll?: () => void;

  constructor(private readonly host: HTMLElement) {
    this.locale = host.dataset.locale || 'en';
    this.country = host.dataset.country || 'GR';
    this.root = localeRoot(host.dataset.root || window.Shopify?.routes?.root || '/');
    this.endpoint = host.dataset.endpoint || '/apps/sales-agent';
    if (!/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?apps\/[a-z0-9-]+$/.test(this.endpoint)) throw new Error('Invalid assistant endpoint');
    this.t = this.locale.toLowerCase().startsWith('el') ? copy.el : copy.en;
    this.shadow = host.attachShadow({ mode: 'open' });
    for (const [name, value] of Object.entries(brandVariables({ header: host.dataset.colorHeader, surface: host.dataset.colorSurface, accent: host.dataset.colorAccent }))) host.style.setProperty(name, value);
    this.cart = new ThemeCart(this.root, async id => {
      await this.ensureSession();
      const result = await this.post<{ variant: Variant; requiresSellingPlan?: boolean }>('/variants/verify', { token: this.session!.token, variantId: id, country: this.country, locale: this.locale });
      return { ...result.variant, requiresSellingPlan: result.requiresSellingPlan };
    });
    this.launcher = button(this.t.launch, () => this.open(), 'launcher');
    this.launcher.prepend(node('span', undefined, 'dot'));
    this.launcher.hidden = true;
    this.launcher.setAttribute('aria-haspopup', 'dialog');
    this.launcher.setAttribute('aria-expanded', 'false');
    this.send = button(this.t.send, () => this.chat(), 'primary');
    this.shadow.append(node('style', styles), this.launcher);
    document.addEventListener('visitorConsentCollected', () => { if (this.host.isConnected) void this.onConsentChanged(); });
    void this.initialize();
  }

  private build(): void {
    if (this.built) return;
    this.built = true;
    const shell = node('div', undefined, 'shell');
    const header = node('header');
    const heading = node('div');
    this.title.id = 'sales-assistant-title';
    if (!this.title.textContent) this.title.textContent = this.t.launch;
    heading.append(this.title, node('p', this.t.subtitle));
    const close = button('×', () => this.dialog.close());
    close.setAttribute('aria-label', this.t.close);
    header.append(heading, close);
    this.dialog.setAttribute('aria-labelledby', this.title.id);
    this.dialog.addEventListener('close', () => {
      this.restoreScroll?.(); this.restoreScroll = undefined;
      this.launcher.setAttribute('aria-expanded', 'false'); this.launcher.focus({ preventScroll: true });
    });
    const intro = node('div', undefined, 'intro');
    intro.append(node('strong', this.t.hello), node('p', this.t.intro));
    this.log.setAttribute('role', 'log');
    this.log.setAttribute('aria-live', 'polite');
    this.log.setAttribute('aria-relevant', 'additions');
    this.log.setAttribute('aria-label', this.t.launch);
    const toolbar = node('div', undefined, 'toolbar');
    toolbar.append(button(this.t.cart, () => this.showCart()), button(this.t.refresh, () => this.showCart()));
    this.status.setAttribute('role', 'status');
    const composer = node('form', undefined, 'composer');
    this.input.placeholder = this.t.placeholder;
    this.input.setAttribute('aria-label', this.t.placeholder);
    this.input.maxLength = 1_500;
    this.input.rows = 1;
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void this.chat(); }
    });
    composer.addEventListener('submit', event => { event.preventDefault(); void this.chat(); });
    composer.append(this.input, this.send);
    const privacy = node('p', `${this.t.boundary} ${this.t.privacy}`, 'footnote');
    shell.append(header, intro, this.log, toolbar, this.status, composer, privacy);
    this.dialog.append(shell);
    this.shadow.append(this.dialog);
  }

  private async post<T>(path: string, body: unknown, controller?: AbortController): Promise<T> {
    const response = await fetch(`${this.endpoint}${path}`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
      signal: controller ? AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      if (response.status === 401) this.session = undefined;
      throw new Error('Assistant request unavailable');
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private async initialize(): Promise<void> {
    await loadConsent();
    this.consent = analyticsAllowed();
    try { await this.ensureSession(); } catch { this.launcher.hidden = false; }
  }

  private async onConsentChanged(): Promise<void> {
    const allowed = analyticsAllowed();
    if (allowed === this.consent) return;
    const previousToken = this.session?.token;
    this.consent = allowed;
    this.generation++;
    this.session = undefined;
    this.bootstrapPromise = undefined;
    this.exposed = false;
    this.started = false;
    this.openTracked = false;
    for (const controller of this.analyticsRequests) controller.abort();
    this.analyticsRequests.clear();
    try { visitorId(false, window.localStorage); } catch { /* Storage may be disabled. */ }
    if (!allowed && previousToken) {
      try { await this.post('/consent', { token: previousToken, analyticsConsent: false }); } catch { /* Tracking remains stopped in this page. */ }
    }
    try { await this.ensureSession(); } catch { this.status.textContent = this.t.unavailable; }
  }

  private async ensureSession(): Promise<void> {
    if (this.session) return;
    if (this.bootstrapPromise) return this.bootstrapPromise;
    const generation = this.generation;
    this.bootstrapPromise = (async () => {
      let id: string | undefined;
      try { id = visitorId(this.consent, window.localStorage); } catch { /* No persisted analytics identity. */ }
      const session = await this.post<Bootstrap>('/bootstrap', {
        ...(id ? { visitorId: id } : {}), analyticsConsent: this.consent && !!id, country: this.country, locale: this.locale,
      });
      if (generation !== this.generation) return;
      this.session = session;
      this.title.textContent = typeof session.brand === 'string' ? session.brand : session.brand.name;
      const shown = session.enabled && session.assignment !== 'control';
      this.launcher.hidden = !shown;
      if (!shown && this.dialog.open) this.dialog.close();
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
    } catch { /* Tracking failure must not block shopping. */ }
  }

  private async track(name: AnalyticsEventName, detail: { productId?: string; variantId?: string; quantity?: number } = {}): Promise<void> {
    const session = this.session;
    if (!session || !this.consent || !analyticsAllowed() || session.assignment === 'untracked') return;
    const controller = new AbortController();
    this.analyticsRequests.add(controller);
    try { await this.post('/events', { token: session.token, events: [{ id: crypto.randomUUID(), name, ...detail }] }, controller); } catch { /* No queue, message content, or retry persistence. */ }
    finally { this.analyticsRequests.delete(controller); }
  }

  private async open(): Promise<void> {
    this.build();
    this.launcher.disabled = true;
    try {
      await this.ensureSession();
      if (!this.session?.enabled || this.session.assignment === 'control') return;
      this.showModal();
      this.launcher.setAttribute('aria-expanded', 'true');
      this.input.focus();
      if (!this.openTracked) { this.openTracked = true; void this.track('assistant_open'); }
    } catch {
      this.showModal();
      this.status.textContent = this.t.unavailable;
      this.input.focus();
    } finally { this.launcher.disabled = false; }
  }

  private showModal(): void {
    if (this.dialog.open) return;
    this.dialog.showModal();
    this.restoreScroll = lockPageScroll();
  }

  private message(text: string, shopper = false): void {
    const message = node('div', undefined, `message ${shopper ? 'shopper' : 'assistant'}`);
    message.append(node('span', shopper ? this.t.you : this.t.assistant, 'speaker'), document.createTextNode(text));
    this.log.append(message);
    this.log.scrollTop = this.log.scrollHeight;
  }

  private async chat(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.chatPending) return;
    this.chatPending = true;
    this.send.disabled = true;
    this.status.textContent = this.t.thinking;
    try {
      await this.ensureSession();
      const session = this.session;
      if (!session?.enabled || session.assignment === 'control') return;
      this.input.value = '';
      this.message(text, true);
      if (!this.started) { this.started = true; void this.track('conversation_started'); }
      const generation = this.generation;
      const response = await this.post<ChatResponse>('/chat', { token: session.token, message: text, country: this.country, locale: this.locale });
      if (generation !== this.generation) return;
      this.message(response.text);
      const cards = node('div', undefined, 'cards');
      for (const product of response.products.slice(0, 6)) {
        cards.append(this.productCard(product, response.pendingAction));
        void this.track('recommendation_shown', { productId: product.id });
      }
      if (cards.children.length) this.log.append(cards);
      if (response.facts.length) {
        const sources = node('details', undefined, 'sources');
        sources.append(node('summary', this.t.sources));
        for (const fact of response.facts.slice(0, 12)) sources.append(node('p', `${fact.text} — ${fact.source}`));
        this.log.append(sources);
      }
      this.status.textContent = '';
      this.log.scrollTop = this.log.scrollHeight;
    } catch { this.status.textContent = this.t.unavailable; }
    finally { this.chatPending = false; this.send.disabled = false; this.input.focus(); }
  }

  private money(amount: string | number, currency: string): string {
    const number = Number(amount);
    if (!Number.isFinite(number)) return '—';
    try { return new Intl.NumberFormat(this.locale, { style: 'currency', currency }).format(number); } catch { return `${number} ${currency}`; }
  }

  private productCard(product: Product, proposal?: ChatResponse['pendingAction']): HTMLElement {
    const card = node('article', undefined, 'card');
    const top = node('div', undefined, 'card-top');
    if (product.imageUrl) {
      try {
        const url = new URL(product.imageUrl);
        if (url.protocol === 'https:') {
          const image = node('img'); image.src = url.href; image.alt = ''; image.loading = 'lazy'; image.width = 76; image.height = 76;
          top.append(image);
        }
      } catch { /* Invalid media is omitted. */ }
    }
    top.append(node('h3', product.title));
    card.append(top);
    const url = productUrl(product.url);
    if (url) {
      const link = node('a', this.t.view); link.href = url;
      link.addEventListener('click', () => { void this.track('product_clicked', { productId: product.id }); });
      card.append(link);
    }
    if (product.requiresSellingPlan) { card.append(node('p', this.t.noVariant)); return card; }
    let selected = product.variants.find(variant => variant.id === proposal?.variantId) || product.variants.find(variant => variant.availableForSale && !variant.currentlyNotInStock && !variant.requiresComponents) || product.variants[0];
    if (!selected) { card.append(node('p', this.t.noVariant)); return card; }
    const select = node('select');
    select.setAttribute('aria-label', `${this.t.option}: ${product.title}`);
    for (const variant of product.variants) { const option = node('option', variant.title); option.value = variant.id; option.selected = variant.id === selected.id; select.append(option); }
    const price = node('p', undefined, 'price');
    const availability = node('p', undefined, 'availability');
    const quantity = node('input'); quantity.type = 'number'; quantity.min = '1'; quantity.max = '20'; quantity.step = '1';
    quantity.value = selected.id === proposal?.variantId && Number.isInteger(proposal.quantity) && validQuantity(selected, proposal.quantity) ? String(proposal.quantity) : String(selected.quantityRule?.minimum ?? 1);
    quantity.setAttribute('aria-label', `${this.t.quantity}: ${product.title}`);
    const add = button(selected.id === proposal?.variantId ? this.t.confirm : this.t.add, async () => {
      if (!selected || !quantity.reportValidity()) return;
      add.disabled = true; select.disabled = true; quantity.disabled = true;
      this.status.textContent = this.t.checking;
      try {
        const amount = Number(quantity.value);
        const result = await this.cart.add(selected, amount);
        this.renderCart(result);
        this.status.textContent = this.t.added;
        void this.track('add_to_cart', { productId: product.id, variantId: selected.id, quantity: amount });
        this.cartChanged(result);
      } catch (error) {
        if (error instanceof CartError && error.variant && error.variant.id === selected.id) {
          selected = error.variant;
          const index = product.variants.findIndex(variant => variant.id === selected!.id);
          if (index !== -1) product.variants[index] = selected;
        }
        this.cartError(error);
      } finally { select.disabled = false; quantity.disabled = false; renderVariant(); }
    }, 'primary');
    const renderVariant = () => {
      if (!selected) return;
      price.textContent = this.money(selected.price.amount, selected.price.currencyCode);
      quantity.min = String(selected.quantityRule?.minimum ?? 1);
      quantity.max = String(Math.min(selected.quantityRule?.maximum ?? 20, 20));
      quantity.step = String(selected.quantityRule?.increment ?? 1);
      const pageOnly = selected.requiresComponents || selected.requiresSellingPlan || (selected.quantityRule?.minimum ?? 1) > 20;
      availability.textContent = pageOnly ? this.t.noVariant : selected.availableForSale && !selected.currentlyNotInStock ? this.t.available : this.t.soldout;
      add.disabled = !selected.availableForSale || selected.currentlyNotInStock || !!pageOnly;
    };
    select.addEventListener('change', () => { selected = product.variants.find(variant => variant.id === select.value); quantity.value = String(selected?.quantityRule?.minimum ?? 1); renderVariant(); });
    const row = node('div', undefined, 'row'); row.append(quantity, add);
    card.append(select, price, availability, row, node('p', this.t.live, 'availability'));
    renderVariant();
    return card;
  }

  private cartError(error: unknown): void {
    const code = error instanceof CartError ? error.code : 'uncertain';
    this.status.textContent = code === 'price_changed' ? this.t.priceChanged : code === 'product_page' || code === 'invalid' ? this.t.noVariant : code === 'unavailable' ? this.t.soldout : code === 'cart_changed' ? this.t.cartChanged : code === 'rejected' ? this.t.rejected : this.t.uncertain;
  }

  private cartChanged(cart: Cart): void {
    // Themes can subscribe to this documented integration event without exposing cart tokens.
    document.dispatchEvent(new CustomEvent('sales-agent:cart-updated', { detail: { itemCount: cart.item_count } }));
  }

  private async showCart(): Promise<void> {
    try { this.renderCart(await this.cart.refresh()); this.status.textContent = ''; }
    catch (error) { this.cartError(error); }
  }

  private renderCart(cart: Cart): void {
    this.cartView?.remove();
    const view = node('section', undefined, 'cart');
    view.append(node('h2', this.t.cart));
    if (!cart.items.length) view.append(node('p', this.t.empty));
    for (const line of cart.items) {
      const item = node('div', undefined, 'cart-line');
      item.append(node('p', `${line.title} · ${this.money(line.final_line_price / 100, cart.currency)}`));
      const quantity = node('input'); quantity.type = 'number'; quantity.min = '0'; quantity.max = '20'; quantity.step = '1'; quantity.value = String(line.quantity);
      quantity.setAttribute('aria-label', `${this.t.quantity}: ${line.title}`);
      const change = async (amount: number) => {
        if (amount !== 0 && !quantity.reportValidity()) return;
        update.disabled = true; remove.disabled = true;
        try {
          const result = await this.cart.change(line.key, amount, line.quantity);
          this.renderCart(result); this.status.textContent = this.t.added; this.cartChanged(result);
          void this.track('cart_updated', { variantId: `gid://shopify/ProductVariant/${line.variant_id}`, quantity: amount });
        } catch (error) { this.cartError(error); } finally { update.disabled = false; remove.disabled = false; }
      };
      const update = button(this.t.update, () => change(Number(quantity.value)));
      const remove = button(this.t.remove, () => change(0));
      const row = node('div', undefined, 'row'); row.append(quantity, update, remove); item.append(row); view.append(item);
    }
    if (cart.items.length) {
      view.append(node('strong', this.money(cart.total_price / 100, cart.currency)));
      const checkout = node('a', this.t.checkout, 'cart-link'); checkout.href = `${this.root}checkout`; view.append(checkout);
    }
    this.cartView = view; this.log.append(view); this.log.scrollTop = this.log.scrollHeight;
  }
}

function mount(): void {
  const host = document.querySelector<HTMLElement>('[data-sales-agent]');
  if (!host || host.shadowRoot) return;
  try { new SalesAssistant(host); } catch { /* A failed embed must not interrupt the storefront. */ }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
document.addEventListener('shopify:section:load', mount);
