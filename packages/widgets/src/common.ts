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
