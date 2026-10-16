export type AvatarStartFailure =
  | { code: 'avatar_daily_limit'; resetAt: string }
  | { code: 'avatar_session_busy' | 'avatar_access_denied' | 'avatar_unavailable' };

/** Only the server's next UTC midnight is suitable for a local reset-time label. */
export function validAvatarResetAt(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    && timestamp >= Date.now() - 300_000 && timestamp <= Date.now() + 129_600_000;
}

export function parseAvatarStartFailure(status: number, value: unknown): AvatarStartFailure | undefined {
  if (!value || typeof value !== 'object') return;
  const { code, resetAt } = value as { code?: unknown; resetAt?: unknown };
  if (status === 429 && code === 'avatar_daily_limit' && validAvatarResetAt(resetAt)) return { code, resetAt };
  if ((status === 409 && code === 'avatar_session_busy') || (status === 403 && code === 'avatar_access_denied') || (status === 503 && code === 'avatar_unavailable')) return { code };
}

/** Structural decoding works across the independently bundled loader and avatar. */
export function avatarStartFailureFromError(error: unknown): AvatarStartFailure | undefined {
  if (!error || typeof error !== 'object') return;
  const value = error as { name?: unknown; status?: unknown };
  if (value.name === 'AvatarStartRequestError' && typeof value.status === 'number') return parseAvatarStartFailure(value.status, error);
}
