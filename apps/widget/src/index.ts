import { ThemeCart, CartError, localeRoot, validQuantity, type Cart } from './cart.js';
import type { WidgetConnection, EventDetail } from './connection.js';
import { styles } from './styles.js';
import { lockPageScroll } from './appearance.js';
import { avatarModuleUrl } from './module-url.js';
import { createGreenscreenRenderer, type GreenscreenRenderer } from './greenscreen.js';
import { isUnpublishedTheme } from './preview.js';
import type { AnalyticsEventName, ChatResponse, Product, Variant } from './types.js';
import type { TavusPilot, PilotState, PilotOptions } from './tavus.js';

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
    cookiePreferences: 'Cookie preferences', cookiePreferencesUnavailable: 'Cookie preferences could not be opened. Please try again.',
    live: 'Price and availability checked with Shopify. Final totals at checkout.', noVariant: 'Open the product page for available options.',
    avatar: 'Private trial · AI digital assistant', avatarNotice: 'In this trial, your text and microphone audio are sent to Tavus and our AI provider. Your camera stays off. Avoid personal or health details.',
    avatarCode: 'Private trial access code', avatarStart: 'Start avatar · microphone off', avatarStarting: 'Connecting the digital assistant…', avatarReady: 'Connected. Type below or enable the microphone.', avatarEnd: 'End avatar · continue in text', avatarStopping: 'Ending the trial…', avatarFailed: 'The avatar is unavailable. You can continue in text.',
    avatarCodeRequired: 'Enter the private trial access code before starting.', avatarWaitForReply: 'Wait for the current answer, then start the avatar.',
    avatarMicOn: 'Turn microphone on', avatarMicOff: 'Mute microphone', avatarInterrupt: 'Stop speaking', avatarPlay: 'Play sound and video', avatarCaption: 'Checked answer',
    avatarMicCancel: 'Cancel microphone activation', avatarMicStarting: 'Waiting for microphone access. Allow access in your browser.', avatarMicReady: 'Microphone active. You can speak now.', avatarMicFailed: 'The microphone could not be activated. Check browser permissions or continue typing.',
    avatarConnectionEnded: 'The avatar connection was interrupted. You can continue in text.', avatarResultEnded: 'The checked answer could not be retrieved. The avatar stopped; you can continue in text.', avatarDurationEnded: 'The 3-minute trial has ended. You can continue in text.', avatarServerEnded: 'The avatar session has ended. You can continue in text.',
    avatarDiagnostic: 'Connection details for this trial',
    avatarBackgroundFallback: 'Background removal is unavailable in this browser. Showing the original video; sound and text remain available.',
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
    cookiePreferences: 'Ρυθμίσεις cookies', cookiePreferencesUnavailable: 'Δεν άνοιξαν οι ρυθμίσεις cookies. Δοκίμασε ξανά.',
    live: 'Τιμή και διαθεσιμότητα από Shopify. Το τελικό σύνολο εμφανίζεται στην ολοκλήρωση.', noVariant: 'Δες τη σελίδα του προϊόντος για διαθέσιμες επιλογές.',
    avatar: 'Ιδιωτική δοκιμή · AI ψηφιακός βοηθός', avatarNotice: 'Στη δοκιμή, το κείμενο και ο ήχος του μικροφώνου σου αποστέλλονται στο Tavus και στον πάροχο AI μας. Η κάμερά σου παραμένει κλειστή. Απόφυγε προσωπικά δεδομένα ή στοιχεία υγείας.',
    avatarCode: 'Κωδικός ιδιωτικής δοκιμής', avatarStart: 'Έναρξη προσώπου · μικρόφωνο κλειστό', avatarStarting: 'Συνδέεται ο ψηφιακός βοηθός…', avatarReady: 'Συνδέθηκε. Γράψε παρακάτω ή άνοιξε το μικρόφωνο.', avatarEnd: 'Τέλος προσώπου · συνέχεια γραπτά', avatarStopping: 'Τερματίζεται η δοκιμή…', avatarFailed: 'Το πρόσωπο δεν είναι διαθέσιμο. Μπορείς να συνεχίσεις γραπτά.',
    avatarCodeRequired: 'Συμπλήρωσε τον κωδικό ιδιωτικής δοκιμής για να ξεκινήσεις.', avatarWaitForReply: 'Περίμενε την τρέχουσα απάντηση και μετά ξεκίνησε το πρόσωπο.',
    avatarMicOn: 'Άνοιγμα μικροφώνου', avatarMicOff: 'Σίγαση μικροφώνου', avatarInterrupt: 'Σταμάτα την ομιλία', avatarPlay: 'Αναπαραγωγή ήχου και εικόνας', avatarCaption: 'Ελεγμένη απάντηση',
    avatarMicCancel: 'Ακύρωση ανοίγματος μικροφώνου', avatarMicStarting: 'Περιμένουμε πρόσβαση στο μικρόφωνο. Επίτρεψέ την στον browser.', avatarMicReady: 'Το μικρόφωνο είναι ενεργό. Μπορείς να μιλήσεις.', avatarMicFailed: 'Το μικρόφωνο δεν ενεργοποιήθηκε. Έλεγξε την άδεια στον browser ή συνέχισε γραπτά.',
    avatarConnectionEnded: 'Η σύνδεση με το πρόσωπο διακόπηκε. Μπορείς να συνεχίσεις γραπτά.', avatarResultEnded: 'Δεν παραλήφθηκε η ελεγμένη απάντηση. Το πρόσωπο σταμάτησε· μπορείς να συνεχίσεις γραπτά.', avatarDurationEnded: 'Η δοκιμή των 3 λεπτών ολοκληρώθηκε. Μπορείς να συνεχίσεις γραπτά.', avatarServerEnded: 'Η συνεδρία με το πρόσωπο ολοκληρώθηκε. Μπορείς να συνεχίσεις γραπτά.',
    avatarDiagnostic: 'Στοιχεία σύνδεσης της δοκιμής',
    avatarBackgroundFallback: 'Δεν ήταν δυνατή η αφαίρεση φόντου σε αυτόν τον browser. Προβάλλεται το αρχικό βίντεο· ο ήχος και το κείμενο παραμένουν διαθέσιμα.',
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
  private readonly t: typeof copy.en | typeof copy.el;
  private readonly cart: ThemeCart;
  private readonly launcher: HTMLButtonElement;
  private readonly dialog = node('dialog');
  private readonly log = node('div', undefined, 'scroll');
  private readonly status = node('p', '', 'status');
  private readonly input = node('textarea');
  private readonly send: HTMLButtonElement;
  private readonly title = node('h1');
  private get session() { return this.connection.session; }
  private get generation() { return this.connection.generation; }
  private chatPending = false;
  private started = false;
  private openTracked = false;
  private cartView?: HTMLElement;
  private built = false;
  private restoreScroll?: () => void;
  private cookiePreferences?: HTMLButtonElement;
  private avatarPanel?: HTMLDetailsElement;
  private avatar?: TavusPilot;
  private avatarLoading = false;
  private avatarAttempt = 0;
  private avatarCode?: HTMLInputElement;
  private avatarStart?: HTMLButtonElement;
  private avatarEnd?: HTMLButtonElement;
  private avatarMic?: HTMLButtonElement;
  private avatarInterrupt?: HTMLButtonElement;
  private avatarVideo?: HTMLVideoElement;
  private avatarCanvas?: HTMLCanvasElement;
  private avatarRenderer?: GreenscreenRenderer;
  private avatarBackgroundStatus?: HTMLElement;
  private avatarPlay?: HTMLButtonElement;
  private avatarStatus?: HTMLElement;
  private avatarDiagnostic?: HTMLDetailsElement;
  private avatarDiagnosticText?: HTMLElement;
  private avatarCaption?: HTMLElement;
  private avatarTyped: string[] = [];
  private avatarStopping?: Promise<void>;

  constructor(private readonly host: HTMLElement, private readonly connection: WidgetConnection, launcher: HTMLButtonElement) {
    this.locale = host.dataset.locale || 'en';
    this.country = host.dataset.country || 'GR';
    this.root = localeRoot(host.dataset.root || window.Shopify?.routes?.root || '/');
    this.t = this.locale.toLowerCase().startsWith('el') ? copy.el : copy.en;
    this.shadow = host.shadowRoot!;
    this.cart = new ThemeCart(this.root, async id => {
      await this.ensureSession();
      const result = await this.post<{ variant: Variant; requiresSellingPlan?: boolean }>('/variants/verify', { token: this.session!.token, variantId: id, country: this.country, locale: this.locale });
      return { ...result.variant, requiresSellingPlan: result.requiresSellingPlan };
    });
    this.launcher = launcher;
    this.send = button(this.t.send, () => this.chat(), 'primary');
    this.shadow.replaceChildren(node('style', styles), this.launcher);
    let previousSession = this.session?.conversationId;
    const update = () => {
      const session = this.session;
      if (session?.conversationId !== previousSession) { this.started = false; this.openTracked = false; previousSession = session?.conversationId; void this.stopAvatar(); }
      if (session) this.title.textContent = typeof session.brand === 'string' ? session.brand : session.brand.name;
      if ((!session?.enabled || session.assignment === 'control') && this.dialog.open) this.dialog.close();
      if (this.avatarPanel) this.avatarPanel.hidden = !this.avatarAllowed();
    };
    connection.subscribe(update);
    update();
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
      void this.stopAvatar();
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
    this.cookiePreferences = button(this.t.cookiePreferences, () => this.showCookiePreferences(), 'cookie-preferences');
    this.cookiePreferences.hidden = typeof window.privacyBanner?.showPreferences !== 'function';
    privacy.append(this.cookiePreferences);
    shell.append(header, intro, this.buildAvatar(), this.log, toolbar, this.status, composer, privacy);
    this.dialog.append(shell);
    this.shadow.append(this.dialog);
    window.addEventListener('pagehide', () => { void this.stopAvatar(); });
    document.addEventListener('visibilitychange', () => {
      // Stop media and connection attempts in a background tab, but preserve an
      // unsubmitted code while the merchant switches tabs to prepare the trial.
      const state = this.avatar?.state;
      if (document.hidden && (this.avatarLoading || state === 'starting' || state === 'active' || state === 'stopping')) void this.stopAvatar();
    });
  }

  private avatarAllowed(): boolean {
    return isUnpublishedTheme(window.Shopify?.theme) && !!this.session?.enabled && this.session.assignment !== 'control' && this.session.avatar?.provider === 'tavus' && this.session.avatar.previewOnly === true;
  }

  private buildAvatar(): HTMLDetailsElement {
    const panel = node('details', undefined, 'avatar-panel');
    panel.hidden = !this.avatarAllowed();
    panel.append(node('summary', this.t.avatar), node('p', this.t.avatarNotice, 'avatar-notice'));
    const code = node('input'); code.type = 'password'; code.autocomplete = 'off'; code.maxLength = 160; code.placeholder = this.t.avatarCode; code.setAttribute('aria-label', this.t.avatarCode);
    const start = button(this.t.avatarStart, () => this.startAvatar(), 'primary');
    const video = node('video'); video.playsInline = true; video.autoplay = false; video.setAttribute('aria-label', this.t.avatar); video.hidden = true;
    const canvas = node('canvas'); canvas.className = 'avatar-cutout'; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', this.t.avatar); canvas.hidden = true;
    const backgroundStatus = node('p', '', 'avatar-background-status'); backgroundStatus.setAttribute('role', 'status'); backgroundStatus.hidden = true;
    const play = button(this.t.avatarPlay, async () => { try { await video.play(); play.hidden = true; } catch { /* Keep the explicit playback option available. */ } }); play.hidden = true;
    const microphone = button(this.t.avatarMicOn, () => this.avatar?.toggleMicrophone()); microphone.hidden = true; microphone.setAttribute('aria-pressed', 'false');
    // Interrupt the provider's current utterance, keeping the live media stream
    // playing so the next spoken or typed turn is audible without a second action.
    const interrupt = button(this.t.avatarInterrupt, () => this.avatar?.interrupt()); interrupt.hidden = true;
    const end = button(this.t.avatarEnd, () => this.stopAvatar()); end.hidden = true;
    const controls = node('div', undefined, 'avatar-controls'); controls.append(microphone, interrupt, end);
    const status = node('p', '', 'avatar-status'); status.setAttribute('role', 'status');
    const diagnostic = node('details', undefined, 'avatar-diagnostic'); diagnostic.hidden = true;
    const diagnosticText = node('p');
    diagnostic.append(node('summary', this.t.avatarDiagnostic), diagnosticText);
    code.addEventListener('input', () => {
      if (code.getAttribute('aria-invalid') !== 'true') return;
      code.removeAttribute('aria-invalid');
      status.textContent = '';
    });
    const caption = node('p', '', 'avatar-caption'); caption.hidden = true; caption.setAttribute('aria-label', this.t.avatarCaption);
    panel.append(code, start, video, canvas, backgroundStatus, play, caption, controls, status, diagnostic);
    this.avatarDiagnostic = diagnostic; this.avatarDiagnosticText = diagnosticText;
    this.avatarCanvas = canvas; this.avatarBackgroundStatus = backgroundStatus;
    this.avatarPanel = panel; this.avatarCode = code; this.avatarStart = start; this.avatarVideo = video; this.avatarPlay = play; this.avatarMic = microphone; this.avatarInterrupt = interrupt; this.avatarEnd = end; this.avatarStatus = status; this.avatarCaption = caption;
    return panel;
  }

  private avatarState(state: PilotState): void {
    if (state === 'starting' && this.avatarDiagnostic) {
      this.avatarDiagnostic.hidden = true; this.avatarDiagnostic.open = false;
      if (this.avatarDiagnosticText) this.avatarDiagnosticText.textContent = '';
    }
    const active = state === 'active';
    const busy = state === 'starting' || state === 'stopping';
    if (this.avatarStart) { this.avatarStart.hidden = active || busy; this.avatarStart.disabled = busy; }
    if (this.avatarCode) this.avatarCode.hidden = active || busy;
    if (this.avatarMic) {
      this.avatarMic.hidden = !active;
      if (!active) { this.avatarMic.textContent = this.t.avatarMicOn; this.avatarMic.setAttribute('aria-pressed', 'false'); }
    }
    if (this.avatarInterrupt) this.avatarInterrupt.hidden = !active;
    if (this.avatarEnd) { this.avatarEnd.hidden = !active && state !== 'starting'; this.avatarEnd.disabled = state === 'stopping'; }
    if (this.avatarVideo) this.avatarVideo.hidden = !active;
    if (this.avatarCanvas) this.avatarCanvas.hidden = !active || this.avatarVideo?.getAttribute('data-keyed') !== 'true';
    if (this.avatarStatus) this.avatarStatus.textContent = state === 'starting' ? this.t.avatarStarting : state === 'active' ? this.t.avatarReady : state === 'stopping' ? this.t.avatarStopping : state === 'failed' ? this.t.avatarFailed : '';
    this.send.disabled = state === 'starting' || this.chatPending;
    if (!active && this.avatarPlay) this.avatarPlay.hidden = true;
    if (!active && this.avatarCaption) { this.avatarCaption.textContent = ''; this.avatarCaption.hidden = true; }
  }

  private async startAvatar(): Promise<void> {
    if (!this.dialog.open || this.avatarLoading) return;
    if (!this.avatarAllowed()) { this.avatarState('failed'); return; }
    if (this.avatarStopping) { if (this.avatarStatus) this.avatarStatus.textContent = this.t.avatarStopping; return; }
    if (this.chatPending) { if (this.avatarStatus) this.avatarStatus.textContent = this.t.avatarWaitForReply; return; }
    if (!this.avatarCode?.value.trim()) {
      if (this.avatarStatus) this.avatarStatus.textContent = this.t.avatarCodeRequired;
      this.avatarCode?.setAttribute('aria-invalid', 'true');
      this.avatarCode?.focus();
      return;
    }
    this.avatarCode.removeAttribute('aria-invalid');
    let accessCode = this.avatarCode.value.trim(); this.avatarCode.value = '';
    const generation = this.generation;
    const attempt = ++this.avatarAttempt;
    this.avatarTyped = [];
    this.avatarLoading = true; this.avatarState('starting');
    try {
      const moduleUrl = avatarModuleUrl(this.host.dataset.avatarUrl || '', location.origin);
      const module = await import(moduleUrl) as { createTavusPilot(options: PilotOptions): TavusPilot };
      if (attempt !== this.avatarAttempt || generation !== this.generation || !this.dialog.open || !this.avatarAllowed()) return;
      const current = () => attempt === this.avatarAttempt && generation === this.generation && this.dialog.open;
      this.avatar = module.createTavusPilot({
        token: this.session!.token, maxDurationSeconds: this.session!.avatar!.maxDurationSeconds,
        post: (path, body, controller) => this.connection.post(path, body, controller),
        onState: state => { if (current()) this.avatarState(state); },
        onMicrophone: enabled => {
          if (!current() || !this.avatarMic) return;
          this.avatarMic.textContent = enabled ? this.t.avatarMicOff : this.t.avatarMicOn;
          this.avatarMic.setAttribute('aria-pressed', String(enabled));
        },
        onMicrophoneState: state => {
          if (!current() || this.avatar?.state !== 'active') return;
          if (this.avatarMic) this.avatarMic.textContent = state === 'starting' ? this.t.avatarMicCancel : state === 'on' ? this.t.avatarMicOff : this.t.avatarMicOn;
          if (this.avatarStatus) this.avatarStatus.textContent = state === 'starting' ? this.t.avatarMicStarting : state === 'on' ? this.t.avatarMicReady : state === 'failed' ? this.t.avatarMicFailed : this.t.avatarReady;
        },
        onDiagnostic: diagnostic => {
          if (!current() || !this.avatarDiagnostic || !this.avatarDiagnosticText) return;
          // The transport supplies only fixed enums and bounded counters, never
          // raw SDK errors, room addresses, credentials or conversation text.
          this.avatarDiagnosticText.textContent = `${diagnostic.event} / ${diagnostic.code} / ${diagnostic.stage} · ${diagnostic.elapsedSeconds}s · mic:${diagnostic.microphone} · replies:${diagnostic.checkedSequence}`;
          this.avatarDiagnostic.hidden = false;
        },
        onEnd: reason => {
          if (!current() || !this.avatarStatus) return;
          this.avatarStatus.textContent = reason === 'duration' ? this.t.avatarDurationEnded : reason === 'server' ? this.t.avatarServerEnded : reason === 'result' ? this.t.avatarResultEnded : this.t.avatarConnectionEnded;
        },
        onTracks: tracks => {
          if (!current() || !this.avatarVideo) return;
          const video = this.avatarVideo;
          if (!tracks.length) { this.clearAvatarRenderer(); video.pause(); video.srcObject = null; return; }
          const previous = video.srcObject instanceof MediaStream ? video.srcObject.getTracks() : [];
          if (tracks.length === previous.length && tracks.every(track => previous.includes(track))) return;
          this.clearAvatarRenderer();
          video.srcObject = new MediaStream(tracks);
          if (this.session?.avatar?.background === 'greenscreen' && this.avatarCanvas && tracks.some(track => track.kind === 'video')) {
            this.avatarRenderer = createGreenscreenRenderer(video, this.avatarCanvas, {
              onReady: () => {
                if (!current()) return;
                video.setAttribute('data-keyed', 'true'); video.setAttribute('aria-hidden', 'true');
                if (this.avatarCanvas) this.avatarCanvas.hidden = this.avatar?.state !== 'active';
              },
              onFallback: () => {
                if (!current()) return;
                video.removeAttribute('data-keyed'); video.removeAttribute('aria-hidden');
                if (this.avatarCanvas) this.avatarCanvas.hidden = true;
                if (this.avatarBackgroundStatus) { this.avatarBackgroundStatus.textContent = this.t.avatarBackgroundFallback; this.avatarBackgroundStatus.hidden = false; }
              },
            });
          }
          void video.play().catch(() => { if (current() && this.avatarPlay) this.avatarPlay.hidden = false; });
        },
        onResult: result => {
          if (!current()) return;
          if (result.userText) {
            const typed = this.avatarTyped.indexOf(result.userText);
            if (typed >= 0) this.avatarTyped.splice(typed, 1); else this.message(result.userText, true);
          }
          if (result.response) {
            if (!this.started) { this.started = true; void this.track('conversation_started'); }
            this.renderResponse(result.response);
            if (this.avatarCaption) { this.avatarCaption.textContent = result.response.text; this.avatarCaption.hidden = false; }
          }
        },
      });
      await this.avatar.start(accessCode);
    } catch { if (attempt === this.avatarAttempt) this.avatarState('failed'); }
    finally { accessCode = ''; if (attempt === this.avatarAttempt) this.avatarLoading = false; }
  }

  private stopAvatar(): Promise<void> {
    if (this.avatarStopping) return this.avatarStopping;
    ++this.avatarAttempt; this.avatarLoading = false; this.avatarTyped = [];
    if (this.avatarDiagnostic) { this.avatarDiagnostic.hidden = true; this.avatarDiagnostic.open = false; }
    if (this.avatarDiagnosticText) this.avatarDiagnosticText.textContent = '';
    const avatar = this.avatar; this.avatar = undefined;
    this.clearAvatarRenderer();
    if (this.avatarCode) { this.avatarCode.value = ''; this.avatarCode.removeAttribute('aria-invalid'); }
    if (this.avatarVideo) { this.avatarVideo.pause(); this.avatarVideo.srcObject = null; }
    if (this.avatarCaption) { this.avatarCaption.textContent = ''; this.avatarCaption.hidden = true; }
    this.avatarState(avatar ? 'stopping' : 'idle');
    this.avatarStopping = (async () => {
      await avatar?.stop();
      this.avatarState('idle');
      this.avatarStopping = undefined;
    })();
    return this.avatarStopping;
  }

  private clearAvatarRenderer(): void {
    this.avatarRenderer?.dispose(); this.avatarRenderer = undefined;
    if (this.avatarCanvas) this.avatarCanvas.hidden = true;
    this.avatarVideo?.removeAttribute('data-keyed'); this.avatarVideo?.removeAttribute('aria-hidden');
    if (this.avatarBackgroundStatus) { this.avatarBackgroundStatus.textContent = ''; this.avatarBackgroundStatus.hidden = true; }
  }

  private post<T>(path: string, body: unknown): Promise<T> { return this.connection.post<T>(path, body); }
  private ensureSession(): Promise<void> { return this.connection.ensureSession(); }
  private track(name: AnalyticsEventName, detail: EventDetail = {}): Promise<void> { return this.connection.track(name, detail); }

  async open(): Promise<void> {
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
    if (this.cookiePreferences) this.cookiePreferences.hidden = typeof window.privacyBanner?.showPreferences !== 'function';
    if (this.dialog.open) return;
    this.dialog.showModal();
    this.restoreScroll = lockPageScroll();
  }

  private async showCookiePreferences(): Promise<void> {
    const banner = window.privacyBanner;
    if (!this.cookiePreferences) return;
    if (typeof banner?.showPreferences !== 'function') { this.cookiePreferences.hidden = true; return; }
    this.cookiePreferences.disabled = true;
    let failed = false;
    try {
      // Release our modal's inert/focus/scroll state before Shopify opens its own UI.
      if (this.dialog.open) {
        const closed = new Promise<void>(resolve => this.dialog.addEventListener('close', () => resolve(), { once: true }));
        this.dialog.close();
        await closed;
      }
      // Only open the merchant's existing first-party preferences. Consent is set
      // exclusively by the shopper interacting with that UI.
      await banner.showPreferences();
    } catch {
      failed = true;
      this.showModal();
      this.launcher.setAttribute('aria-expanded', 'true');
      this.status.textContent = this.t.cookiePreferencesUnavailable;
    } finally {
      this.cookiePreferences.disabled = false;
      if (failed) this.cookiePreferences.focus();
    }
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
      if (this.avatarLoading || this.avatar?.state === 'starting') return;
      if (this.avatar?.state === 'active') {
        if (this.avatar.sendText(text)) {
          this.input.value = ''; this.message(text, true); this.avatarTyped.push(text); this.avatarTyped = this.avatarTyped.slice(-10);
          if (!this.started) { this.started = true; void this.track('conversation_started'); }
        } else this.status.textContent = this.t.avatarFailed;
        return;
      }
      this.input.value = '';
      this.message(text, true);
      if (!this.started) { this.started = true; void this.track('conversation_started'); }
      const generation = this.generation;
      const response = await this.post<ChatResponse>('/chat', { token: session.token, message: text, country: this.country, locale: this.locale });
      if (generation !== this.generation) return;
      this.renderResponse(response);
    } catch { this.status.textContent = this.t.unavailable; }
    finally { this.chatPending = false; this.send.disabled = this.avatarLoading || this.avatar?.state === 'starting'; this.input.focus(); }
  }

  private renderResponse(response: ChatResponse): void {
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

export interface WidgetHandle { open(): Promise<void> }
export function mount(host: HTMLElement, connection: WidgetConnection, launcher: HTMLButtonElement): WidgetHandle {
  return new SalesAssistant(host, connection, launcher);
}
