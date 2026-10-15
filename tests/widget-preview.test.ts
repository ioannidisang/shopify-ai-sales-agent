import { describe, expect, it } from 'vitest';
import { isUnpublishedTheme } from '../apps/widget/src/preview.js';

describe('private avatar storefront preview gate', () => {
  it.each([200088715651, '200088715651'])('accepts an explicitly unpublished Shopify runtime theme with id %s', id => {
    expect(isUnpublishedTheme({ id, role: 'unpublished' })).toBe(true);
  });

  it.each(['main', 'development', 'demo', '', undefined])('keeps the pilot hidden for role %s', role => {
    expect(isUnpublishedTheme({ id: 200088715651, role })).toBe(false);
  });

  it.each([undefined, null, {}, 'unpublished', { role: 'unpublished' }, { role: 'unpublished', id: 0 }, { role: 'unpublished', id: -1 }, { role: 'unpublished', id: 'unknown' }, { role: 'unpublished', id: '+123' }, { role: 'unpublished', id: Number.MAX_SAFE_INTEGER + 1 }])('fails closed on missing or malformed runtime metadata %j', theme => {
    expect(isUnpublishedTheme(theme)).toBe(false);
  });

  it('does not treat editor mode or a preview query parameter as unpublished-theme evidence', () => {
    expect(isUnpublishedTheme({ id: 200088715651, role: 'main', designMode: true, preview_theme_id: '200088715651' })).toBe(false);
    expect(isUnpublishedTheme({ designMode: true, preview_theme_id: '200088715651' })).toBe(false);
  });
});
