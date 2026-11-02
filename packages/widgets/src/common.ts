// Shared plumbing for the Horry widgets (donor: home-services widgets/common.ts).
// House rule: ALL fetches go through joinUrl(server, 'api/...') — the service lives
// behind nginx at /horry/, so absolute paths would 404.
import type { PropertyDeclaration } from 'lit';

export const DEFAULT_SERVER = 'https://kcdev2.workflowconcepts.com/horry';

/** Join the widget's `server` base with a relative path (never hardcode `/api/...`). */
export function joinUrl(server: string, path: string): string {
  return `${server.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export async function api<T>(server: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(joinUrl(server, path), {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

/**
 * WxCC Desktop delivers `$STORE.app.darkMode` as a live STRING ATTRIBUTE
 * (`darkmode="true"|"false"`), never as a JS property — parse it ourselves.
 */
export const darkmodeProperty: PropertyDeclaration = {
  reflect: true,
  attribute: 'darkmode',
  converter: {
    fromAttribute: (value: string | null) => value === 'true' || value === '',
    toAttribute: (value: unknown) => (value ? 'true' : 'false'),
  },
};

/** "2:14 PM" today, "10/28 2:14 PM" otherwise. */
export function fmtClock(iso: string): string {
  const d = new Date(iso);
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t : `${d.getMonth() + 1}/${d.getDate()} ${t}`;
}

/** A layout binding the Desktop did not fill in (nav pages get no task bindings) arrives as the literal text. */
export const unbound = (v: unknown): string => (typeof v === 'string' && !v.startsWith('$STORE') ? v : '');

export interface DesktopLike {
  config: { init: (opts?: unknown) => Promise<void> | void };
  agentContact: { addEventListener: (ev: string, cb: (msg: unknown) => void) => void };
  actions: { getTaskMap: () => Promise<Map<string, unknown>> };
}

/** interactionId + caller number from a Desktop task / agentContact event, whatever the nesting. */
export function taskInfo(msg: unknown): { interactionId: string; ani: string } {
  const outer = (msg ?? {}) as Record<string, unknown>;
  const d = (outer.data ?? outer) as Record<string, unknown>;
  const inter = (d.interaction ?? d) as Record<string, unknown>;
  const details = (inter.callAssociatedDetails ?? {}) as Record<string, unknown>;
  return { interactionId: String(d.interactionId ?? inter.interactionId ?? ''), ani: String(details.ani ?? inter.ani ?? d.ani ?? '') };
}

// One script injection + one config.init for every Horry widget on the page.
let sdkPromise: Promise<DesktopLike | null> | undefined;

/** The WxCC Desktop JS SDK, or null in a plain-browser preview. */
export function loadDesktopSdk(): Promise<DesktopLike | null> {
  sdkPromise ??= (async () => {
    type W = { Desktop?: DesktopLike; WxccDesktopSDK?: { Desktop?: DesktopLike } };
    const w = window as unknown as W;
    const resolve = () => w.WxccDesktopSDK?.Desktop ?? w.Desktop;
    try {
      let desktop = resolve();
      if (!desktop) {
        await new Promise<void>((res, rej) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/@wxcc-desktop/sdk@3.0.1/dist/index.js';
          s.onload = () => res();
          s.onerror = () => rej(new Error('sdk script load failed'));
          document.head.appendChild(s);
        });
        desktop = resolve();
      }
      if (!desktop) throw new Error('SDK loaded but no Desktop export found');
      await desktop.config.init({ widgetName: 'horry-widgets', widgetProvider: 'wfc' });
      console.log('HORRY: Desktop SDK ready');
      return desktop;
    } catch (err) {
      console.log('HORRY: Desktop SDK unavailable —', (err as Error).message, '(plain-browser preview?)');
      return null;
    }
  })();
  return sdkPromise;
}
