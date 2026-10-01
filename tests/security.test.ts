import { describe, it, expect } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Security, type SessionClaims } from '../apps/server/src/security.js';

describe('tenant security', () => {
  const security = new Security('secret'.repeat(8), randomBytes(32).toString('base64'));
  const claims: SessionClaims = { shop: 'first.myshopify.com', sid: randomUUID(), exp: Math.floor(Date.now()/1000)+600, assignment: 'assistant', experimentId: 'v1', consent: true, country: 'GR', locale: 'el' };
  it('rejects a valid token for another tenant, expired token and tampering', () => {
    const token = security.sign(claims);
    expect(security.verify(token, claims.shop)).toEqual(claims);
    expect(() => security.verify(token, 'other.myshopify.com')).toThrow();
    expect(() => security.verify(token, claims.shop, Date.now()+700000)).toThrow();
    expect(() => security.verify(token.slice(0,-1)+'x', claims.shop)).toThrow();
  });
  it('binds ciphertext to shop and uses distinct nonces', () => {
    const first = security.encrypt({ token: 'sensitive' }, claims.shop);
    const second = security.encrypt({ token: 'sensitive' }, claims.shop);
    expect(first).not.toEqual(second);
    expect(first).not.toContain('sensitive');
    expect(security.decrypt(first, claims.shop)).toEqual({ token: 'sensitive' });
    expect(() => security.decrypt(first, 'other.myshopify.com')).toThrow();
  });
  it('assigns deterministic balanced arms with distinct experiment namespaces', () => {
    let treatment = 0; let changed = 0;
    for (let n=0;n<1000;n++) {
      const id = `visitor-${n}`;
      const arm = security.assignment(claims.shop,'v1',id,50);
      expect(security.assignment(claims.shop,'v1',id,50)).toBe(arm);
      if (arm==='assistant') treatment++;
      if (security.assignment(claims.shop,'v2',id,50)!==arm) changed++;
    }
    expect(treatment).toBeGreaterThan(430); expect(treatment).toBeLessThan(570);
    expect(changed).toBeGreaterThan(400);
    expect(security.assignment(claims.shop,'v1','any',0)).toBe('control');
    expect(security.assignment(claims.shop,'v1','any',100)).toBe('assistant');
  });
});
