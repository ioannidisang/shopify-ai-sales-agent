import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../apps/widget/src/index.js';
import type { WidgetConnection } from '../apps/widget/src/connection.js';
import type { PilotOptions, PilotState } from '../apps/widget/src/tavus.js';

const provider = vi.hoisted(() => ({ createTavusPilot: vi.fn() }));
vi.mock('../apps/widget/src/tavus.js', () => provider);
vi.mock('../apps/widget/src/module-url.js', () => ({ avatarModuleUrl: () => './tavus.js' }));
vi.mock('../apps/widget/src/appearance.js', () => ({ lockPageScroll: () => () => {} }));

// Minimal DOM events/elements for exercising the real mounted widget. Media and
// layout are covered by the browser fixture; no provider or network is used here.
class Element extends EventTarget {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  textContent = '';
  className = '';
  value = '';
  hidden = false;
  disabled = false;
  open = false;
  shadowRoot?: Element;
  pause = vi.fn();
  focus = vi.fn();
  constructor(readonly tagName: string) { super(); }
  append(...elements: Element[]) { this.children.push(...elements); }
  replaceChildren(...elements: Element[]) { this.children = elements; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  removeAttribute(key: string) { this.attributes.delete(key); }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  find(predicate: (element: Element) => boolean): Element {
    const result = this.all().find(predicate);
    if (!result) throw new Error('Missing fixture element');
    return result;
  }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(locale = 'el') {
  const document = Object.assign(new EventTarget(), {
    hidden: false, createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => Object.assign(new Element('#text'), { textContent: text }),
  });
  const window = Object.assign(new EventTarget(), { Shopify: { theme: { id: 123, role: 'unpublished' } } });
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  vi.stubGlobal('location', { origin: 'https://fixture.example' });
  const host = new Element('div'); host.dataset = { locale }; host.shadowRoot = new Element('shadow');
  const connection = {
    session: { token: 'synthetic-token', conversationId: 'synthetic-conversation', enabled: true, assignment: 'untracked', brand: 'Synthetic', avatar: { provider: 'tavus', previewOnly: true, maxDurationSeconds: 180 } },
    generation: 0, subscribe: vi.fn(), ensureSession: vi.fn().mockResolvedValue(undefined), track: vi.fn().mockResolvedValue(undefined), post: vi.fn(),
  };
  const handle = mount(host as unknown as HTMLElement, connection as unknown as WidgetConnection, new Element('button') as unknown as HTMLButtonElement);
  await handle.open();
  const panel = host.shadowRoot.find(element => element.className === 'avatar-panel');
  const code = panel.find(element => element.tagName === 'input');
  const start = panel.find(element => element.tagName === 'button' && element.className === 'primary');
  const status = panel.find(element => element.className === 'avatar-status');
  const dialog = host.shadowRoot.find(element => element.tagName === 'dialog');
  return { host, connection, document, window, code, start, status, dialog };
}

beforeEach(() => { provider.createTavusPilot.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('private avatar launch lifecycle', () => {
  it.each([
    ['el', 'Συμπλήρωσε τον κωδικό ιδιωτικής δοκιμής για να ξεκινήσεις.'],
    ['en', 'Enter the private trial access code before starting.'],
  ])('explains a missing code in %s without attempting a paid call', async (locale, message) => {
    const f = await fixture(locale);
    f.code.value = '   ';
    f.start.click();
    expect(f.status.textContent).toBe(message);
    expect(f.code.getAttribute('aria-invalid')).toBe('true');
    expect(f.code.focus).toHaveBeenCalledOnce();
    expect(provider.createTavusPilot).not.toHaveBeenCalled();
    expect(f.connection.post).not.toHaveBeenCalled();
    f.code.value = 'synthetic-code'; f.code.dispatchEvent(new Event('input'));
    expect(f.code.getAttribute('aria-invalid')).toBeNull();
    expect(f.status.textContent).toBe('');
  });

  it('retains an unsubmitted code across idle tab switches, but clears it on page exit', async () => {
    const f = await fixture(); f.code.value = 'synthetic-code';
    for (const hidden of [true, false, true, false]) {
      f.document.hidden = hidden; f.document.dispatchEvent(new Event('visibilitychange'));
    }
    expect(f.code.value).toBe('synthetic-code');
    expect(provider.createTavusPilot).not.toHaveBeenCalled();
    f.window.dispatchEvent(new Event('pagehide'));
    expect(f.code.value).toBe('');
  });

  it('clears an unsubmitted code when the shopper closes the assistant', async () => {
    const f = await fixture(); f.code.value = 'synthetic-code';
    f.dialog.close();
    expect(f.code.value).toBe('');
  });

  it.each(['starting', 'active', 'stopping'] as const)('still cancels a %s call on tab hiding and never resumes it automatically', async state => {
    const f = await fixture();
    const pending = deferred<void>();
    const stop = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn(async () => { if (state === 'starting') await pending.promise; });
    provider.createTavusPilot.mockImplementation((options: PilotOptions) => {
      start.mockImplementation(async () => { options.onState(state); if (state === 'starting') await pending.promise; });
      return { start, stop, state };
    });
    f.code.value = 'synthetic-code'; f.start.click();
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start).toHaveBeenCalledWith('synthetic-code');
    expect(f.code.value).toBe('');
    f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    pending.resolve();
    f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(f.start.hidden).toBe(false));
    expect(start).toHaveBeenCalledOnce();
    expect(f.code.value).toBe('');
  });

  it.each(['idle', 'failed'] as const)('preserves a new code on tab switching after the provider reaches %s', async endedState => {
    const f = await fixture();
    let onState!: PilotOptions['onState'];
    const pilot = {
      state: 'idle' as PilotState,
      start: vi.fn(async () => { pilot.state = 'active'; onState('active'); }),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    provider.createTavusPilot.mockImplementation((options: PilotOptions) => { onState = options.onState; return pilot; });
    f.code.value = 'synthetic-code'; f.start.click();
    await vi.waitFor(() => expect(pilot.start).toHaveBeenCalledOnce());
    pilot.state = endedState; onState(endedState);
    expect(f.code.hidden).toBe(false);
    f.code.value = 'new-synthetic-code';
    f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'));
    f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange'));
    expect(f.code.value).toBe('new-synthetic-code');
    expect(pilot.stop).not.toHaveBeenCalled();
    expect(pilot.start).toHaveBeenCalledOnce();
  });

  it('explains why starting is blocked while a text answer is pending without consuming the code', async () => {
    const f = await fixture();
    const pending = deferred<unknown>(); f.connection.post.mockReturnValue(pending.promise);
    const input = f.host.shadowRoot!.find(element => element.tagName === 'textarea');
    const send = f.host.shadowRoot!.find(element => element.tagName === 'button' && element.textContent === 'Αποστολή');
    input.value = 'Synthetic question'; send.click();
    await vi.waitFor(() => expect(f.connection.post).toHaveBeenCalled());
    f.code.value = 'synthetic-code'; f.start.click();
    expect(f.status.textContent).toBe('Περίμενε την τρέχουσα απάντηση και μετά ξεκίνησε το πρόσωπο.');
    expect(f.code.value).toBe('synthetic-code');
    expect(provider.createTavusPilot).not.toHaveBeenCalled();
    pending.resolve({ text: '', products: [], facts: [] });
    await vi.waitFor(() => expect(send.disabled).toBe(false));
  });
});
