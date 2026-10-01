export function widgetModuleUrl(value: string, pageOrigin: string): string {
  const url = new URL(value, pageOrigin);
  if (url.username || url.password || !url.pathname.endsWith('/sales-assistant-ui.js')) throw new Error('Invalid widget module');
  if (url.origin !== pageOrigin && !(url.protocol === 'https:' && url.hostname === 'cdn.shopify.com')) throw new Error('Unexpected widget module origin');
  return url.href;
}
