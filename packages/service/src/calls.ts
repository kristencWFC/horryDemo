// One row per AI conversation (voice or chat), keyed by the WxCC interaction GUID that
// rides the bridge as X-Call-GUID / the agent's sip_call_guid. The flow seeds the row
// (GET api/call-context); the initiation webhook, every tool call and the post-call
// webhook add to it. This is what the widgets' "what the AI did" card and the storm
// dashboard read.
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { JsonStore } from './store.js';
import { last10 } from './env.js';

export interface JourneyStep {
  at: string;
  step: string; // identified | outage_known | outage_reported | subscribed | billing | payment_link | payment | extension | escalated | wrapped
  detail: string;
}

/** The live-agent part of an escalated call: Cisco AI Assistant's wrap-up summary (or a
 *  simulated stand-in until the summaries API is confirmed — see agent-summaries.ts). */
export interface AgentLeg {
  agentName: string;
  team: string;
  endedAt: string;
  wrapUpCode: string;
  summary: { reason: string; actions: string; status: string; followUp: string };
  source: 'cisco' | 'posted' | 'simulated';
}

export interface CallRow {
  guid: string;
  ani: string;
  dnis: string;
  channel: 'voice' | 'chat';
  startedAt: string;
  endedAt?: string;
  memberSep?: string;
  memberName?: string;
  stormMode: boolean;
  journey: JourneyStep[];
  tags: string[];
  outcome?: string;
  escalation?: { department: string; urgency: string; reason: string; summary: string; at: string };
  conversationId?: string;
  durationSec?: number;
  summary?: string;
  sentiment?: 'positive' | 'neutral' | 'negative';
  transcript?: { role: 'agent' | 'user'; text: string }[];
  outageId?: string;
  paymentId?: string;
  agentLeg?: AgentLeg;
}

export class CallStore extends EventEmitter {
  private rows: CallRow[];
  private store: JsonStore<CallRow[]>;

  constructor(dataDir: string) {
    super();
    this.store = new JsonStore<CallRow[]>(join(dataDir, 'calls.json'));
    this.rows = this.store.load() ?? [];
  }

  private save(): void {
    if (this.rows.length > 500) this.rows = this.rows.slice(-500);
    this.store.save(this.rows);
    this.emit('change');
  }

  reset(): void {
    this.rows = [];
    this.save();
  }

  all(): CallRow[] {
    return [...this.rows].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(guid: string): CallRow | undefined {
    return this.rows.find((r) => r.guid === guid);
  }

  seed(row: Pick<CallRow, 'guid' | 'ani' | 'dnis' | 'channel' | 'stormMode'> & Partial<CallRow>): CallRow {
    const existing = this.get(row.guid);
    if (existing) {
      Object.assign(existing, row);
      this.save();
      return existing;
    }
    const r: CallRow = { journey: [], tags: [], startedAt: new Date().toISOString(), ...row };
    this.rows.push(r);
    this.save();
    return r;
  }

  /** Newest open row for this caller within 10 minutes — how the initiation webhook (caller_id only) finds the seeded row. */
  findRecentByAni(ani: string): CallRow | undefined {
    const p = last10(ani);
    const cutoff = Date.now() - 10 * 60_000;
    return this.all().find((r) => last10(r.ani) === p && !r.endedAt && Date.parse(r.startedAt) > cutoff);
  }

  /** Resolve a tool call to a row: by GUID, else adopt the caller's recent row, else create one. */
  resolve(guid: string | undefined, callerId: string | undefined, stormMode: boolean): CallRow {
    if (guid) {
      const hit = this.get(guid);
      if (hit) return hit;
    }
    const byAni = callerId ? this.findRecentByAni(callerId) : undefined;
    if (byAni) return byAni;
    return this.seed({ guid: guid || `adhoc-${Date.now()}`, ani: last10(callerId), dnis: '', channel: 'voice', stormMode });
  }

  step(row: CallRow, step: string, detail: string, tag?: string): void {
    row.journey.push({ at: new Date().toISOString(), step, detail });
    if (tag && !row.tags.includes(tag)) row.tags.push(tag);
    this.save();
  }

  patch(row: CallRow, p: Partial<CallRow>): void {
    Object.assign(row, p);
    this.save();
  }
}
