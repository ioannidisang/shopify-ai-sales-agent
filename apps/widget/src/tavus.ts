import DailyImport, { type DailyCallFactory } from '@daily-co/daily-js';
import type { ChatResponse } from './types.js';

// The browser bundle uses Daily's ESM entry; NodeNext sees its legacy CJS package metadata.
const Daily = DailyImport as unknown as DailyCallFactory;

export type PilotState = 'idle' | 'starting' | 'active' | 'stopping' | 'failed';
export type MicrophoneState = 'off' | 'starting' | 'on' | 'failed';
export type PilotEndReason = 'connection' | 'result' | 'duration' | 'server';
const DAILY_FATAL_CODES = ['ejected', 'nbf-room', 'nbf-token', 'exp-room', 'exp-token', 'no-room', 'meeting-full', 'end-of-life', 'not-allowed', 'connection-error'] as const;
const DAILY_FAILURE_STAGES = ['load', 'join', 'reconnect', 'move', 'rtc-connection', 'room-lookup'] as const;
export interface PilotDiagnostic {
  readonly event: 'daily-error' | 'left-meeting' | 'start-failure' | 'send-failure' | 'interrupt-failure';
  readonly code: typeof DAILY_FATAL_CODES[number] | 'unknown';
  readonly stage: typeof DAILY_FAILURE_STAGES[number] | 'unknown';
  readonly elapsedSeconds: number;
  readonly microphone: MicrophoneState;
  readonly checkedSequence: number;
}
export interface AvatarSession {
  sessionId: string;
  conversationId: string;
  conversationUrl: string;
  meetingToken: string;
  expiresAt: string;
}
export interface AvatarResult { sequence: number; response?: ChatResponse; userText?: string; ended: boolean }
type TrackState = { state?: string; persistentTrack?: MediaStreamTrack; track?: MediaStreamTrack };
type Participant = { local?: boolean; tracks?: { video?: TrackState; audio?: TrackState } };
export interface PilotCall {
  on(event: string, callback: (event?: unknown) => void): unknown;
  participants(): Record<string, Participant>;
  join(options: { url: string; token: string; startVideoOff: true; startAudioOff: true }): Promise<unknown>;
  setLocalAudio(enabled: boolean): unknown;
  setLocalVideo(enabled: false): unknown;
  sendAppMessage(message: unknown, recipient: '*'): unknown;
  leave(): Promise<unknown>;
  destroy(): Promise<unknown>;
}
export interface PilotOptions {
  token: string;
  maxDurationSeconds: number;
  post<T>(path: string, body: unknown, controller?: AbortController): Promise<T>;
  onState(state: PilotState): void;
  onResult(result: AvatarResult): void;
  onTracks(tracks: MediaStreamTrack[]): void;
  onMicrophone(enabled: boolean): void;
  onMicrophoneState?(state: MicrophoneState): void;
  /** Fixed reason only: never forward SDK errors, room URLs or media content. */
  onEnd?(reason: PilotEndReason): void;
  /** Ephemeral allowlisted diagnostic; contains no SDK messages or identifiers. */
  onDiagnostic?(diagnostic: PilotDiagnostic): void;
  createCall?: () => PilotCall;
}

/** Media transport only. All displayed answers are obtained from the checked server result. */
export class TavusPilot {
  state: PilotState = 'idle';
  private generation = 0;
  private call?: PilotCall;
  private session?: Pick<AvatarSession, 'sessionId' | 'conversationId'>;
  private timeout?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private pollAbort?: AbortController;
  private sequence = 0;
  private microphone = false;
  private microphoneRequested = false;
  private microphoneState: MicrophoneState = 'off';
  private microphoneTimer?: ReturnType<typeof setTimeout>;
  private stopping?: Promise<void>;
  private startedAt = 0;
  private lastDiagnostic?: PilotDiagnostic;

  constructor(private readonly options: PilotOptions) {}

  get microphonePending(): boolean { return this.microphoneState === 'starting'; }
  get diagnostic(): PilotDiagnostic | undefined { return this.lastDiagnostic; }

  private diagnose(event: PilotDiagnostic['event'], payload?: unknown): void {
    if (this.lastDiagnostic) return;
    let code: PilotDiagnostic['code'] = 'unknown', stage: PilotDiagnostic['stage'] = 'unknown';
    // Never copy unknown strings or nested SDK error data into our diagnostic.
    try {
      const error = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined;
      if (error && typeof error === 'object') {
        const type = (error as { type?: unknown }).type;
        if (typeof type === 'string' && DAILY_FATAL_CODES.includes(type as typeof DAILY_FATAL_CODES[number])) code = type as PilotDiagnostic['code'];
        const details = (error as { details?: unknown }).details;
        if (code === 'connection-error' && details && typeof details === 'object') {
          const on = (details as { on?: unknown }).on;
          if (typeof on === 'string' && DAILY_FAILURE_STAGES.includes(on as typeof DAILY_FAILURE_STAGES[number])) stage = on as PilotDiagnostic['stage'];
        }
      }
    } catch { /* Malformed event data must never prevent call cleanup. */ }
    this.lastDiagnostic = Object.freeze({ event, code, stage,
      elapsedSeconds: Math.max(0, Math.min(180, Math.floor((Date.now() - this.startedAt) / 1_000))),
      microphone: this.microphoneState, checkedSequence: Math.max(0, Math.min(1_000, this.sequence)),
    });
    try { this.options.onDiagnostic?.(this.lastDiagnostic); } catch { /* Diagnostics cannot interfere with cleanup. */ }
  }

  private setMicrophoneState(state: MicrophoneState): void {
    const enabled = state === 'on';
    if (this.microphone !== enabled) { this.microphone = enabled; this.options.onMicrophone(enabled); }
    if (this.microphoneState !== state) { this.microphoneState = state; this.options.onMicrophoneState?.(state); }
  }

  private microphoneFailed(): void {
    clearTimeout(this.microphoneTimer);
    this.microphoneRequested = false;
    this.setMicrophoneState('failed');
    if (this.call) this.muteMicrophone(this.call);
  }

  private muteMicrophone(call: PilotCall): void {
    try { call.setLocalAudio(false); }
    catch {
      // A broken SDK mute must not leave local capture running while the UI
      // reports an inactive microphone. Only local audio belongs to this action.
      try {
        for (const participant of Object.values(call.participants())) {
          if (participant.local) (participant.tracks?.audio?.persistentTrack ?? participant.tracks?.audio?.track)?.stop();
        }
      } catch { /* The participant can disappear during call teardown. */ }
    }
  }

  private updateMicrophone(call: PilotCall): void {
    const audio = Object.values(call.participants()).find(participant => participant.local)?.tracks?.audio;
    const track = audio?.persistentTrack ?? audio?.track;
    const ready = audio?.state === 'playable' && track?.readyState === 'live' && track.enabled !== false && track.muted !== true;
    if (!this.microphoneRequested) {
      // Permission can resolve after cancellation. Never leave that late track live.
      if (ready) this.muteMicrophone(call);
      return;
    }
    if (ready) { clearTimeout(this.microphoneTimer); this.setMicrophoneState('on'); }
    else if (audio?.state === 'blocked' || this.microphoneState === 'on') this.microphoneFailed();
  }

  private setState(state: PilotState): void { this.state = state; this.options.onState(state); }
  private current(generation: number): boolean { return generation === this.generation && this.state !== 'stopping' && this.state !== 'idle' && this.state !== 'failed'; }

  async start(accessCode: string): Promise<void> {
    if (!accessCode.trim() || this.state === 'starting' || this.state === 'active' || this.state === 'stopping') return;
    const generation = ++this.generation;
    this.startedAt = Date.now(); this.lastDiagnostic = undefined;
    this.setState('starting');
    this.sequence = 0;
    try {
      const call = this.options.createCall?.() ?? Daily.createCallObject({
        startVideoOff: true, startAudioOff: true, videoSource: false,
        dailyConfig: { avoidEval: true, alwaysIncludeCamInPermissionPrompt: false, alwaysIncludeMicInPermissionPrompt: false, useDevicePreferenceCookies: false },
      }) as unknown as PilotCall;
      this.call = call;
      const media = () => {
        if (!this.current(generation)) return;
        this.updateMicrophone(call);
        const tracks: MediaStreamTrack[] = [];
        for (const participant of Object.values(call.participants())) {
          if (participant.local) continue;
          for (const kind of ['video', 'audio'] as const) {
            const state = participant.tracks?.[kind];
            const track = state?.persistentTrack ?? state?.track;
            if (track?.readyState === 'live') tracks.push(track);
          }
        }
        this.options.onTracks(tracks);
      };
      for (const event of ['participant-joined', 'participant-updated', 'participant-left', 'track-started', 'track-stopped']) call.on(event, media);
      // Daily camera-error also covers denied/unavailable microphones. It is a
      // recoverable device problem, unlike the fatal call-level error event.
      call.on('camera-error', () => { if (this.current(generation)) this.microphoneFailed(); });
      for (const event of ['error', 'left-meeting'] as const) call.on(event, payload => {
        if (this.current(generation)) {
          this.diagnose(event === 'error' ? 'daily-error' : 'left-meeting', payload);
          void this.stop(true, 'connection');
        }
      });
      const session = await this.options.post<AvatarSession>('/avatar/start', { token: this.options.token, accessCode });
      accessCode = '';
      if (!this.current(generation)) { await this.endSession(session.sessionId); return; }
      this.session = { sessionId: session.sessionId, conversationId: session.conversationId };
      const remaining = Math.min(Date.parse(session.expiresAt) - Date.now(), this.options.maxDurationSeconds * 1_000, 180_000);
      const room = new URL(session.conversationUrl);
      if (room.protocol !== 'https:' || !room.hostname.endsWith('.daily.co') || room.username || room.password || !Number.isFinite(remaining) || remaining <= 0 || !session.meetingToken) throw new Error('Unavailable');
      this.timeout = setTimeout(() => { void this.stop(false, 'duration'); }, remaining);
      await call.join({ url: session.conversationUrl, token: session.meetingToken, startVideoOff: true, startAudioOff: true });
      if (!this.current(generation)) return;
      call.setLocalVideo(false);
      this.setState('active');
      media();
      void this.poll(generation);
    } catch {
      accessCode = '';
      if (this.current(generation)) { this.diagnose('start-failure'); await this.stop(true, 'connection'); }
    }
  }

  sendText(text: string): boolean {
    const trimmed = text.trim();
    if (this.state !== 'active' || !this.call || !this.session || !trimmed || trimmed.length > 1_500) return false;
    try {
      this.interrupt();
      this.call.sendAppMessage({ message_type: 'conversation', event_type: 'conversation.respond', conversation_id: this.session.conversationId, properties: { text: trimmed } }, '*');
      return true;
    } catch { this.diagnose('send-failure'); void this.stop(true, 'connection'); return false; }
  }

  interrupt(): void {
    if (this.state !== 'active' || !this.call || !this.session) return;
    try { this.call.sendAppMessage({ message_type: 'conversation', event_type: 'conversation.interrupt', conversation_id: this.session.conversationId }, '*'); }
    catch { this.diagnose('interrupt-failure'); void this.stop(true, 'connection'); }
  }

  toggleMicrophone(): void {
    if (this.state !== 'active' || !this.call) return;
    clearTimeout(this.microphoneTimer);
    this.microphoneRequested = !this.microphoneRequested;
    this.setMicrophoneState(this.microphoneRequested ? 'starting' : 'off');
    try {
      this.call.setLocalAudio(this.microphoneRequested);
      if (this.microphoneRequested) {
        const generation = this.generation;
        this.microphoneTimer = setTimeout(() => {
          if (this.current(generation) && this.microphonePending) this.microphoneFailed();
        }, 30_000);
        // setLocalAudio returns before the permission/capture flow completes.
        // Only a confirmed live local track may claim that the mic is on.
        this.updateMicrophone(this.call);
      }
    } catch { this.microphoneFailed(); }
  }

  private async poll(generation: number): Promise<void> {
    if (!this.current(generation) || !this.session) return;
    const abort = new AbortController(); this.pollAbort = abort;
    try {
      const result = await this.options.post<AvatarResult>('/avatar/result', { token: this.options.token, sessionId: this.session.sessionId, after: this.sequence }, abort);
      if (!this.current(generation)) return;
      if (!result || !Number.isSafeInteger(result.sequence) || result.sequence < 0 || typeof result.ended !== 'boolean') throw new Error('Unavailable');
      if (Number.isSafeInteger(result.sequence) && result.sequence > this.sequence) {
        this.sequence = result.sequence;
        this.options.onResult(result);
      }
      if (result.ended) { await this.stop(false, 'server'); return; }
      this.pollTimer = setTimeout(() => { void this.poll(generation); }, 1_000);
    } catch { if (this.current(generation)) await this.stop(true, 'result'); }
    finally { if (this.pollAbort === abort) this.pollAbort = undefined; }
  }

  private async endSession(sessionId: string): Promise<void> {
    try { await this.options.post('/avatar/end', { token: this.options.token, sessionId }); } catch { /* Server duration limit still applies. */ }
  }

  stop(failed = false, reason?: PilotEndReason): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.state === 'idle' || this.state === 'failed') return Promise.resolve();
    ++this.generation;
    this.setState('stopping');
    clearTimeout(this.timeout); clearTimeout(this.pollTimer); clearTimeout(this.microphoneTimer);
    this.pollAbort?.abort(); this.pollAbort = undefined;
    const call = this.call; this.call = undefined;
    const session = this.session; this.session = undefined;
    this.microphoneRequested = false; this.setMicrophoneState('off'); this.options.onMicrophone(false); this.options.onTracks([]);
    // Mute and stop tracks synchronously, including on pagehide and during a pending join.
    if (call) {
      try { call.setLocalAudio(false); call.setLocalVideo(false); } catch { /* Call may already be gone. */ }
      try { for (const participant of Object.values(call.participants())) if (participant.local) for (const state of Object.values(participant.tracks ?? {})) (state?.persistentTrack ?? state?.track)?.stop(); } catch { /* Best effort cleanup. */ }
    }
    this.stopping = (async () => {
      await Promise.allSettled([
        (async () => { if (call) { try { await call.leave(); } finally { await call.destroy(); } } })(),
        session ? this.endSession(session.sessionId) : Promise.resolve(),
      ]);
      this.setState(failed ? 'failed' : 'idle');
      if (reason) this.options.onEnd?.(reason);
      this.stopping = undefined;
    })();
    return this.stopping;
  }
}

export function createTavusPilot(options: PilotOptions): TavusPilot { return new TavusPilot(options); }
