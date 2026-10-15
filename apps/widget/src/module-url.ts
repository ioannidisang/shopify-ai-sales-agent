export function widgetModuleUrl(value: string, pageOrigin: string): string {
  return moduleUrl(value, pageOrigin, 'sales-assistant-ui.js');
}

export function avatarModuleUrl(value: string, pageOrigin: string): string {
  return moduleUrl(value, pageOrigin, 'sales-assistant-avatar.js');
}

function moduleUrl(value: string, pageOrigin: string, filename: string): string {
  const url = new URL(value, pageOrigin);
  if (url.username || url.password || !url.pathname.endsWith(`/${filename}`)) throw new Error('Invalid widget module');
  if (url.origin !== pageOrigin && !(url.protocol === 'https:' && url.hostname === 'cdn.shopify.com')) throw new Error('Unexpected widget module origin');
  return url.href;
}
