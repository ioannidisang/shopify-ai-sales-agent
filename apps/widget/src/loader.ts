import { brandVariables } from './appearance.js';
import { WidgetConnection } from './connection.js';
import { widgetModuleUrl } from './module-url.js';
import type { WidgetHandle } from './index.js';

// Shadow content leaves the light-DOM div empty. Override theme div:empty rules;
// important shadow-host declarations also win against important outer-theme rules.
const launcherStyles = `:host{all:initial;display:block!important;font:15px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.launcher{font:inherit;position:fixed;right:24px;bottom:24px;z-index:2147483000;border:1px solid var(--sa-accent);border-radius:999px;background:var(--sa-accent);color:var(--sa-accent-ink);box-shadow:0 8px 32px #17171733;display:flex;align-items:center;gap:9px;padding:14px 20px;font-weight:650;min-height:44px;cursor:pointer;touch-action:manipulation}.launcher[hidden]{display:none}.launcher:disabled{cursor:wait;opacity:.55}.launcher:focus-visible{outline:3px solid var(--sa-ink);outline-offset:3px}.dot{width:8px;height:8px;background:var(--sa-accent-ink);border-radius:50%}@media(max-width:520px){.launcher{right:16px;bottom:16px}}`;

export function mountLoader(host: HTMLElement): void {
  if (host.shadowRoot) return;
  const moduleUrl = widgetModuleUrl(host.dataset.uiUrl || '', location.origin);
  const connection = new WidgetConnection(host.dataset.endpoint || '/apps/sales-agent', host.dataset.country || 'GR', host.dataset.locale || 'en');
  const shadow = host.attachShadow({ mode: 'open' });
  for (const [name, value] of Object.entries(brandVariables({ header: host.dataset.colorHeader, surface: host.dataset.colorSurface, accent: host.dataset.colorAccent }))) host.style.setProperty(name, value);
  const greek = connection.locale.toLowerCase().startsWith('el');
  const label = greek ? 'Βοηθός αγορών' : 'Shopping assistant';
  const style = document.createElement('style'); style.textContent = launcherStyles;
  const launcher = document.createElement('button'); launcher.type = 'button'; launcher.className = 'launcher'; launcher.hidden = true;
  launcher.setAttribute('aria-haspopup', 'dialog'); launcher.setAttribute('aria-expanded', 'false');
  const dot = document.createElement('span'); dot.className = 'dot'; dot.setAttribute('aria-hidden', 'true');
  const text = document.createTextNode(label); launcher.append(dot, text); shadow.append(style, launcher);
  const canOpen = () => !!connection.session?.enabled && connection.session.assignment !== 'control';
  connection.subscribe(() => { launcher.hidden = !canOpen(); });
  let widget: WidgetHandle | undefined;
  let opening = false;
  launcher.addEventListener('click', () => {
    if (opening) return;
    opening = true; launcher.disabled = true;
    void (async () => {
      try {
        await connection.ensureSession();
        if (!canOpen()) return;
        if (!widget) {
          const module = await import(moduleUrl) as { mount: (host: HTMLElement, connection: WidgetConnection, launcher: HTMLButtonElement) => WidgetHandle };
          // Consent/assignment can change while the CDN request is in flight.
          await connection.ensureSession();
          if (!canOpen()) return;
          widget = module.mount(host, connection, launcher);
        }
        text.textContent = label;
        await widget.open();
      } catch { text.textContent = greek ? 'Δοκίμασε ξανά' : 'Try again'; }
      finally { opening = false; launcher.disabled = false; }
    })();
  });
  document.addEventListener('visitorConsentCollected', () => {
    if (host.isConnected) void connection.consentChanged().catch(() => { /* Fail closed while assignment is unknown. */ });
  });
  void connection.initialize().catch(() => { /* No launcher before a valid assignment; no control-arm flash. */ });
}

function mount(): void {
  const host = document.querySelector<HTMLElement>('[data-sales-agent]');
  if (host) { try { mountLoader(host); } catch { /* Embed failure must not interrupt the storefront. */ } }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
document.addEventListener('shopify:section:load', mount);
