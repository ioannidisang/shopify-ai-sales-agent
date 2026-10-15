/** UI defense only: the server's pilot access code remains the authorization boundary.
 * Shopify renders this runtime metadata in storefront pages. Liquid theme.role is
 * not available in our app embed. Missing/changed metadata must keep the pilot hidden.
 */
export function isUnpublishedTheme(theme: unknown): boolean {
  if (!theme || typeof theme !== 'object' || !('role' in theme) || theme.role !== 'unpublished' || !('id' in theme)) return false;
  const id = typeof theme.id === 'number' ? theme.id : typeof theme.id === 'string' && /^[1-9]\d*$/.test(theme.id) ? Number(theme.id) : NaN;
  return Number.isSafeInteger(id) && id > 0;
}
