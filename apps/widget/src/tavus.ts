import DailyImport, { type DailyCallFactory } from '@daily-co/daily-js';
import type { ChatResponse } from './types.js';

// The browser bundle uses Daily's ESM entry; NodeNext sees its legacy CJS package metadata.
const Daily = DailyImport as unknown as DailyCallFactory;

export type PilotState = 'idle' | 'starting' | 'active' | 'stopping' | 'failed';
export interface AvatarSession {
  sessionId: string;
  conversationId: string;
  conversationUrl: string;
  meetingToken: string;
  expiresAt: string;
}
export interface AvatarResult { sequence: number; response?: ChatResponse; userText?: string; ended: boolean }
type Participant = { local?: boolean; tracks?: { video?: { persistentTrack?: MediaStreamTrack; track?: MediaStreamTrack }; audio?: { persistentTrack?: MediaStreamTrack; track?: MediaStreamTrack } } };
export interface PilotCall {
  on(event: string, callback: () => void): unknown;
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
  private stopping?: Promise<void>;

  constructor(private readonly options: PilotOptions) {}

  private setState(state: PilotState): void { this.state = state; this.options.onState(state); }
  private current(generation: number): boolean { return generation === this.generation && this.state !== 'stopping' && this.state !== 'idle' && this.state !== 'failed'; }

  async start(accessCode: string): Promise<void> {
    if (!accessCode.trim() || this.state === 'starting' || this.state === 'active' || this.state === 'stopping') return;
    const generation = ++this.generation;
    this.setState('starting');
    this.sequence = 0;
    try {
      const call = this.options.createCall?.() ?? Daily.createCallObject({
        startVideoOff: true, startAudioOff: true, videoSource: false,
        dailyConfig: { avoidEval: true, alwaysIncludeCamInPermissionPrompt: false, useDevicePreferenceCookies: false },
      }) as unknown as PilotCall;
      this.call = call;
      const media = () => {
        if (!this.current(generation)) return;
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
      for (const event of ['error', 'camera-error', 'left-meeting']) call.on(event, () => {
        if (this.current(generation)) void this.stop(true);
      });
      const session = await this.options.post<AvatarSession>('/avatar/start', { token: this.options.token, accessCode });
      accessCode = '';
      if (!this.current(generation)) { await this.endSession(session.sessionId); return; }
      this.session = { sessionId: session.sessionId, conversationId: session.conversationId };
      const remaining = Math.min(Date.parse(session.expiresAt) - Date.now(), this.options.maxDurationSeconds * 1_000, 180_000);
      const room = new URL(session.conversationUrl);
      if (room.protocol !== 'https:' || !room.hostname.endsWith('.daily.co') || room.username || room.password || !Number.isFinite(remaining) || remaining <= 0 || !session.meetingToken) throw new Error('Unavailable');
      this.timeout = setTimeout(() => { void this.stop(); }, remaining);
      await call.join({ url: session.conversationUrl, token: session.meetingToken, startVideoOff: true, startAudioOff: true });
      if (!this.current(generation)) return;
      call.setLocalVideo(false);
      this.setState('active');
      media();
      void this.poll(generation);
    } catch {
      accessCode = '';
      if (this.current(generation)) await this.stop(true);
    }
  }

  sendText(text: string): boolean {
    const trimmed = text.trim();
    if (this.state !== 'active' || !this.call || !this.session || !trimmed || trimmed.length > 1_500) return false;
    try {
      this.interrupt();
      this.call.sendAppMessage({ message_type: 'conversation', event_type: 'conversation.respond', conversation_id: this.session.conversationId, properties: { text: trimmed } }, '*');
      return true;
    } catch { void this.stop(true); return false; }
  }

  interrupt(): void {
    if (this.state !== 'active' || !this.call || !this.session) return;
    try { this.call.sendAppMessage({ message_type: 'conversation', event_type: 'conversation.interrupt', conversation_id: this.session.conversationId }, '*'); }
    catch { void this.stop(true); }
  }

  toggleMicrophone(): void {
    if (this.state !== 'active' || !this.call) return;
    try {
      this.microphone = !this.microphone;
      this.call.setLocalAudio(this.microphone);
      this.options.onMicrophone(this.microphone);
    } catch { void this.stop(true); }
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
      if (result.ended) { await this.stop(); return; }
      this.pollTimer = setTimeout(() => { void this.poll(generation); }, 1_000);
    } catch { if (this.current(generation)) await this.stop(true); }
    finally { if (this.pollAbort === abort) this.pollAbort = undefined; }
  }

  private async endSession(sessionId: string): Promise<void> {
    try { await this.options.post('/avatar/end', { token: this.options.token, sessionId }); } catch { /* Server duration limit still applies. */ }
  }

  stop(failed = false): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.state === 'idle' || this.state === 'failed') return Promise.resolve();
    ++this.generation;
    this.setState('stopping');
    clearTimeout(this.timeout); clearTimeout(this.pollTimer);
    this.pollAbort?.abort(); this.pollAbort = undefined;
    const call = this.call; this.call = undefined;
    const session = this.session; this.session = undefined;
    this.microphone = false; this.options.onMicrophone(false); this.options.onTracks([]);
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
      this.stopping = undefined;
    })();
    return this.stopping;
  }
}

export function createTavusPilot(options: PilotOptions): TavusPilot { return new TavusPilot(options); }
