// Storm Mode. The source of truth the WxCC flow reads is a WxCC GLOBAL VARIABLE
// (Kristen's decision 2026-10-27): the supervisor's desktop button → POST api/mode →
// this module PUTs the variable's defaultValue through the WxCC Config API with a
// Service App token (writes want a service app — kc-wiki wxcc-bulk-config-apis).
// The local copy is what our own pages show, and is the whole story when WxCC isn't
// configured (sim mode).
//
// VERIFY on the first live test: a new contact must see the new defaultValue without a
// flow republish (expected — the flow reads the global at runtime).
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { env, wxccConfigured } from './env.js';
import { JsonStore } from './store.js';
import { webexAccessToken } from './webex.js';

export interface ModeState {
  storm: boolean;
  broadcast: string; // spoken once by the AI when set
  updatedAt: string;
  updatedBy: string;
  wxcc: 'synced' | 'failed' | 'not_configured';
  wxccError?: string;
  history: { at: string; by: string; storm: boolean }[];
}

export class ModeStore extends EventEmitter {
  private s: ModeState;
  private store: JsonStore<ModeState>;

  constructor(private readonly dataDir: string) {
    super();
    this.store = new JsonStore<ModeState>(join(dataDir, 'mode.json'));
    this.s = this.store.load() ?? {
      storm: false,
      broadcast: '',
      updatedAt: new Date().toISOString(),
      updatedBy: 'system',
      wxcc: wxccConfigured() ? 'synced' : 'not_configured',
      history: [],
    };
  }

  get(): ModeState {
    return { ...this.s, history: this.s.history.slice(-20) };
  }

  async set(storm: boolean, by: string, broadcast?: string): Promise<ModeState> {
    this.s.storm = storm;
    if (broadcast !== undefined) this.s.broadcast = broadcast;
    this.s.updatedAt = new Date().toISOString();
    this.s.updatedBy = by || 'supervisor';
    this.s.history.push({ at: this.s.updatedAt, by: this.s.updatedBy, storm });
    if (wxccConfigured()) {
      try {
        await writeGlobalVariable(storm ? 'true' : 'false');
        this.s.wxcc = 'synced';
        delete this.s.wxccError;
      } catch (err) {
        this.s.wxcc = 'failed';
        this.s.wxccError = (err as Error).message.slice(0, 300);
        console.log(`HORRY MODE WxCC global variable write FAILED: ${this.s.wxccError}`);
      }
    } else {
      this.s.wxcc = 'not_configured';
    }
    this.store.save(this.s);
    this.emit('change', this.get());
    console.log(`HORRY MODE storm=${storm} by ${this.s.updatedBy} (wxcc ${this.s.wxcc})`);
    return this.get();
  }

  setBroadcast(text: string): ModeState {
    this.s.broadcast = text;
    this.store.save(this.s);
    this.emit('change', this.get());
    return this.get();
  }
}

/** GET the variable, change only defaultValue, PUT the whole object back (Config API is replace-style). */
async function writeGlobalVariable(value: string): Promise<void> {
  const url = `${env.WXCC_API_BASE.replace(/\/$/, '')}/organization/${env.WEBEX_ORG_ID}/cad-variable/${env.WXCC_STORM_VARIABLE_ID}`;
  const token = await webexAccessToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  const cur = await fetch(url, { headers });
  if (!cur.ok) throw new Error(`GET cad-variable HTTP ${cur.status}: ${(await cur.text()).slice(0, 200)}`);
  const body = (await cur.json()) as Record<string, unknown>;
  body.defaultValue = value;
  const put = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
  if (!put.ok) throw new Error(`PUT cad-variable HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`);
}
