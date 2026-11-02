// Payment hand-off (demo use case 1, Kristen 2026-11-02): a live agent hands the caller to
// Savannah for the payment and gets the call back when she is done.
//
//   1. Agent clicks "Hand payment to Savannah" → POST api/agent-desk/handoff → a record with a
//      4-digit reference, keyed by the caller's number.
//   2. Agent transfers the call to EP_KC_Horry_Payment (972-903-8486). That flow asks
//      GET /api/handoff/by-ani/{ANI} for the agent's email, then bridges to Savannah on 1151.
//   3. Savannah's initiation webhook sees the open hand-off for that caller and gets the
//      payment-only greeting + playbook; her payment tools post steps here, which the agent's
//      Calls page shows live.
//   4. She wraps up → the controller drops her leg → the flow's Queue To Agent sends the member
//      back to the same agent.
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { JsonStore } from './store.js';
import { last10 } from './env.js';

export type HandoffStatus = 'pending' | 'with_ai' | 'paid' | 'returning' | 'done' | 'failed';

export interface HandoffStep {
  at: string;
  step: string;
  detail: string;
}

export interface Handoff {
  ref: string;
  guid: string;
  ani: string;
  memberSep: string;
  memberName: string;
  agentEmail: string;
  agentName: string;
  amount: number;
  status: HandoffStatus;
  steps: HandoffStep[];
  createdAt: string;
  updatedAt: string;
  confirmation?: string;
  card?: string;
}

/** A hand-off is "live" for this long; after that the flow and the widget ignore it. */
const ACTIVE_MS = 30 * 60_000;
const ACTIVE: HandoffStatus[] = ['pending', 'with_ai', 'paid', 'returning'];

export class HandoffStore extends EventEmitter {
  private rows: Handoff[];
  private store: JsonStore<Handoff[]>;

  constructor(dataDir: string) {
    super();
    this.store = new JsonStore<Handoff[]>(join(dataDir, 'handoffs.json'));
    this.rows = this.store.load() ?? [];
  }

  private save(): void {
    if (this.rows.length > 200) this.rows = this.rows.slice(-200);
    this.store.save(this.rows);
    this.emit('change');
  }

  reset(): void {
    this.rows = [];
    this.save();
  }

  all(): Handoff[] {
    return [...this.rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(ref: string): Handoff | undefined {
    return this.rows.find((h) => h.ref === ref);
  }

  private isActive(h: Handoff): boolean {
    return ACTIVE.includes(h.status) && Date.now() - Date.parse(h.createdAt) < ACTIVE_MS;
  }

  /** The open hand-off for this caller (the flow and Savannah only know the caller's number). */
  activeByAni(ani: string): Handoff | undefined {
    const p = last10(ani);
    return p ? this.all().find((h) => this.isActive(h) && h.ani === p) : undefined;
  }

  activeForAgent(agentEmail: string): Handoff | undefined {
    const e = agentEmail.trim().toLowerCase();
    return e ? this.all().find((h) => this.isActive(h) && h.agentEmail.toLowerCase() === e) : undefined;
  }

  create(p: Pick<Handoff, 'guid' | 'ani' | 'memberSep' | 'memberName' | 'agentEmail' | 'agentName' | 'amount'>): Handoff {
    // One live hand-off per caller: an older one for the same number is superseded.
    for (const old of this.rows) if (this.isActive(old) && old.ani === last10(p.ani)) old.status = 'failed';
    let ref = '';
    do ref = String(1000 + Math.floor(Math.random() * 9000));
    while (this.rows.some((h) => h.ref === ref));
    const now = new Date().toISOString();
    const h: Handoff = { ...p, ani: last10(p.ani), ref, status: 'pending', steps: [], createdAt: now, updatedAt: now };
    h.steps.push({ at: now, step: 'handoff', detail: `${p.agentName} handed the ${money(p.amount)} payment to Savannah. Waiting for the transfer.` });
    this.rows.push(h);
    this.save();
    return h;
  }

  step(h: Handoff, step: string, detail: string, status?: HandoffStatus, patch: Partial<Handoff> = {}): void {
    const now = new Date().toISOString();
    h.steps.push({ at: now, step, detail });
    if (status) h.status = status;
    Object.assign(h, patch, { updatedAt: now });
    this.save();
  }
}

export const money = (n: number | null | undefined) => `$${(n ?? 0).toFixed(2)}`;
