import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TavusPilot, type AvatarSession, type PilotCall, type PilotOptions } from './tavus.js';
import { avatarModuleUrl } from './module-url.js';

const sdk = vi.hoisted(() => ({ createCallObject: vi.fn() }));
vi.mock('@daily-co/daily-js', () => ({ default: sdk }));

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const listeners = new Map<string, () => void>();
  const localTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
  const remoteTrack = { readyState: 'live', kind: 'video', stop: vi.fn() } as unknown as MediaStreamTrack;
  const call: PilotCall = {
    on: vi.fn((event, callback) => { listeners.set(event, callback); }),
    participants: vi.fn(() => ({ local: { local: true, tracks: { audio: { persistentTrack: localTrack } } }, replica: { local: false, tracks: { video: { persistentTrack: remoteTrack } } } })),
    join: vi.fn().mockResolvedValue({}), setLocalAudio: vi.fn(), setLocalVideo: vi.fn(), sendAppMessage: vi.fn(), leave: vi.fn().mockResolvedValue(undefined), destroy: vi.fn().mockResolvedValue(undefined),
  };
  const session: AvatarSession = { sessionId: 'session-id', conversationId: 'provider-id', conversationUrl: 'https://trial.daily.co/private-room', meetingToken: 'private-meeting-token', expiresAt: new Date(Date.now() + 180_000).toISOString() };
  const post = vi.fn<(path: string, body?: unknown, controller?: AbortController) => Promise<unknown>>(async path => path === '/avatar/start' ? session : path === '/avatar/result' ? { sequence: 0, ended: false } : undefined);
  const onState = vi.fn(), onResult = vi.fn(), onTracks = vi.fn(), onMicrophone = vi.fn();
  const options: PilotOptions = { token: 'widget-token', maxDurationSeconds: 180, post: post as PilotOptions['post'], onState, onResult, onTracks, onMicrophone, createCall: () => call };
  return { pilot: new TavusPilot(options), options, call, post, listeners, session, onState, onResult, onTracks, onMicrophone, localTrack, remoteTrack };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('private Tavus transport', () => {
  it('does nothing before explicit start and keeps microphone and camera off when joining', async () => {
    const f = fixture();
    expect(f.post).not.toHaveBeenCalled();
    await f.pilot.start('');
    expect(f.post).not.toHaveBeenCalled();
    sdk.createCallObject.mockReturnValue(f.call);
    const pilot = new TavusPilot({ ...f.options, createCall: undefined });
    await pilot.start('private-code');
    expect(sdk.createCallObject).toHaveBeenCalledWith(expect.objectContaining({ videoSource: false, startVideoOff: true, startAudioOff: true, dailyConfig: expect.objectContaining({ alwaysIncludeCamInPermissionPrompt: false, useDevicePreferenceCookies: false }) }));
    expect(f.call.join).toHaveBeenCalledWith({ url: f.session.conversationUrl, token: f.session.meetingToken, startVideoOff: true, startAudioOff: true });
    expect(f.call.setLocalAudio).not.toHaveBeenCalledWith(true);
    expect(f.onTracks).toHaveBeenCalledWith([f.remoteTrack]);
    pilot.toggleMicrophone();
    expect(f.call.setLocalAudio).toHaveBeenLastCalledWith(true);
    await pilot.stop();
    expect(f.localTrack.stop).toHaveBeenCalled();
    expect(f.remoteTrack.stop).not.toHaveBeenCalled();
  });

  it('routes typed input through the full conversation and never subscribes to unverified provider transcripts', async () => {
    const f = fixture(); await f.pilot.start('private-code');
    expect(f.pilot.sendText('  Προϊόντα  ')).toBe(true);
    expect(f.call.sendAppMessage).toHaveBeenLastCalledWith({ message_type: 'conversation', event_type: 'conversation.respond', conversation_id: 'provider-id', properties: { text: 'Προϊόντα' } }, '*');
    expect(f.listeners.has('app-message')).toBe(false);
    expect(f.pilot.sendText('x'.repeat(1501))).toBe(false);
    await f.pilot.stop();
    expect(f.pilot.sendText('later')).toBe(false);
  });

  it('cleans up a paid session arriving after cancellation without joining it', async () => {
    const f = fixture(); const pending = deferred<AvatarSession>();
    f.post.mockImplementationOnce(() => pending.promise);
    const starting = f.pilot.start('private-code');
    await f.pilot.stop();
    pending.resolve(f.session); await starting;
    expect(f.call.join).not.toHaveBeenCalled();
    expect(f.call.destroy).toHaveBeenCalledTimes(1);
    expect(f.post).toHaveBeenCalledWith('/avatar/end', { token: 'widget-token', sessionId: 'session-id' });
    expect(f.pilot.state).toBe('idle');
  });

  it('destroys a pending join on stop and ignores its late completion', async () => {
    const f = fixture(); const joining = deferred<unknown>();
    vi.mocked(f.call.join).mockReturnValue(joining.promise);
    const starting = f.pilot.start('private-code');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.call.join).toHaveBeenCalledTimes(1);
    await f.pilot.stop();
    joining.resolve({}); await starting;
    expect(f.pilot.state).toBe('idle');
    expect(f.onState).not.toHaveBeenCalledWith('active');
    expect(f.call.destroy).toHaveBeenCalledTimes(1);
    expect(f.post.mock.calls.filter(call => call[0] === '/avatar/result')).toHaveLength(0);
  });

  it('discards checked results received after stop and aborts polling', async () => {
    const f = fixture(); const pending = deferred<unknown>();
    f.post.mockImplementation(async path => path === '/avatar/start' ? f.session : path === '/avatar/result' ? pending.promise : undefined);
    await f.pilot.start('private-code');
    const signal = (f.post.mock.calls.find(call => call[0] === '/avatar/result') as unknown as [string, unknown, AbortController])[2].signal;
    await f.pilot.stop();
    pending.resolve({ sequence: 1, response: { text: 'late', products: [], facts: [] }, ended: false });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(signal.aborted).toBe(true);
    expect(f.onResult).not.toHaveBeenCalled();
    expect(f.post.mock.calls.filter(call => call[0] === '/avatar/result')).toHaveLength(1);
  });

  it('shows each checked result once and enforces the shorter server expiry', async () => {
    const f = fixture(); f.session.expiresAt = new Date(Date.now() + 2_500).toISOString();
    f.post.mockImplementation(async path => path === '/avatar/start' ? f.session : path === '/avatar/result' ? { sequence: 1, ended: false, response: { text: 'Ελεγμένη απάντηση', products: [], facts: [] } } : undefined);
    await f.pilot.start('private-code'); await vi.advanceTimersByTimeAsync(2_600);
    expect(f.onResult).toHaveBeenCalledTimes(1);
    expect(f.pilot.state).toBe('idle');
    expect(f.call.destroy).toHaveBeenCalledTimes(1);
    expect(f.post).toHaveBeenCalledWith('/avatar/end', { token: 'widget-token', sessionId: 'session-id' });
  });

  it.each(['https://attacker.example/room', 'http://trial.daily.co/room', 'https://daily.co.attacker.example/room'])('rejects unexpected meeting origin %s and ends the server session', async conversationUrl => {
    const f = fixture(); f.session.conversationUrl = conversationUrl;
    await f.pilot.start('private-code');
    expect(f.call.join).not.toHaveBeenCalled();
    expect(f.post).toHaveBeenCalledWith('/avatar/end', { token: 'widget-token', sessionId: 'session-id' });
    expect(f.pilot.state).toBe('failed');
  });

  it('stops all media after a provider error and permits a deliberate retry', async () => {
    const f = fixture(); await f.pilot.start('private-code');
    f.listeners.get('error')!(); await vi.advanceTimersByTimeAsync(0);
    expect(f.pilot.state).toBe('failed');
    expect(f.call.setLocalAudio).toHaveBeenLastCalledWith(false);
    expect(f.call.destroy).toHaveBeenCalledTimes(1);
    await f.pilot.start('new-code');
    expect(f.pilot.state).toBe('active');
    await f.pilot.stop();
  });

  it.each([undefined, {}, { sequence: -1, ended: false }, { sequence: 1 }])('fails closed on an invalid poll result %j', async result => {
    const f = fixture();
    f.post.mockImplementation(async path => path === '/avatar/start' ? f.session : path === '/avatar/result' ? result : undefined);
    await f.pilot.start('private-code'); await vi.advanceTimersByTimeAsync(0);
    expect(f.pilot.state).toBe('failed');
    expect(f.call.destroy).toHaveBeenCalledTimes(1);
    expect(f.onResult).not.toHaveBeenCalled();
  });
});

describe('avatar module allowlist', () => {
  it('only accepts the dedicated asset from the same storefront or Shopify CDN', () => {
    expect(avatarModuleUrl('https://cdn.shopify.com/extensions/x/assets/sales-assistant-avatar.js?v=1', 'https://bionera.gr')).toContain('cdn.shopify.com');
    expect(avatarModuleUrl('/assets/sales-assistant-avatar.js', 'https://bionera.gr')).toBe('https://bionera.gr/assets/sales-assistant-avatar.js');
    expect(() => avatarModuleUrl('https://attacker.example/sales-assistant-avatar.js', 'https://bionera.gr')).toThrow();
    expect(() => avatarModuleUrl('https://cdn.shopify.com/other.js', 'https://bionera.gr')).toThrow();
  });
});
