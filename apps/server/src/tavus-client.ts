import { isIP } from 'node:net';

const API_ORIGIN = 'https://tavusapi.com';
const MAX_RESPONSE_BYTES = 64 * 1024;
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export const TAVUS_MAX_CALL_SECONDS = 180;
export const TAVUS_ABSENT_SECONDS = 30;
export const TAVUS_DIAGNOSTIC_TIMEOUT_MS = 2_000;
export const TAVUS_SHUTDOWN_REASONS = [
  'max_call_duration', 'participant_left_timeout', 'participant_absent_timeout',
  'bot_could_not_join_meeting_it_was_probably_ended', 'daily_room_has_been_deleted',
  'exception_encountered_during_conversation_startup', 'end_conversation_endpoint_hit', 'internal_error',
] as const;
export type TavusShutdownReason = typeof TAVUS_SHUTDOWN_REASONS[number];
export interface TavusConversationDiagnostics { shutdownReason: TavusShutdownReason }

export interface TavusRequestOptions { signal?: AbortSignal }

export interface TavusCreatePalInput extends TavusRequestOptions {
  faceId: string;
  callbackBaseUrl: string;
  callbackSecret: string;
}

export interface TavusCreateConversationInput extends TavusRequestOptions {
  palId: string;
  /** Setup validation only: no avatar joins and the room is returned ended. */
  testMode?: boolean;
}

export interface TavusConversation {
  conversationId: string;
  /** Confidential join material: never log or persist in analytics. */
  conversationUrl: string;
  /** Pass separately to Daily.join; never append to a browser URL. */
  meetingToken: string;
  status: 'active' | 'ended';
}

export interface TavusProvider {
  createPal(input: TavusCreatePalInput): Promise<{ palId: string }>;
  createConversation(input: TavusCreateConversationInput): Promise<TavusConversation>;
  endConversation(conversationId: string, options?: TavusRequestOptions): Promise<void>;
  deleteConversation(conversationId: string, options?: TavusRequestOptions & { hard?: boolean }): Promise<void>;
  deletePal(palId: string, options?: TavusRequestOptions): Promise<void>;
  /** Optional best-effort evidence before deletion; never returns provider text or transcripts. */
  getConversationDiagnostics?(conversationId: string, options?: TavusRequestOptions): Promise<TavusConversationDiagnostics | undefined>;
}

export class TavusUnavailableError extends Error {
  constructor() {
    super('The avatar service is unavailable.');
    this.name = 'TavusUnavailableError';
  }
}

function resourceId(value: unknown): string {
  if (typeof value !== 'string' || !RESOURCE_ID.test(value)) throw new TavusUnavailableError();
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TavusUnavailableError();
  return value as Record<string, unknown>;
}

function shutdownReason(value: unknown): TavusShutdownReason | undefined {
  if (typeof value !== 'string' || value.length > 128) return undefined;
  for (const reason of TAVUS_SHUTDOWN_REASONS) {
    if (value === reason) return reason;
    if (['max_call_duration', 'participant_left_timeout', 'participant_absent_timeout'].includes(reason) && value === `${reason} reached`) return reason;
  }
  if (/^internal error occurred at step [A-Za-z0-9 _-]{1,64}$/.test(value)) return 'internal_error';
  return undefined;
}

function callbackUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port ||
        !url.hostname.includes('.') || isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname) ||
        /\/chat\/completions\/?$/.test(url.pathname) || value !== url.href) throw new Error();
    return url.href.replace(/\/$/, '');
  } catch { throw new TavusUnavailableError(); }
}

function roomUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new TavusUnavailableError();
  try {
    const url = new URL(value);
    // Only the Tavus-hosted Daily domain is documented for this pilot.
    if (url.protocol !== 'https:' || url.hostname !== 'tavus.daily.co' || url.port || url.username ||
        url.password || url.search || url.hash || !/^\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname) ||
        value !== url.href) throw new Error();
    return url.href;
  } catch { throw new TavusUnavailableError(); }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw new TavusUnavailableError();
  if (!response.body) throw new TavusUnavailableError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new TavusUnavailableError();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    // Cancellation is best effort; neither response text nor cancellation errors escape.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Fixed-host, no-retry adapter. Session ownership, budgets and cleanup retries belong to the caller. */
export class TavusClient implements TavusProvider {
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number }) {
    if (!/^[\x21-\x7e]{1,512}$/.test(options.apiKey)) throw new TavusUnavailableError();
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new TavusUnavailableError();
    this.apiKey = options.apiKey;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = timeoutMs;
  }

  async createPal(input: TavusCreatePalInput): Promise<{ palId: string }> {
    const faceId = resourceId(input.faceId);
    const baseUrl = callbackUrl(input.callbackBaseUrl);
    if (!SECRET.test(input.callbackSecret)) throw new TavusUnavailableError();
    const result = object(await this.request('/v2/pals', 'POST', {
      pal_name: 'Private shopping assistant session',
      pipeline_mode: 'full',
      default_face_id: faceId,
      languages: ['el'],
      system_prompt: 'Use only the configured custom LLM for every conversational reply. It supplies the verified shop response. Do not use independent product knowledge or execute actions.',
      greeting: 'Πώς μπορώ να βοηθήσω;',
      dynamic_greeting: false,
      disclosure_type: 'always',
      verbal_disclosure: 'Είμαι ο ψηφιακός βοηθός τεχνητής νοημοσύνης του καταστήματος.',
      visual_disclosure: 'Ψηφιακός βοηθός AI',
      layers: {
        perception: { perception_model: 'off', emotion_recognition: 'limited' },
        stt: { stt_engine: 'tavus-auto' },
        tts: { tts_engine: 'tavus-auto' },
        conversational_flow: {
          turn_detection_model: 'sparrow-2', turn_taking_patience: 'medium',
          pal_interruptibility: 'high', idle_engagement: 'off',
        },
        llm: {
          model: 'shopify-grounded', base_url: baseUrl, api_key: input.callbackSecret,
          speculative_inference: false,
        },
      },
    }, input.signal));
    return { palId: resourceId(result.pal_id) };
  }

  async createConversation(input: TavusCreateConversationInput): Promise<TavusConversation> {
    if (input.testMode !== undefined && typeof input.testMode !== 'boolean') throw new TavusUnavailableError();
    const result = object(await this.request('/v2/conversations', 'POST', {
      pal_id: resourceId(input.palId),
      conversation_name: 'Private shopping assistant trial',
      require_auth: true,
      max_participants: 2,
      policy: 'eu',
      dynamic_greeting: false,
      test_mode: input.testMode ?? false,
      properties: {
        max_call_duration: TAVUS_MAX_CALL_SECONDS,
        participant_left_timeout: TAVUS_ABSENT_SECONDS,
        participant_absent_timeout: TAVUS_ABSENT_SECONDS,
        enable_recording: false,
        auto_start_recording: false,
        enable_closed_captions: true,
        languages: ['el'],
      },
    }, input.signal));
    const conversationId = resourceId(result.conversation_id);
    try {
      const conversationUrl = roomUrl(result.conversation_url);
      if (typeof result.meeting_token !== 'string' || result.meeting_token.length > 8192 || !JWT.test(result.meeting_token) ||
          (result.status !== 'active' && result.status !== 'ended')) throw new TavusUnavailableError();
      return { conversationId, conversationUrl, meetingToken: result.meeting_token, status: result.status };
    } catch {
      // A known allocation with unusable join material must not keep running. Cleanup has
      // its own bounded deadline because the shopper's request may already be cancelled.
      await this.endConversation(conversationId).catch(() => {});
      throw new TavusUnavailableError();
    }
  }

  async endConversation(conversationId: string, options: TavusRequestOptions = {}): Promise<void> {
    await this.request(`/v2/conversations/${resourceId(conversationId)}/end`, 'POST', undefined, options.signal, false);
  }

  async deleteConversation(conversationId: string, options: TavusRequestOptions & { hard?: boolean } = {}): Promise<void> {
    if (options.hard !== undefined && typeof options.hard !== 'boolean') throw new TavusUnavailableError();
    const path = `/v2/conversations/${resourceId(conversationId)}${options.hard === true ? '?hard=true' : ''}`;
    await this.request(path, 'DELETE', undefined, options.signal, false);
  }

  async deletePal(palId: string, options: TavusRequestOptions = {}): Promise<void> {
    await this.request(`/v2/pals/${resourceId(palId)}`, 'DELETE', undefined, options.signal, false);
  }

  async getConversationDiagnostics(conversationId: string, options: TavusRequestOptions = {}): Promise<TavusConversationDiagnostics | undefined> {
    // Retrieval can contain transcripts and join material. Inspect in memory only,
    // reduce immediately to a fixed enum, and never let diagnostics block cleanup.
    const result = object(await this.request(`/v2/conversations/${resourceId(conversationId)}?verbose=true`,
      'GET', undefined, options.signal, true, TAVUS_DIAGNOSTIC_TIMEOUT_MS));
    if (Array.isArray(result.events)) {
      for (const event of result.events.slice(-1_000).reverse()) {
        if (event?.event_type !== 'system.shutdown') continue;
        const reason = shutdownReason(event.properties?.shutdown_reason);
        if (reason) return { shutdownReason: reason };
      }
    }
    const reason = result.status === 'ended' ? shutdownReason(result.shutdown_reason) : undefined;
    return reason ? { shutdownReason: reason } : undefined;
  }

  private async request(path: string, method: 'GET' | 'POST' | 'DELETE', body: unknown, signal?: AbortSignal, json = true, timeoutMs = this.timeoutMs): Promise<unknown> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timeout = setTimeout(cancel, Math.min(this.timeoutMs, timeoutMs));
    timeout.unref();
    signal?.addEventListener('abort', cancel, { once: true });
    let stopWaiting = () => {};
    try {
      if (signal?.aborted) controller.abort();
      controller.signal.throwIfAborted();
      const cancelled = new Promise<never>((_resolve, reject) => {
        const listener = () => reject(new TavusUnavailableError());
        stopWaiting = () => controller.signal.removeEventListener('abort', listener);
        controller.signal.addEventListener('abort', listener, { once: true });
      });
      const operation = async () => {
        const response = await this.fetcher(`${API_ORIGIN}${path}`, {
          method, redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        // A retry after a partially completed cleanup may address an already removed
        // resource. Only cleanup operations treat absence as success; creates never do.
        if (!json && response.status === 404) {
          void response.body?.cancel().catch(() => {});
          return undefined;
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new TavusUnavailableError();
        }
        if (!json) {
          void response.body?.cancel().catch(() => {});
          return undefined;
        }
        return boundedJson(response, controller.signal);
      };
      return await Promise.race([operation(), cancelled]);
    } catch { throw new TavusUnavailableError(); }
    finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      stopWaiting();
    }
  }
}
