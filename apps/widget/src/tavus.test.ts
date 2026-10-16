import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TavusPilot, type AvatarSession, type PilotCall, type PilotOptions } from './tavus.js';
import { avatarModuleUrl } from './module-url.js';

const sdk = vi.hoisted(() => ({ createCallObject: vi.fn() }));
vi.mock('@daily-co/daily-js', () => ({ default: sdk }));

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const listeners = new Map<string, (event?: unknown) => void>();
  const localTrack = { stop: vi.fn(), readyState: 'live', enabled: true, muted: false } as unknown as MediaStreamTrack;
  const remoteTrack = { readyState: 'live', kind: 'video', stop: vi.fn() } as unknown as MediaStreamTrack;
  const localAudio = { state: 'off', persistentTrack: localTrack };
  const call: PilotCall = {
    on: vi.fn((event, callback) => { listeners.set(event, callback); }),
    participants: vi.fn(() => ({ local: { local: true, tracks: { audio: localAudio } }, replica: { local: false, tracks: { video: { persistentTrack: remoteTrack } } } })),
    join: vi.fn().mockResolvedValue({}), setLocalAudio: vi.fn(), setLocalVideo: vi.fn(), sendAppMessage: vi.fn(), leave: vi.fn().mockResolvedValue(undefined), destroy: vi.fn().mockResolvedValue(undefined),
  };
  const session: AvatarSession = { sessionId: 'session-id', conversationId: 'provider-id', conversationUrl: 'https://trial.daily.co/private-room', meetingToken: 'private-meeting-token', expiresAt: new Date(Date.now() + 180_000).toISOString() };
  const post = vi.fn<(path: string, body?: unknown, controller?: AbortController) => Promise<unknown>>(async path => path === '/avatar/start' ? session : path === '/avatar/result' ? { sequence: 0, ended: false } : undefined);
  const onState = vi.fn(), onResult = vi.fn(), onTracks = vi.fn(), onMicrophone = vi.fn(), onMicrophoneState = vi.fn(), onEnd = vi.fn(), onDiagnostic = vi.fn();
  const options: PilotOptions = { token: 'widget-token', maxDurationSeconds: 180, post: post as PilotOptions['post'], onState, onResult, onTracks, onMicrophone, onMicrophoneState, onEnd, onDiagnostic, createCall: () => call };
  return { pilot: new TavusPilot(options), options, call, post, listeners, session, onState, onResult, onTracks, onMicrophone, onMicrophoneState, onEnd, onDiagnostic, localTrack, localAudio, remoteTrack };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('private Tavus transport', () => {
  it.each([
    [429, 'avatar_daily_limit'], [409, 'avatar_session_busy'], [403, 'avatar_access_denied'], [503, 'avatar_unavailable'],
  ] as const)('reports the safe %s startup reason after cleanup without joining or retrying', async (status, code) => {
    const f = fixture();
    const resetAt = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 + 86_400_000).toISOString();
    // A plain structural value models the independently bundled loader: no instanceof identity.
    f.post.mockRejectedValueOnce({ name: 'AvatarStartRequestError', status, code, resetAt });
    await f.pilot.start('private-code');
    expect(f.pilot.state).toBe('failed');
    expect(f.call.join).not.toHaveBeenCalled();
    expect(f.call.destroy).toHaveBeenCalledOnce();
    expect(f.onDiagnostic).not.toHaveBeenCalled();
    expect(f.onEnd.mock.calls).toEqual([code === 'avatar_daily_limit' ? [code, { resetAt }] : [code]]);
    expect(f.onEnd.mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(f.call.destroy).mock.invocationCallOrder[0]!);
    await vi.advanceTimersByTimeAsync(180_001);
    expect(f.post).toHaveBeenCalledExactlyOnceWith('/avatar/start', { token: 'widget-token', accessCode: 'private-code' });
  });

  it('keeps generic request failures separate from daily limits and SDK connection failures', async () => {
    const f = fixture();
    f.post.mockRejectedValueOnce(new Error('private server error'));
    await f.pilot.start('private-code');
    expect(f.onEnd).toHaveBeenCalledExactlyOnceWith('avatar_unavailable');
    expect(f.onDiagnostic).not.toHaveBeenCalled();
    f.onEnd.mockClear();
    vi.mocked(f.call.join).mockRejectedValueOnce({ name: 'AvatarStartRequestError', status: 409, code: 'avatar_session_busy' });
    await f.pilot.start('private-code');
    expect(f.onEnd).toHaveBeenCalledExactlyOnceWith('connection');
    expect(f.onDiagnostic).toHaveBeenCalledOnce();
  });

  it('does nothing before explicit start and keeps microphone and camera off when joining', async () => {
    const f = fixture();
    expect(f.post).not.toHaveBeenCalled();
    await f.pilot.start('');
    expect(f.post).not.toHaveBeenCalled();
    sdk.createCallObject.mockReturnValue(f.call);
    const pilot = new TavusPilot({ ...f.options, createCall: undefined });
    await pilot.start('private-code');
    expect(sdk.createCallObject).toHaveBeenCalledWith(expect.objectContaining({ videoSource: false, startVideoOff: true, startAudioOff: true, dailyConfig: expect.objectContaining({ alwaysIncludeCamInPermissionPrompt: false, alwaysIncludeMicInPermissionPrompt: false, useDevicePreferenceCookies: false }) }));
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

  it('reports microphone readiness only after permission produces a playable live track', async () => {
    const f = fixture(); await f.pilot.start('private-code');
    f.pilot.toggleMicrophone();
    expect(f.onMicrophone).not.toHaveBeenCalledWith(true);
    expect(f.onMicrophoneState).toHaveBeenLastCalledWith('starting');
    expect(f.pilot.microphonePending).toBe(true);
    f.localAudio.state = 'loading'; f.listeners.get('participant-updated')!();
    expect(f.onMicrophone).not.toHaveBeenCalledWith(true);
    f.localAudio.state = 'playable'; f.listeners.get('participant-updated')!();
    expect(f.onMicrophone).toHaveBeenLastCalledWith(true);
    expect(f.onMicrophoneState).toHaveBeenLastCalledWith('on');
    expect(f.pilot.microphonePending).toBe(false);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.onMicrophoneState).toHaveBeenLastCalledWith('on');
    await f.pilot.stop();
  });

  it('allows canceling microphone permission and mutes a track arriving after cancellation', async () => {
    const f = fixture(); await f.pilot.start('private-code');
    f.pilot.toggleMicrophone(); f.pilot.toggleMicrophone();
    expect(f.onMicrophoneState).toHaveBeenLastCalledWith('off');
    f.localAudio.state = 'playable'; f.listeners.get('track-started')!();
    expect(f.call.setLocalAudio).toHaveBeenLastCalledWith(false);
    expect(f.onMicrophone).not.toHaveBeenCalledWith(true);
    expect(f.pilot.state).toBe('active');
    await f.pilot.stop();
  });

  it('keeps video and checked text usable after a microphone permission/device error and permits deliberate retry', async () => {
    const f = fixture(); await f.pilot.start('private-code');
    f.pilot.toggleMicrophone(); f.listeners.get('camera-error')!();
    expect(f.onMicrophoneState).toHaveBeenLastCalledWith('failed');
    expect(f.call.setLocalAudio).toHaveBeenLastCalledWith(false);
    expect(f.pilot.state).toBe('active');
    expect(f.call.destroy).not.toHaveBeenCalled();
    expect(f.onEnd).not.toHaveBeenCalled();
    expect(f.pilot.sendText('Synthetic question')).toBe(true);
    f.pilot.toggleMicrophone(); f.localAudio.state = 'playable'; f.listeners.get('participant-updated')!();
    expect(f.onMicrophoneState).toHaveBeenLastCalledWith('on');
    await f.pilot.stop();
  });

  it('shows device failure if capture never becomes live, without ending the avatar', async () => {
    const f = fixture(); await f.pilot.start('private-code');
    f.pilot.toggleMicrophone();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(f.onMicrophoneState).toHaveBeenLastCalledWith('failed');
    expect(f.call.setLocalAudio).toHaveBeenLastCalledWith(false);
    expect(f.pilot.state).toBe('active');
    expect(f.call.destroy).not.toHaveBeenCalled();
    await f.pilot.stop();
  });

  it('handles a synchronous microphone failure without ending the call or exposing the SDK error', async () => {
    const f = fixture(); await f.pilot.start('private-code');
    vi.mocked(f.call.setLocalAudio).mockImplementationOnce(() => { throw new Error('sensitive provider detail'); });
    f.pilot.toggleMicrophone();
    expect(f.onMicrophoneState).toHaveBeenLastCalledWith('failed');
    expect(f.pilot.state).toBe('active');
    expect(f.onEnd).not.toHaveBeenCalled();
    await f.pilot.stop();
  });

  it.each(['device-error', 'late-canceled-track'] as const)('stops only local audio if SDK muting fails after %s', async failure => {
    const f = fixture(); await f.pilot.start('private-code'); f.pilot.toggleMicrophone();
    if (failure === 'late-canceled-track') f.pilot.toggleMicrophone();
    vi.mocked(f.call.setLocalAudio).mockImplementation(() => { throw new Error('sensitive provider detail'); });
    f.localAudio.state = 'playable';
    f.listeners.get(failure === 'device-error' ? 'camera-error' : 'track-started')!();
    expect(f.localTrack.stop).toHaveBeenCalledExactlyOnceWith();
    expect(f.remoteTrack.stop).not.toHaveBeenCalled();
    expect(f.call.destroy).not.toHaveBeenCalled();
    expect(f.onMicrophone).not.toHaveBeenCalledWith(true);
    expect(f.pilot.state).toBe('active');
    await f.pilot.stop();
  });

  it('ignores late permission/media events after the call ends', async () => {
    const f = fixture(); await f.pilot.start('private-code'); f.pilot.toggleMicrophone();
    await f.pilot.stop(); f.onMicrophoneState.mockClear(); f.onMicrophone.mockClear();
    f.localAudio.state = 'playable'; f.listeners.get('participant-updated')!(); f.listeners.get('camera-error')!();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.onMicrophoneState).not.toHaveBeenCalled();
    expect(f.onMicrophone).not.toHaveBeenCalled();
    expect(f.pilot.state).toBe('idle');
  });

  it('stops claiming microphone readiness when the live local track is interrupted', async () => {
    const f = fixture(); await f.pilot.start('private-code'); f.pilot.toggleMicrophone();
    f.localAudio.state = 'playable'; f.listeners.get('participant-updated')!();
    f.localAudio.state = 'interrupted'; f.listeners.get('track-stopped')!();
    expect(f.onMicrophone).toHaveBeenLastCalledWith(false);
    expect(f.onMicrophoneState).toHaveBeenLastCalledWith('failed');
    expect(f.pilot.state).toBe('active');
    await f.pilot.stop();
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
    expect(f.onEnd).not.toHaveBeenCalled();
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
    expect(f.onEnd).not.toHaveBeenCalled();
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
    expect(f.onEnd).toHaveBeenCalledExactlyOnceWith('duration');
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
    expect(f.onEnd).toHaveBeenCalledExactlyOnceWith('connection');
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
    expect(f.onEnd).toHaveBeenCalledExactlyOnceWith('result');
  });

  it('distinguishes a server-ended session from a connection failure after cleanup completes', async () => {
    const f = fixture();
    f.post.mockImplementation(async path => path === '/avatar/start' ? f.session : path === '/avatar/result' ? { sequence: 0, ended: true } : undefined);
    await f.pilot.start('private-code'); await vi.advanceTimersByTimeAsync(0);
    expect(f.pilot.state).toBe('idle');
    expect(f.onEnd).toHaveBeenCalledExactlyOnceWith('server');
    expect(f.onEnd.mock.invocationCallOrder[0]).toBeGreaterThan(f.onState.mock.invocationCallOrder.at(-1)!);
  });

  it('retains only the first safe fatal diagnostic when Daily immediately emits left-meeting', async () => {
    const f = fixture();
    f.post.mockImplementation(async path => path === '/avatar/start' ? f.session : path === '/avatar/result' ? { sequence: 7, ended: false } : undefined);
    await f.pilot.start('private-code');
    f.pilot.toggleMicrophone(); f.localAudio.state = 'playable'; f.listeners.get('participant-updated')!();
    await vi.advanceTimersByTimeAsync(1_500);
    f.listeners.get('error')!({ errorMsg: 'secret-token', error: { type: 'connection-error', msg: 'private-message', details: { on: 'rtc-connection', uri: 'https://private.example/secret', sourceError: { token: 'secret' } } } });
    f.listeners.get('left-meeting')!();
    await vi.advanceTimersByTimeAsync(0);
    const expected = { event: 'daily-error', code: 'connection-error', stage: 'rtc-connection', elapsedSeconds: 1, microphone: 'on', checkedSequence: 7 };
    expect(f.onDiagnostic).toHaveBeenCalledExactlyOnceWith(expected);
    expect(f.pilot.diagnostic).toEqual(expected);
    expect(Object.isFrozen(f.pilot.diagnostic)).toBe(true);
    expect(f.pilot.state).toBe('failed');
    expect(f.call.destroy).toHaveBeenCalledOnce();
    await f.pilot.start('new-code');
    expect(f.pilot.diagnostic).toBeUndefined();
    await f.pilot.stop();
  });

  it.each([
    { error: { type: 'https://private.example/secret', details: { on: 'rtc-connection' } } },
    { error: { type: ['ejected'], details: { on: 'private-stage' } } },
    { errorMsg: 'private-message', error: 'private-token' },
    undefined,
  ])('never copies unknown or secret-bearing SDK values into terminal diagnostics', async payload => {
    const f = fixture(); await f.pilot.start('private-code');
    f.listeners.get('error')!(payload); await vi.advanceTimersByTimeAsync(0);
    expect(f.pilot.diagnostic).toEqual({ event: 'daily-error', code: 'unknown', stage: 'unknown', elapsedSeconds: 0, microphone: 'off', checkedSequence: 0 });
    expect(f.call.destroy).toHaveBeenCalledOnce();
  });

  it('ignores unknown connection stages and bounds diagnostic counters even after clock jumps', async () => {
    const f = fixture();
    f.post.mockImplementation(async path => path === '/avatar/start' ? f.session : path === '/avatar/result' ? { sequence: Number.MAX_SAFE_INTEGER, ended: false } : undefined);
    await f.pilot.start('private-code'); await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 1_000_000);
    f.listeners.get('error')!({ error: { type: 'connection-error', details: { on: 'secret-authenticated-url' } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pilot.diagnostic).toEqual({ event: 'daily-error', code: 'connection-error', stage: 'unknown', elapsedSeconds: 180, microphone: 'off', checkedSequence: 1000 });
  });

  it('cleans up when diagnostic consumers throw and retains provider ejection as the category', async () => {
    const f = fixture(); f.onDiagnostic.mockImplementation(() => { throw new Error('consumer failed'); });
    await f.pilot.start('private-code');
    f.listeners.get('error')!({ error: { type: 'ejected', details: { on: 'join' } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pilot.diagnostic).toMatchObject({ code: 'ejected', stage: 'unknown' });
    expect(f.pilot.state).toBe('failed');
    expect(f.call.destroy).toHaveBeenCalledOnce();
    expect(f.post).toHaveBeenCalledWith('/avatar/end', { token: 'widget-token', sessionId: 'session-id' });
  });

  it.each(['start-failure', 'send-failure', 'interrupt-failure', 'left-meeting'] as const)('distinguishes %s without retaining exception messages', async event => {
    const f = fixture(); const fail = () => { throw new Error('sensitive exception'); };
    if (event === 'start-failure') vi.mocked(f.call.join).mockImplementationOnce(fail);
    await f.pilot.start('private-code');
    if (event === 'send-failure') {
      vi.mocked(f.call.sendAppMessage).mockImplementationOnce(() => {}).mockImplementationOnce(fail);
      expect(f.pilot.sendText('Synthetic question')).toBe(false);
    } else if (event === 'interrupt-failure') {
      vi.mocked(f.call.sendAppMessage).mockImplementationOnce(fail); f.pilot.interrupt();
    } else if (event === 'left-meeting') f.listeners.get('left-meeting')!();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pilot.diagnostic).toEqual({ event, code: 'unknown', stage: 'unknown', elapsedSeconds: 0, microphone: 'off', checkedSequence: 0 });
    expect(f.call.destroy).toHaveBeenCalledOnce();
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
