import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const shopDomain = z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/);
export const tokenPayload = z.object({
  shop: shopDomain, sid: z.uuid(), exp: z.number().int(),
  assignment: z.enum(['assistant', 'control', 'untracked']), experimentId: z.string().max(80),
  consent: z.boolean(), country: z.string().regex(/^[A-Z]{2}$/), locale: z.enum(['el', 'en']),
}).strict();
export type SessionClaims = z.infer<typeof tokenPayload>;

export function constantEqual(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Security {
  private readonly encryptionKey: Buffer;
  constructor(private readonly secret: string, encryptionKey: string) {
    this.encryptionKey = Buffer.from(encryptionKey, 'base64');
    if (secret.length < 32 || this.encryptionKey.length !== 32) throw new Error('Invalid server secret configuration');
  }
  sign(payload: SessionClaims): string {
    const body = Buffer.from(JSON.stringify(tokenPayload.parse(payload))).toString('base64url');
    return `${body}.${this.mac(`session:${body}`)}`;
  }
  verify(token: string, shop: string, now = Date.now(), expiryGraceMs = 0): SessionClaims {
    if (token.length > 2048) throw new Error('Invalid session');
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra || !constantEqual(signature, this.mac(`session:${body}`))) throw new Error('Invalid session');
    const payload = tokenPayload.parse(JSON.parse(Buffer.from(body, 'base64url').toString()));
    if (payload.shop !== shop || payload.exp <= (now - expiryGraceMs) / 1000) throw new Error('Session expired or invalid tenant');
    return payload;
  }
  encrypt(value: unknown, shop: string): string {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(shop));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(x => x.toString('base64url')).join('.');
  }
  decrypt<T>(value: string, shop: string): T {
    const parts = value.split('.').map(x => Buffer.from(x, 'base64url'));
    if (parts.length !== 3) throw new Error('Invalid ciphertext');
    const cipher = createDecipheriv('aes-256-gcm', this.encryptionKey, parts[0]!);
    cipher.setAAD(Buffer.from(shop)); cipher.setAuthTag(parts[1]!);
    return JSON.parse(Buffer.concat([cipher.update(parts[2]!), cipher.final()]).toString()) as T;
  }
  assignment(shop: string, experiment: string, visitorId: string, treatmentPercent: number): 'assistant' | 'control' {
    const value = Number.parseInt(this.mac(`experiment:${shop}:${experiment}:${visitorId}`).slice(0, 8), 16) / 0x100000000;
    return value < treatmentPercent / 100 ? 'assistant' : 'control';
  }
  pixelKey(shop: string): string { return this.mac(`public-pixel-collector:${shop}`); }
  hashClient(shop: string, clientId: string): string { return this.mac(`client:${shop}:${clientId}`); }
  private mac(value: string): string { return createHmac('sha256', this.secret).update(value).digest('hex'); }
}
