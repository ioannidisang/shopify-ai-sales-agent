import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../apps/widget/src/index.js';
import type { WidgetConnection } from '../apps/widget/src/connection.js';
import type { PilotOptions, PilotState } from '../apps/widget/src/tavus.js';

const provider = vi.hoisted(() => ({ createTavusPilot: vi.fn() }));
const presentation = vi.hoisted(() => ({ createGreenscreenRenderer: vi.fn() }));
vi.mock('../apps/widget/src/tavus.js', () => provider);
vi.mock('../apps/widget/src/greenscreen.js', () => presentation);
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
  srcObject: SyntheticMediaStream | null = null;
  paused = true;
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });
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

class SyntheticMediaStream {
  constructor(private readonly tracks: MediaStreamTrack[]) {}
  getTracks(): MediaStreamTrack[] { return this.tracks; }
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
  vi.stubGlobal('MediaStream', SyntheticMediaStream);
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

beforeEach(() => { provider.createTavusPilot.mockReset(); presentation.createGreenscreenRenderer.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('private avatar launch lifecycle', () => {
  it('activates person-only presentation only for the explicit flag and releases it on replacement and end', async () => {
    const f = await fixture();
    Object.assign(f.connection.session.avatar, { background: 'greenscreen' });
    let callbacks!: PilotOptions;
    const pilot = { state: 'active', start: vi.fn(async () => callbacks.onState('active')), stop: vi.fn() };
    provider.createTavusPilot.mockImplementation((options: PilotOptions) => { callbacks = options; return pilot; });
    const first = { dispose: vi.fn() }, second = { dispose: vi.fn() };
    presentation.createGreenscreenRenderer.mockReturnValueOnce(first).mockReturnValueOnce(second);
    f.code.value = 'synthetic-code'; f.start.click();
    await vi.waitFor(() => expect(pilot.start).toHaveBeenCalledOnce());
    const video = f.host.shadowRoot!.find(element => element.tagName === 'video');
    const canvas = f.host.shadowRoot!.find(element => element.className === 'avatar-cutout');
    const tracks = [{ kind: 'video' }, { kind: 'audio' }] as MediaStreamTrack[];
    callbacks.onTracks(tracks);
    expect(canvas.hidden).toBe(true);
    expect(video.hidden).toBe(false);
    expect(presentation.createGreenscreenRenderer).toHaveBeenCalledOnce();
    presentation.createGreenscreenRenderer.mock.calls[0]![2].onReady();
    expect(canvas.hidden).toBe(false);
    expect(video.getAttribute('data-keyed')).toBe('true');
    expect(video.paused).toBe(false);
    callbacks.onTracks(tracks);
    expect(presentation.createGreenscreenRenderer).toHaveBeenCalledOnce();
    callbacks.onTracks([{ kind: 'video' }, tracks[1]!] as MediaStreamTrack[]);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(presentation.createGreenscreenRenderer).toHaveBeenCalledTimes(2);
    expect(canvas.hidden).toBe(true);
    presentation.createGreenscreenRenderer.mock.calls[1]![2].onReady();
    expect(canvas.hidden).toBe(false);
    callbacks.onTracks([]);
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(canvas.hidden).toBe(true);
    expect(video.getAttribute('data-keyed')).toBeNull();
    expect(video.srcObject).toBeNull();
  });

  it('explains background-renderer failure while keeping the original media available', async () => {
    const f = await fixture();
    Object.assign(f.connection.session.avatar, { background: 'greenscreen' });
    let callbacks!: PilotOptions;
    const pilot = { state: 'active', start: vi.fn(async () => callbacks.onState('active')), stop: vi.fn() };
    provider.createTavusPilot.mockImplementation((options: PilotOptions) => { callbacks = options; return pilot; });
    const renderer = { dispose: vi.fn() };
    presentation.createGreenscreenRenderer.mockReturnValue(renderer);
    f.code.value = 'synthetic-code'; f.start.click();
    await vi.waitFor(() => expect(pilot.start).toHaveBeenCalledOnce());
    callbacks.onTracks([{ kind: 'video' }, { kind: 'audio' }] as MediaStreamTrack[]);
    const hooks = presentation.createGreenscreenRenderer.mock.calls[0]![2];
    hooks.onReady(); hooks.onFallback();
    const video = f.host.shadowRoot!.find(element => element.tagName === 'video');
    expect(video.hidden).toBe(false);
    expect(video.getAttribute('data-keyed')).toBeNull();
    expect(video.paused).toBe(false);
    expect(f.host.shadowRoot!.find(element => element.className === 'avatar-cutout').hidden).toBe(true);
    const notice = f.host.shadowRoot!.find(element => element.className === 'avatar-background-status');
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('Προβάλλεται το αρχικό βίντεο');
    expect(pilot.stop).not.toHaveBeenCalled();
    f.dialog.close();
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(notice.hidden).toBe(true);
  });

  it('recovers rejected autoplay explicitly and plays replacement tracks without restarting unchanged media', async () => {
    const f = await fixture();
    let callbacks!: PilotOptions;
    const pilot = { state: 'active', start: vi.fn(async () => callbacks.onState('active')), stop: vi.fn() };
    provider.createTavusPilot.mockImplementation((options: PilotOptions) => { callbacks = options; return pilot; });
    f.code.value = 'synthetic-code'; f.start.click();
    await vi.waitFor(() => expect(pilot.start).toHaveBeenCalledOnce());
    const video = f.host.shadowRoot!.find(element => element.tagName === 'video');
    const play = f.host.shadowRoot!.find(element => element.textContent === 'Αναπαραγωγή ήχου και εικόνας');
    video.play.mockRejectedValueOnce(new Error('Autoplay blocked'));
    const audio = { kind: 'audio' } as MediaStreamTrack;
    const picture = { kind: 'video' } as MediaStreamTrack;
    callbacks.onTracks([picture, audio]);
    expect(presentation.createGreenscreenRenderer).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(play.hidden).toBe(false));
    expect(video.paused).toBe(true);
    expect(video.srcObject?.getTracks()).toEqual([picture, audio]);
    const firstStream = video.srcObject;
    callbacks.onTracks([picture, audio]);
    expect(video.srcObject).toBe(firstStream);
    expect(video.play).toHaveBeenCalledOnce();
    play.click();
    await vi.waitFor(() => expect(play.hidden).toBe(true));
    expect(video.paused).toBe(false);
    const nextAudio = { kind: 'audio' } as MediaStreamTrack;
    callbacks.onTracks([picture, nextAudio]);
    expect(video.srcObject).not.toBe(firstStream);
    expect(video.srcObject?.getTracks()).toEqual([picture, nextAudio]);
    expect(video.play).toHaveBeenCalledTimes(3);
    f.dialog.close();
    expect(video.paused).toBe(true);
    expect(video.srcObject).toBeNull();
  });

  it('interrupts the utterance while leaving media live for later typed and voice replies', async () => {
    const f = await fixture();
    let callbacks!: PilotOptions;
    const pilot = {
      state: 'active', start: vi.fn(async () => callbacks.onState('active')), stop: vi.fn(),
      interrupt: vi.fn(), sendText: vi.fn().mockReturnValue(true),
    };
    provider.createTavusPilot.mockImplementation((options: PilotOptions) => { callbacks = options; return pilot; });
    f.code.value = 'synthetic-code'; f.start.click();
    await vi.waitFor(() => expect(pilot.start).toHaveBeenCalledOnce());
    const video = f.host.shadowRoot!.find(element => element.tagName === 'video');
    const play = f.host.shadowRoot!.find(element => element.textContent === 'Αναπαραγωγή ήχου και εικόνας');
    const interrupt = f.host.shadowRoot!.find(element => element.textContent === 'Σταμάτα την ομιλία');
    const tracks = [{ kind: 'video' }, { kind: 'audio' }] as MediaStreamTrack[];
    callbacks.onTracks(tracks);
    expect(video.paused).toBe(false);
    const stream = video.srcObject;
    interrupt.click();
    expect(pilot.interrupt).toHaveBeenCalledOnce();
    expect(video.pause).not.toHaveBeenCalled();
    expect(play.hidden).toBe(true);
    const input = f.host.shadowRoot!.find(element => element.tagName === 'textarea');
    const send = f.host.shadowRoot!.find(element => element.textContent === 'Αποστολή');
    input.value = 'Synthetic typed question'; send.click();
    await vi.waitFor(() => expect(pilot.sendText).toHaveBeenCalledWith('Synthetic typed question'));
    callbacks.onResult({ sequence: 1, ended: false, userText: 'Synthetic typed question', response: { text: 'Synthetic typed answer', products: [], facts: [] } });
    callbacks.onResult({ sequence: 2, ended: false, userText: 'Synthetic spoken question', response: { text: 'Synthetic spoken answer', products: [], facts: [] } });
    callbacks.onTracks(tracks);
    expect(video.srcObject).toBe(stream);
    expect(video.paused).toBe(false);
    expect(video.play).toHaveBeenCalledOnce();
    expect(video.pause).not.toHaveBeenCalled();
    expect(f.host.shadowRoot!.find(element => element.className === 'avatar-caption').textContent).toBe('Synthetic spoken answer');
    expect(pilot.stop).not.toHaveBeenCalled();
  });

  it('retains categorical disconnect details after cleanup and clears them on close', async () => {
    const f = await fixture();
    let callbacks!: PilotOptions;
    const pilot = { state: 'active' as PilotState, start: vi.fn(async () => callbacks.onState('active')), stop: vi.fn() };
    provider.createTavusPilot.mockImplementation((options: PilotOptions) => { callbacks = options; return pilot; });
    f.code.value = 'synthetic-code'; f.start.click();
    await vi.waitFor(() => expect(pilot.start).toHaveBeenCalledOnce());
    const detail = f.host.shadowRoot!.find(element => element.className === 'avatar-diagnostic');
    expect(detail.hidden).toBe(true);
    callbacks.onDiagnostic?.({ event: 'daily-error', code: 'ejected', stage: 'unknown', elapsedSeconds: 32, microphone: 'on', checkedSequence: 1 });
    callbacks.onState('stopping'); pilot.state = 'failed'; callbacks.onState('failed'); callbacks.onEnd?.('connection');
    expect(detail.hidden).toBe(false);
    expect(detail.open).toBe(false);
    expect(detail.children[1]!.textContent).toBe('daily-error / ejected / unknown · 32s · mic:on · replies:1');
    expect(f.status.textContent).toContain('Η σύνδεση με το πρόσωπο διακόπηκε.');
    f.dialog.close();
    expect(detail.hidden).toBe(true);
    expect(detail.children[1]!.textContent).toBe('');
  });

  it.each(['el', 'en'])('shows confirmed microphone state and recoverable failure in %s', async locale => {
    const f = await fixture(locale);
    let callbacks!: PilotOptions;
    const pilot = { state: 'active', start: vi.fn(async () => callbacks.onState('active')), stop: vi.fn() };
    provider.createTavusPilot.mockImplementation((options: PilotOptions) => { callbacks = options; return pilot; });
    f.code.value = 'synthetic-code'; f.start.click();
    await vi.waitFor(() => expect(pilot.start).toHaveBeenCalledOnce());
    const mic = f.host.shadowRoot!.find(element => element.textContent === (locale === 'el' ? 'Άνοιγμα μικροφώνου' : 'Turn microphone on'));
    callbacks.onMicrophoneState?.('starting');
    expect(mic.getAttribute('aria-pressed')).toBe('false');
    expect(f.status.textContent).toContain(locale === 'el' ? 'Περιμένουμε πρόσβαση' : 'Waiting for microphone');
    expect(mic.textContent).toContain(locale === 'el' ? 'Ακύρωση' : 'Cancel');
    callbacks.onMicrophone(true); callbacks.onMicrophoneState?.('on');
    expect(mic.getAttribute('aria-pressed')).toBe('true');
    expect(f.status.textContent).toContain(locale === 'el' ? 'Μπορείς να μιλήσεις' : 'You can speak');
    callbacks.onMicrophone(false); callbacks.onMicrophoneState?.('failed');
    expect(mic.getAttribute('aria-pressed')).toBe('false');
    expect(f.status.textContent).toContain(locale === 'el' ? 'δεν ενεργοποιήθηκε' : 'could not be activated');
    expect(mic.hidden).toBe(false);
    expect(pilot.stop).not.toHaveBeenCalled();
    expect(f.start.hidden).toBe(true);
  });

  it.each([
    ['duration', 'Η δοκιμή των 3 λεπτών ολοκληρώθηκε.'],
    ['server', 'Η συνεδρία με το πρόσωπο ολοκληρώθηκε.'],
    ['connection', 'Η σύνδεση με το πρόσωπο διακόπηκε.'],
    ['result', 'Δεν παραλήφθηκε η ελεγμένη απάντηση.'],
  ] as const)('keeps an understandable %s end message', async (reason, message) => {
    const f = await fixture();
    let callbacks!: PilotOptions;
    const pilot = { state: 'active' as PilotState, start: vi.fn(async () => callbacks.onState('active')), stop: vi.fn() };
    provider.createTavusPilot.mockImplementation((options: PilotOptions) => { callbacks = options; return pilot; });
    f.code.value = 'synthetic-code'; f.start.click();
    await vi.waitFor(() => expect(pilot.start).toHaveBeenCalledOnce());
    pilot.state = 'idle'; callbacks.onState('idle'); callbacks.onEnd?.(reason);
    expect(f.status.textContent).toContain(message);
    expect(f.start.hidden).toBe(false);
    expect(f.host.shadowRoot!.find(element => element.textContent === 'Αποστολή').disabled).toBe(false);
  });

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
