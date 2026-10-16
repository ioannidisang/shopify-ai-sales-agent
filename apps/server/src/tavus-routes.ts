import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ShopConfig } from '../../../packages/core/src/types.js';
import type { ChatResponse } from '../../widget/src/types.js';
import type { RuntimeEnvironment } from './config.js';
import { takeBudget, type Database } from './database.js';
import { constantEqual, tokenPayload, type Security, type SessionClaims } from './security.js';
import { TavusClient, TavusAllocationCleanupError, TAVUS_MAX_CALL_SECONDS, TAVUS_DIAGNOSTIC_TIMEOUT_MS, TAVUS_SHUTDOWN_REASONS, type TavusProvider } from './tavus-client.js';

const MAX_STARTS_PER_DAY = 3;
const CALLBACK_DEADLINE_MS = 30_000;
const MAX_PENDING_TURNS = 4;
const MAX_CALLBACK_WAITERS = 8;
const CALLBACK_REASONS = ['ok', 'invalid_input', 'session_guard', 'config_guard', 'queue_full', 'deadline', 'lease_lost', 'conversation_busy', 'turn_limit', 'model_budget', 'generation_failed'] as const;
export type AvatarCallbackReason = typeof CALLBACK_REASONS[number];
const bearerBody = z.object({ token: z.string().min(1).max(2048) });
const ownerBody = bearerBody.extend({ sessionId: z.uuid() });
const unavailableSpeech = 'Η σύνδεση διακόπηκε. Μπορείς να συνεχίσεις γραπτά με τον βοηθό.';
type Context = { tenant: { config: ShopConfig }; claims: SessionClaims };
type Row = Record<string, unknown> & {
  id: string; shop: string; conversation_id: string; claims: unknown; credential_hash: string;
  state: string; expires_at: Date | string; provider_pal_id: string | null;
  provider_conversation_id: string | null; sequence: number; result: string | null; last_request_hash: string | null;
};
interface Dependencies {
  authenticate(req: FastifyRequest, token: string): Promise<Context>;
  authenticateEnd(req: FastifyRequest, token: string): Promise<SessionClaims>;
  validate(claims: SessionClaims): Promise<Context>;
  chat(claims: SessionClaims, message: string, signal: AbortSignal): Promise<ChatResponse>;
  provider?: TavusProvider;
}
class AvatarError extends Error { constructor(public statusCode: number, public avatarReason?: AvatarCallbackReason) { super('Avatar request unavailable'); } }

export function avatarAvailable(env: RuntimeEnvironment, config: ShopConfig): boolean {
  return Boolean(env.tavus && env.tavus.pilotShop === config.shop && env.allowedShops.includes(config.shop)
    && config.enabled && !config.experiment.enabled && config.locale === 'el');
}

/** Per-session PAL credentials bind every provider request to one tenant and shopper.
 * PostgreSQL, not a process-local map, owns the lease, budgets and encrypted result.
 */
export function registerAvatarRoutes(app: FastifyInstance, env: RuntimeEnvironment, db: Database, security: Security, deps: Dependencies) {
  const cleanupKey = env.tavus?.apiKey ?? env.tavusApiKey;
  const provider = deps.provider ?? (cleanupKey ? new TavusClient({ apiKey: cleanupKey }) : undefined);
  const owned = new Set<string>();
  const callbackStarted = new WeakMap<FastifyRequest, { started: number; reason?: AvatarCallbackReason }>();
  type PendingTurn = { promise: Promise<ChatResponse> };
  type CallbackQueue = {
    turns: Map<string, PendingTurn>; tail: Promise<void>; waiters: number; invalidated: boolean;
    completed: Map<string, { result: string; expiresAt: number }>; expiryTimer?: ReturnType<typeof setTimeout>;
  };
  const callbackQueues = new Map<string, CallbackQueue>();
  let sweeping = false;
  function available(config: ShopConfig) { if (!provider || !avatarAvailable(env, config)) throw new AvatarError(403); }
  async function get(id: string) { return (await db.query<Row>('SELECT * FROM avatar_sessions WHERE id=$1', [id])).rows[0]; }
  function active(row: Row | undefined): asserts row is Row {
    if (!row || row.state !== 'active' || new Date(row.expires_at).getTime() <= Date.now()) throw new AvatarError(401, 'session_guard');
  }
  function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) { void work.catch(() => {}); return Promise.reject(signal.reason); }
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  async function waitForLease(signal: AbortSignal): Promise<void> {
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, 100);
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
    });
    signal.throwIfAborted();
  }
  function pruneQueue(id: string, queue: CallbackQueue): void {
    clearTimeout(queue.expiryTimer);
    for (const [hash, completed] of queue.completed) if (completed.expiresAt <= Date.now()) queue.completed.delete(hash);
    if (!queue.turns.size && !queue.waiters && !queue.completed.size) {
      if (callbackQueues.get(id) === queue) callbackQueues.delete(id);
    } else if (queue.completed.size) {
      const nextExpiry = Math.min(...Array.from(queue.completed.values(), entry => entry.expiresAt));
      queue.expiryTimer = setTimeout(() => pruneQueue(id, queue), Math.max(1, nextExpiry - Date.now()));
      queue.expiryTimer.unref();
    }
  }
  async function checkedTurn(row: Row, claims: SessionClaims, message: string, requestHash: string, signal: AbortSignal): Promise<ChatResponse> {
    let lease: string | undefined;
    try {
      // The process-local FIFO reduces contention; this database lease remains the
      // authority when a second process is draining or completing the same session.
      for (;;) {
        signal.throwIfAborted();
        const current = await get(row.id); active(current);
        const context = await deps.validate(claims); available(context.tenant.config);
        signal.throwIfAborted();
        if (current.last_request_hash === requestHash && current.result) return security.decrypt<ChatResponse>(current.result, row.shop);
        const lock = await db.query<{ lease: string }>("UPDATE avatar_sessions SET busy_until=now()+interval '35 seconds' WHERE id=$1 AND state='active' AND expires_at>now() AND (busy_until IS NULL OR busy_until<now()) RETURNING busy_until::text AS lease", [row.id]);
        if (lock.rows[0]) { lease = lock.rows[0].lease; break; }
        await waitForLease(signal);
      }
      signal.throwIfAborted();
      const locked = await get(row.id); active(locked);
      if (locked.last_request_hash === requestHash && locked.result) return security.decrypt<ChatResponse>(locked.result, row.shop);
      let response: ChatResponse;
      for (;;) {
        signal.throwIfAborted();
        try { response = await deps.chat(claims, message, signal); break; }
        catch (error) {
          // A text turn or a draining worker can still own the conversation lease.
          // Retrying this fixed busy reason spends no additional model turn.
          const reason = error && typeof error === 'object' && 'avatarReason' in error ? error.avatarReason : undefined;
          if (reason !== 'conversation_busy') throw error;
          await waitForLease(signal);
        }
      }
      signal.throwIfAborted();
      const current = await deps.validate(claims); available(current.tenant.config);
      signal.throwIfAborted();
      const saved = await db.query("UPDATE avatar_sessions SET result=$2,sequence=sequence+1,last_request_hash=$3 WHERE id=$1 AND state='active' AND expires_at>now() AND busy_until=$4::timestamptz AND busy_until>now() RETURNING id", [row.id, security.encrypt(response, row.shop), requestHash, lease]);
      if (!saved.rows.length) {
        active(await get(row.id));
        throw new AvatarError(409, 'lease_lost');
      }
      return response;
    } catch (error) {
      // A bounded queue wait does not revoke a healthy room or another worker's
      // lease. Configuration, shopper-session and generation failures still do.
      if (signal.aborted) throw signal.reason;
      const reason = error && typeof error === 'object' && 'avatarReason' in error ? error.avatarReason : undefined;
      if (reason !== 'deadline' && reason !== 'lease_lost') await stop(row);
      throw error;
    } finally {
      // A delayed worker must never clear a lease acquired by its successor.
      if (lease) await db.query('UPDATE avatar_sessions SET busy_until=NULL WHERE id=$1 AND busy_until=$2::timestamptz', [row.id, lease]);
    }
  }
  async function queuedTurn(row: Row, claims: SessionClaims, message: string, requestHash: string, deadline: number, requestSignal: AbortSignal): Promise<ChatResponse> {
    let queue = callbackQueues.get(row.id);
    if (!queue) { queue = { turns: new Map(), tail: Promise.resolve(), waiters: 0, completed: new Map(), invalidated: false }; callbackQueues.set(row.id, queue); }
    if (queue.invalidated) throw new AvatarError(401, 'session_guard');
    const completed = queue.completed.get(requestHash);
    if (completed && completed.expiresAt > Date.now()) { pruneQueue(row.id, queue); return security.decrypt<ChatResponse>(completed.result, row.shop); }
    // The database also covers a retry after a process restart or a cache expiry.
    if (row.last_request_hash === requestHash && row.result) { pruneQueue(row.id, queue); return security.decrypt<ChatResponse>(row.result, row.shop); }
    const existing = queue.turns.get(requestHash);
    if (queue.waiters >= MAX_CALLBACK_WAITERS || (!existing && queue.turns.size >= MAX_PENDING_TURNS)) throw new AvatarError(429, 'queue_full');
    queue.waiters++;
    try {
      let turn = existing;
      if (!turn) {
        const controller = new AbortController();
        const remaining = Math.max(0, deadline - Date.now());
        const timer = setTimeout(() => controller.abort(new AvatarError(504, 'deadline')), remaining);
        timer.unref();
        const signal = AbortSignal.any([controller.signal, requestSignal]);
        const previous = queue.tail;
        const work = previous.then(() => { signal.throwIfAborted(); return checkedTurn(row, claims, message, requestHash, signal); });
        const promise = abortable(work, signal);
        turn = { promise };
        queue.turns.set(requestHash, turn);
        const ownedTurn = turn;
        queue.tail = promise.then(response => {
          if (queue!.invalidated) return;
          const expiresAt = Math.min(Date.now() + CALLBACK_DEADLINE_MS, new Date(row.expires_at).getTime(), claims.exp * 1000);
          queue!.completed.set(requestHash, { result: security.encrypt(response, row.shop), expiresAt });
          while (queue!.completed.size > MAX_PENDING_TURNS) queue!.completed.delete(queue!.completed.keys().next().value!);
        }, () => {}).finally(() => {
          clearTimeout(timer);
          if (queue!.turns.get(requestHash) === ownedTurn) queue!.turns.delete(requestHash);
          pruneQueue(row.id, queue!);
        });
      }
      // Every coalesced callback retains this exact checked result, even when a
      // different queued turn has already replaced the database's latest result.
      return await turn.promise;
    } finally {
      queue.waiters--;
      pruneQueue(row.id, queue);
    }
  }
  async function recordShutdownReason(conversationId: string): Promise<void> {
    if (!provider?.getConversationDiagnostics) return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const diagnostics = await Promise.race([
        provider.getConversationDiagnostics(conversationId, { signal: controller.signal }),
        new Promise<undefined>(resolve => {
          timeout = setTimeout(() => { controller.abort(); resolve(undefined); }, TAVUS_DIAGNOSTIC_TIMEOUT_MS);
          timeout.unref();
        }),
      ]);
      // Re-allowlist at the logging boundary even for injected provider adapters.
      const reason = diagnostics?.shutdownReason;
      if (reason && TAVUS_SHUTDOWN_REASONS.includes(reason)) app.log.info({ reason }, 'Avatar provider shutdown');
    } catch { /* Missing, delayed, or malformed diagnostics must not prevent cleanup. */ }
    finally { clearTimeout(timeout); controller.abort(); }
  }
  async function stop(row: Row): Promise<void> {
    if (!provider) return;
    const queue = callbackQueues.get(row.id);
    if (queue) { queue.invalidated = true; queue.completed.clear(); pruneQueue(row.id, queue); }
    // Invalidate the callback before any network call, including in-flight generation.
    // Use the current durable state and IDs: a delayed callback can hold a stale
    // active row after owner-end has already completed cleanup.
    const revoked = await db.query<Row>("UPDATE avatar_sessions SET state='ending',credential_hash='',result=NULL WHERE id=$1 AND state IN ('starting','active','ending') RETURNING *", [row.id]);
    if (!revoked.rows[0]) { owned.delete(row.id); return; }
    row = revoked.rows[0];
    // Unknown create outcomes retain the durable lease until the provider hard ceiling.
    if (!row.provider_conversation_id && new Date(row.expires_at).getTime() > Date.now()) return;
    try {
      if (row.provider_conversation_id) {
        // Read the original provider cause before our end request can replace it.
        await recordShutdownReason(row.provider_conversation_id);
        await provider.endConversation(row.provider_conversation_id);
        await provider.deleteConversation(row.provider_conversation_id, { hard: true });
      }
      if (row.provider_pal_id) await provider.deletePal(row.provider_pal_id);
      await db.query("UPDATE avatar_sessions SET state='ended',credential_hash='',result=NULL WHERE id=$1", [row.id]);
      owned.delete(row.id);
    } catch {
      // Retain ending state/IDs for reconciliation. Never release the cost lease on error.
      app.log.warn('Avatar cleanup pending');
    }
  }
  async function sweep() {
    if (!provider || sweeping) return;
    sweeping = true;
    try {
      const rows = await db.query<Row>("SELECT * FROM avatar_sessions WHERE state IN ('starting','active','ending') AND (expires_at<=now() OR state='ending') LIMIT 10");
      for (const row of rows.rows) await stop(row);
    } finally { sweeping = false; }
  }

  app.post('/proxy/avatar/start', { config: { rateLimit: { max: 5, timeWindow: 60000 } } }, async req => {
    const body = bearerBody.extend({ accessCode: z.string().min(16).max(128) }).strict().parse(req.body);
    const { tenant, claims } = await deps.authenticate(req, body.token);
    available(tenant.config);
    if (claims.assignment === 'control' || claims.experimentId !== 'off' || claims.locale !== 'el') throw new AvatarError(403);
    const hash = createHash('sha256').update(body.accessCode).digest('hex');
    if (!constantEqual(hash, env.tavus!.accessCodeHash)) throw new AvatarError(403);
    // The access code is the authorization boundary; theme-role gating is only UI defense.
    await sweep();
    if ((await db.query("SELECT id FROM avatar_sessions WHERE shop=$1 AND state IN ('starting','active','ending')", [claims.shop])).rows.length) throw new AvatarError(409);
    const day = new Date().toISOString().slice(0, 10);
    if (!await takeBudget(db, claims.shop, `${day}:avatar-start`, MAX_STARTS_PER_DAY)) throw new AvatarError(429);
    const id = randomUUID(); const secret = randomBytes(32).toString('base64url');
    // Includes a bounded allocation allowance. Provider enforces 180s of conversation time.
    const expiresAt = new Date(Date.now() + (TAVUS_MAX_CALL_SECONDS + 30) * 1000);
    try {
      await db.query("INSERT INTO avatar_sessions(id,shop,conversation_id,claims,credential_hash,state,expires_at) VALUES($1,$2,$3,$4,$5,'starting',$6)",
        [id, claims.shop, claims.sid, JSON.stringify(claims), security.hashClient(claims.shop, `avatar:${secret}`), expiresAt]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new AvatarError(409);
      throw error;
    }
    owned.add(id);
    try {
      const { palId } = await provider!.createPal({ faceId: env.tavus!.faceId,
        callbackBaseUrl: `${env.appUrl.replace(/\/$/, '')}/api/avatar/${id}/v1`, callbackSecret: secret,
        ...(env.tavus!.voice ? { voice: env.tavus!.voice } : {}) });
      await db.query('UPDATE avatar_sessions SET provider_pal_id=$2 WHERE id=$1', [id, palId]);
      const pending = await get(id);
      if (!pending || pending.state !== 'starting' || new Date(pending.expires_at).getTime() <= Date.now()) throw new AvatarError(409);
      const room = await provider!.createConversation({ palId, ...(env.tavus!.background === 'greenscreen' ? { greenscreen: true } : {}) });
      await db.query('UPDATE avatar_sessions SET provider_conversation_id=$2 WHERE id=$1', [id, room.conversationId]);
      const fresh = await deps.validate(claims); available(fresh.tenant.config);
      if (room.status !== 'active') throw new AvatarError(503);
      const until = new Date(Date.now() + TAVUS_MAX_CALL_SECONDS * 1000);
      const activated = await db.query("UPDATE avatar_sessions SET state='active',expires_at=$2 WHERE id=$1 AND state='starting' AND expires_at>now() RETURNING id", [id, until]);
      if (!activated.rows.length) throw new AvatarError(409);
      return { sessionId: id, conversationId: room.conversationId, conversationUrl: room.conversationUrl,
        meetingToken: room.meetingToken, expiresAt: until.toISOString() };
    } catch (error) {
      if (error instanceof TavusAllocationCleanupError) {
        await db.query('UPDATE avatar_sessions SET provider_conversation_id=$2 WHERE id=$1 AND provider_conversation_id IS NULL', [id, error.conversationId]);
      }
      const row = await get(id); if (row) await stop(row);
      throw new AvatarError(503);
    }
  });

  app.post('/proxy/avatar/end', async req => {
    const body = ownerBody.strict().parse(req.body);
    const claims = await deps.authenticateEnd(req, body.token);
    const row = await get(body.sessionId);
    if (!row || row.shop !== claims.shop || row.conversation_id !== claims.sid) throw new AvatarError(404);
    await stop(row);
    return { ended: true };
  });

  app.post('/proxy/avatar/result', { config: { rateLimit: { max: 100, timeWindow: 60000 } } }, async req => {
    const body = ownerBody.extend({ after: z.number().int().min(0) }).strict().parse(req.body);
    const claims = await deps.authenticateEnd(req, body.token);
    const row = await get(body.sessionId);
    if (!row || row.shop !== claims.shop || row.conversation_id !== claims.sid) throw new AvatarError(404);
    let tenant: Context['tenant'];
    try { ({ tenant } = await deps.authenticate(req, body.token)); }
    catch (error) { await stop(row); throw error; }
    if (!avatarAvailable(env, tenant.config) || new Date(row.expires_at).getTime() <= Date.now()) await stop(row);
    const current = await get(row.id);
    const ended = !current || current.state !== 'active';
    return { sequence: current?.sequence ?? row.sequence, ended,
      ...(!ended && current!.sequence > body.after && current!.result
        ? { response: security.decrypt<ChatResponse>(current!.result, claims.shop) } : {}) };
  });

  app.post('/api/avatar/:id/v1/chat/completions', {
    config: { rateLimit: { max: 90, timeWindow: 60000 } },
    onResponse: async (req, reply) => {
      const diagnostic = callbackStarted.get(req);
      if (!diagnostic) return;
      callbackStarted.delete(req);
      // Only an authenticated callback is measured. This describes HTTP completion,
      // not audible delivery; never copy provider data or request/session identifiers.
      const status = [200, 400, 401, 403, 404, 409, 413, 429, 500, 502, 503, 504].includes(reply.statusCode) ? reply.statusCode : 500;
      const outcome = status === 200 ? 'completed' : status < 500 ? 'rejected' : 'failed';
      const durationMs = Math.max(0, Math.min(60_000, Math.round(performance.now() - diagnostic.started)));
      const reason = diagnostic.reason ?? (status === 200 ? 'ok' : 'generation_failed');
      try { app.log.info({ outcome, status, durationMs, reason }, 'Avatar callback outcome'); }
      catch { /* Operational diagnostics cannot interfere with response cleanup. */ }
    },
  }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const row = await get(id);
    const authorization = req.headers.authorization;
    if (!row || row.state !== 'active' || new Date(row.expires_at).getTime() <= Date.now()
      || typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization)
      || !constantEqual(security.hashClient(row.shop, `avatar:${authorization.slice(7)}`), row.credential_hash)) throw new AvatarError(401);
    const diagnostic: { started: number; reason?: AvatarCallbackReason } = { started: performance.now() };
    callbackStarted.set(req, diagnostic);
    const deadline = Math.min(Date.now() + CALLBACK_DEADLINE_MS, new Date(row.expires_at).getTime());
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new AvatarError(504, 'deadline')), Math.max(0, deadline - Date.now()));
    timeout.unref();
    try {
      return await abortable((async () => {
        const claims = tokenPayload.parse(row.claims);
        try { const { tenant } = await deps.validate(claims); available(tenant.config); }
        catch (error) { if (controller.signal.aborted) throw controller.signal.reason; await stop(row); throw error; }
        controller.signal.throwIfAborted();
        // All upstream system text, history, tools and assistant messages are untrusted.
        // The authoritative conversation context is loaded from our encrypted history.
        const body = z.object({ stream: z.boolean().optional(), messages: z.array(z.object({ role: z.string(), content: z.unknown() }).passthrough()).min(1).max(100) }).passthrough().parse(req.body);
        const last = body.messages.at(-1)!;
        if (last.role !== 'user') throw new AvatarError(400);
        const message = z.string().trim().min(1).max(2000).parse(last.content);
        const requestHash = security.hashClient(row.shop, `avatar-turn:${JSON.stringify(body.messages)}`);
        const response = await queuedTurn(row, claims, message, requestHash, Math.min(deadline, claims.exp * 1000), controller.signal);
        controller.signal.throwIfAborted();
        // One final state check before emitting anything audible; no unchecked token streaming.
        try { const current = await deps.validate(claims); available(current.tenant.config); }
        catch (error) { if (controller.signal.aborted) throw controller.signal.reason; await stop(row); throw error; }
        controller.signal.throwIfAborted();
        // Read after the last async validation so owner-end wins during that wait too.
        active(await get(id));
        controller.signal.throwIfAborted();
        const text = response?.text || unavailableSpeech;
        const completionId = `chatcmpl-${randomUUID()}`; const created = Math.floor(Date.now() / 1000);
        if (body.stream === false) return { id: completionId, object: 'chat.completion', created, model: 'shopify-grounded', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] };
        const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created, model: 'shopify-grounded', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        reply.type('text/event-stream').header('X-Accel-Buffering', 'no');
        return chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
      })(), controller.signal);
    } catch (error) {
      const tagged = (error && typeof error === 'object' ? error : {}) as { avatarReason?: unknown; statusCode?: unknown };
      diagnostic.reason = CALLBACK_REASONS.includes(tagged.avatarReason as AvatarCallbackReason) ? tagged.avatarReason as AvatarCallbackReason
        : error instanceof z.ZodError || tagged.statusCode === 400 ? 'invalid_input'
          : tagged.statusCode === 401 ? 'session_guard'
            : tagged.statusCode === 403 || tagged.statusCode === 409 ? 'config_guard' : 'generation_failed';
      throw error;
    } finally { clearTimeout(timeout); }
  });

  const timer = setInterval(() => { void sweep().catch(() => app.log.warn('Avatar reconciliation pending')); }, 15000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    for (const id of owned) { const row = await get(id); if (row) await stop(row); }
    for (const queue of callbackQueues.values()) clearTimeout(queue.expiryTimer);
    callbackQueues.clear();
  });
  return { stopShop: async (shop: string) => {
    const rows = await db.query<Row>("SELECT * FROM avatar_sessions WHERE shop=$1 AND state IN ('starting','active','ending')", [shop]);
    for (const row of rows.rows) await stop(row);
    // Retain durable resource IDs if cleanup failed; the caller must not cascade them away.
    if ((await db.query("SELECT id FROM avatar_sessions WHERE shop=$1 AND state='ending'", [shop])).rows.length) throw new AvatarError(503);
  } };
}
