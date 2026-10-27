// Webex Service App token for the WxCC Config API (Storm Mode global variable).
// Rules from kc-wiki webex-service-app-auth: refresh tokens ROTATE — persist the rotated
// one (tmp+rename, 0600) and prefer it over the env seed on startup; single-flight the
// refresh; one Service App per environment (never share with another box).
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, dataDir } from './env.js';

const tokenFile = join(dataDir, 'webex-refresh-token.json');
let cached: { token: string; exp: number } | null = null;
let inflight: Promise<string> | null = null;

function currentRefreshToken(): string {
  try {
    if (existsSync(tokenFile)) return (JSON.parse(readFileSync(tokenFile, 'utf8')) as { refresh_token: string }).refresh_token;
  } catch {
    /* fall back to the env seed */
  }
  return env.WEBEX_REFRESH_TOKEN ?? '';
}

export async function webexAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.exp) return cached.token;
  if (inflight) return inflight;
  inflight = (async () => {
    const refresh = currentRefreshToken();
    const res = await fetch('https://webexapis.com/v1/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: env.WEBEX_CLIENT_ID ?? '',
        client_secret: env.WEBEX_CLIENT_SECRET ?? '',
        refresh_token: refresh,
      }),
    });
    const j = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string; message?: string };
    if (!res.ok || !j.access_token) throw new Error(`Webex token refresh HTTP ${res.status}: ${j.message ?? ''}`);
    cached = { token: j.access_token, exp: Date.now() + ((j.expires_in ?? 3600) - 300) * 1000 };
    if (j.refresh_token && j.refresh_token !== refresh) {
      const tmp = `${tokenFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ refresh_token: j.refresh_token, at: new Date().toISOString() }));
      try {
        chmodSync(tmp, 0o600);
      } catch {
        /* Windows dev box */
      }
      renameSync(tmp, tokenFile);
      console.log('HORRY WEBEX refresh token rotated (persisted)');
    } else {
      console.log(`HORRY WEBEX refresh token ${j.refresh_token ? 'unchanged' : 'not returned'}`);
    }
    return j.access_token;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}
