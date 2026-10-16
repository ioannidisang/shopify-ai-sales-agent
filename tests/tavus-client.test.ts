import { describe, expect, it, vi } from 'vitest';
import { TavusAllocationCleanupError, TavusClient, TavusUnavailableError } from '../apps/server/src/tavus-client.js';

const pal = {
  faceId: 'r123face', callbackBaseUrl: 'https://shop.example.com/api/tavus/llm',
  callbackSecret: 'a'.repeat(43),
};
const conversation = {
  conversation_id: 'c123trial', conversation_url: 'https://tavus.daily.co/c123trial',
  meeting_token: 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE5OTk5OTk5OTl9.signature', status: 'active',
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
const client = (fetcher: typeof fetch, timeoutMs?: number) => new TavusClient({ apiKey: 'test-only-key', fetch: fetcher, timeoutMs });
const body = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, index = 0) => JSON.parse(String(fetcher.mock.calls[index]![1]?.body));

describe('Tavus private full-pipeline adapter', () => {
  it('binds a new PAL to the verified callback, with Greek and all independent intelligence paths disabled', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ pal_id: 'p123trial', api_key: 'not-for-return', other: 'ignored' }));
    expect(await client(fetcher).createPal(pal)).toEqual({ palId: 'p123trial' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![0]).toBe('https://tavusapi.com/v2/pals');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-only-key' },
    });
    const payload = body(fetcher);
    expect(payload).toMatchObject({
      pipeline_mode: 'full', default_face_id: pal.faceId, languages: ['el'], dynamic_greeting: false,
      disclosure_type: 'always', verbal_disclosure: expect.stringContaining('τεχνητής νοημοσύνης'),
      layers: {
        perception: { perception_model: 'off', emotion_recognition: 'limited' },
        stt: { stt_engine: 'tavus-auto' }, tts: { tts_engine: 'tavus-auto' },
        llm: { model: 'shopify-grounded', base_url: pal.callbackBaseUrl, api_key: pal.callbackSecret, speculative_inference: false },
        conversational_flow: { idle_engagement: 'off', pal_interruptibility: 'high' },
      },
    });
    expect(Object.keys(payload.layers.llm).sort()).toEqual(['api_key', 'base_url', 'model', 'speculative_inference']);
    for (const forbidden of ['tools', 'document_ids', 'document_tags', 'participant_tags', 'memory_stores', 'objectives_id', 'guardrail_ids', 'guardrail_tags']) {
      expect(payload).not.toHaveProperty(forbidden);
    }
    expect(payload.layers).not.toHaveProperty('mcp');
    expect(payload.layers).not.toHaveProperty('conferencing');
  });

  it('creates a private short room with recordings disabled and no persistent-memory tags', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ ...conversation, private_debug: 'ignored' }));
    expect(await client(fetcher).createConversation({ palId: 'p123trial' })).toEqual({
      conversationId: conversation.conversation_id, conversationUrl: conversation.conversation_url,
      meetingToken: conversation.meeting_token, status: 'active',
    });
    expect(fetcher.mock.calls[0]![0]).toBe('https://tavusapi.com/v2/conversations');
    expect(body(fetcher)).toEqual({
      pal_id: 'p123trial', conversation_name: 'Private shopping assistant trial', require_auth: true,
      max_participants: 2, policy: 'eu', dynamic_greeting: false, test_mode: false,
      properties: { max_call_duration: 180, participant_left_timeout: 30, participant_absent_timeout: 30,
        enable_recording: false, auto_start_recording: false, enable_closed_captions: true, languages: ['el'] },
    });
  });

  it('supports no-avatar setup validation and returns ended status without pretending it is a live test', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ ...conversation, status: 'ended' }));
    expect((await client(fetcher).createConversation({ palId: 'p123trial', testMode: true })).status).toBe('ended');
    expect(body(fetcher).test_mode).toBe(true);
  });

  it('keeps normal end, deletion and explicit hard deletion separate', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 204 }));
    const adapter = client(fetcher);
    await adapter.endConversation('c123trial');
    await adapter.deleteConversation('c123trial');
    await adapter.deleteConversation('c123trial', { hard: true });
    await adapter.deletePal('p123trial');
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://tavusapi.com/v2/conversations/c123trial/end', 'POST'],
      ['https://tavusapi.com/v2/conversations/c123trial', 'DELETE'],
      ['https://tavusapi.com/v2/conversations/c123trial?hard=true', 'DELETE'],
      ['https://tavusapi.com/v2/pals/p123trial', 'DELETE'],
    ]);
    expect(fetcher.mock.calls.every(([, init]) => init?.body === undefined && init?.redirect === 'error')).toBe(true);
  });

  it('reduces verbose shutdown diagnostics to a fixed reason without returning provider data', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({
      ...conversation, status: 'ended',
      events: [
        { event_type: 'application.transcription_ready', properties: { transcript: [{ content: 'private shopper text' }] } },
        { event_type: 'system.shutdown', properties: { shutdown_reason: 'participant_absent_timeout reached', private: 'secret' } },
      ],
    }));
    expect(await client(fetcher).getConversationDiagnostics('c123trial')).toEqual({ shutdownReason: 'participant_absent_timeout' });
    expect(fetcher.mock.calls[0]![0]).toBe('https://tavusapi.com/v2/conversations/c123trial?verbose=true');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(fetcher.mock.calls[0]![1]?.body).toBeUndefined();
  });

  it.each([
    ['max_call_duration', 'max_call_duration'],
    ['participant_left_timeout reached', 'participant_left_timeout'],
    ['internal error occurred at step stt', 'internal_error'],
    ['daily_room_has_been_deleted', 'daily_room_has_been_deleted'],
  ])('allowlists documented shutdown reason %s', async (raw, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ status: 'ended', shutdown_reason: raw }));
    expect(await client(fetcher).getConversationDiagnostics('c123trial')).toEqual({ shutdownReason: expected });
  });

  it.each([
    { status: 'active', shutdown_reason: 'participant_left_timeout' },
    { status: 'ended', shutdown_reason: 'secret authenticated https://private.example/path' },
    { events: [{ event_type: 'application.transcription_ready', properties: { shutdown_reason: 'max_call_duration' } }] },
    { events: [null, 4, {}, { event_type: 'system.shutdown', properties: { shutdown_reason: 'unrecognized private value' } }] },
  ])('discards absent or unrecognized shutdown evidence', async value => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(value));
    expect(await client(fetcher).getConversationDiagnostics('c123trial')).toBeUndefined();
  });

  it('limits diagnostic retrieval to two seconds even if fetch ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | null | undefined;
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        signal = init?.signal;
        return new Promise<Response>(() => {});
      });
      const check = expect(client(fetcher).getConversationDiagnostics('c123trial')).rejects.toBeInstanceOf(TavusUnavailableError);
      await vi.advanceTimersByTimeAsync(2_000);
      await check;
      expect(signal?.aborted).toBe(true);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('treats absent cleanup resources as success without accepting absent creates or authentication failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ error: 'Already absent' }, 404));
    const adapter = client(fetcher);
    await adapter.endConversation('c123trial');
    await adapter.deleteConversation('c123trial', { hard: true });
    await adapter.deletePal('p123trial');
    await expect(adapter.createPal(pal)).rejects.toBeInstanceOf(TavusUnavailableError);
    fetcher.mockImplementation(async () => json({ error: 'Credentials invalid' }, 401));
    await expect(adapter.endConversation('c123trial')).rejects.toBeInstanceOf(TavusUnavailableError);
  });

  it.each([
    'https://tavus.daily.co.evil.example/c123trial', 'https://other.daily.co/c123trial',
    'https://tavus.daily.co@evil.example/c123trial', 'https://user:secret@tavus.daily.co/c123trial',
    'http://tavus.daily.co/c123trial', 'https://tavus.daily.co:444/c123trial',
    'https://tavus.daily.co/c123trial?t=secret', 'https://tavus.daily.co/c123trial#secret',
    'https://tavus.daily.co/path/../c123trial', 'https://tavus.daily.co/%63trial',
    'https://tavus.daily.co/', ' https://tavus.daily.co/c123trial',
  ])('rejects untrusted room URL without exposing join material: %s', async conversation_url => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ ...conversation, conversation_url }));
    await expect(client(fetcher).createConversation({ palId: 'p123trial' })).rejects.toThrow(/^The avatar service is unavailable\.$/);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]![0]).toBe('https://tavusapi.com/v2/conversations/c123trial/end');
    expect(fetcher.mock.calls[2]![0]).toBe('https://tavusapi.com/v2/conversations/c123trial?hard=true');
  });

  it.each(['', 'one-segment', 'header.payload.', 'header.payload.sig\n', 'a.b.' + 's'.repeat(8200)])('requires bounded JWT join material', async meeting_token => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ ...conversation, meeting_token }));
    await expect(client(fetcher).createConversation({ palId: 'p123trial' })).rejects.toBeInstanceOf(TavusUnavailableError);
  });

  it.each([
    { conversation_id: '../other' }, { conversation_id: null }, { status: 'unknown' },
    { meeting_token: null }, { conversation_url: null },
  ])('rejects malformed response fields', async patch => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ ...conversation, ...patch }));
    await expect(client(fetcher).createConversation({ palId: 'p123trial' })).rejects.toBeInstanceOf(TavusUnavailableError);
  });

  it.each([
    'http://shop.example.com/api', 'https://localhost/api', 'https://127.0.0.1/api',
    'https://[::1]/api', 'https://shop.local/api', 'https://shop.example.com/api?secret=value',
    'https://user:password@shop.example.com/api', 'https://shop.example.com/api#fragment',
    'https://shop.example.com/api/chat/completions', 'https://shop.example.com:444/api',
  ])('rejects unsafe or incorrectly extended callback URL before any API operation: %s', async callbackBaseUrl => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher).createPal({ ...pal, callbackBaseUrl })).rejects.toBeInstanceOf(TavusUnavailableError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects invalid paths, weak callback secrets and configuration locally', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const adapter = client(fetcher);
    await expect(adapter.createPal({ ...pal, callbackSecret: 'short' })).rejects.toBeInstanceOf(TavusUnavailableError);
    await expect(adapter.createPal({ ...pal, faceId: '../face' })).rejects.toBeInstanceOf(TavusUnavailableError);
    await expect(adapter.deletePal('p123?hard=true')).rejects.toBeInstanceOf(TavusUnavailableError);
    await expect(adapter.endConversation('../other')).rejects.toBeInstanceOf(TavusUnavailableError);
    expect(() => new TavusClient({ apiKey: 'secret\nheader' })).toThrow(TavusUnavailableError);
    expect(() => new TavusClient({ apiKey: 'key', timeoutMs: Infinity })).toThrow(TavusUnavailableError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('redacts provider errors and does not retry unknown-outcome create operations', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ message: 'secret-key-private-prompt' }, 401));
    await expect(client(fetcher).createPal(pal)).rejects.toThrow(/^The avatar service is unavailable\.$/);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('attempts end and hard delete independently and preserves known allocation evidence when cleanup fails', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ...conversation, meeting_token: null }))
      .mockRejectedValueOnce(new Error('secret cleanup diagnostics'));
    await expect(client(fetcher).createConversation({ palId: 'p123trial' })).rejects.toThrow(/^The avatar service is unavailable\.$/);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://tavusapi.com/v2/conversations', 'https://tavusapi.com/v2/conversations/c123trial/end',
      'https://tavusapi.com/v2/conversations/c123trial?hard=true',
    ]);
  });

  it('does not treat a generic 400 during malformed-allocation cleanup as confirmed absence', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ...conversation, meeting_token: null }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ error: 'Private ambiguous provider text' }, 400));
    const failure = await client(fetcher).createConversation({ palId: 'p123trial' }).catch(error => error as Error);
    expect(failure).toBeInstanceOf(TavusAllocationCleanupError);
    expect(failure).toMatchObject({ message: 'The avatar service is unavailable.', conversationId: 'c123trial' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not retry a removed allocation when end fails but hard deletion succeeds', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ...conversation, meeting_token: null }))
      .mockRejectedValueOnce(new Error('Private failed end details'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const failure = await client(fetcher).createConversation({ palId: 'p123trial' }).catch(error => error as Error);
    expect(failure).toBeInstanceOf(TavusUnavailableError);
    expect(failure).not.toBeInstanceOf(TavusAllocationCleanupError);
    expect(failure).not.toHaveProperty('conversationId');
    expect(failure).toMatchObject({ message: 'The avatar service is unavailable.' });
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://tavusapi.com/v2/conversations', 'POST'],
      ['https://tavusapi.com/v2/conversations/c123trial/end', 'POST'],
      ['https://tavusapi.com/v2/conversations/c123trial?hard=true', 'DELETE'],
    ]);
  });

  it('never uses an invalid returned ID as a cleanup path', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ ...conversation, conversation_id: '../private' }));
    await expect(client(fetcher).createConversation({ palId: 'p123trial' })).rejects.toBeInstanceOf(TavusUnavailableError);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('redacts network failures and malformed JSON', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret-key-and-authenticated-url'));
    await expect(client(fetcher).createPal(pal)).rejects.toThrow(/^The avatar service is unavailable\.$/);
    fetcher.mockResolvedValue(new Response('private invalid provider body'));
    await expect(client(fetcher).createPal(pal)).rejects.toThrow(/^The avatar service is unavailable\.$/);
  });

  it('bounds both declared and streamed response sizes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('small', { headers: { 'Content-Length': '65537' } }));
    await expect(client(fetcher).createPal(pal)).rejects.toBeInstanceOf(TavusUnavailableError);
    fetcher.mockResolvedValue(json({ pal_id: 'p123trial', ignored: 'x'.repeat(65536) }));
    await expect(client(fetcher).createPal(pal)).rejects.toBeInstanceOf(TavusUnavailableError);
  });

  it('starts no request if already cancelled', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher).createPal({ ...pal, signal: AbortSignal.abort() })).rejects.toBeInstanceOf(TavusUnavailableError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('propagates upstream cancellation even to a fetch implementation that ignores it', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      requestSignal = init?.signal;
      controller.abort();
      return new Promise<Response>(() => {});
    });
    await expect(client(fetcher).createPal({ ...pal, signal: controller.signal })).rejects.toBeInstanceOf(TavusUnavailableError);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('times out a stalled provider and aborts its request without retrying', async () => {
    let requestSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>(() => {});
    });
    await expect(client(fetcher, 10).createPal(pal)).rejects.toBeInstanceOf(TavusUnavailableError);
    expect(requestSignal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
