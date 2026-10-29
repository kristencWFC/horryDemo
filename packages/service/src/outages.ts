// Outages + restoration subscriptions — the stand-in for Horry's outage management
// system (OMS vendor still an open question; HLD §2.3). An outage covers a
// substation/circuit (feeder) or a single service location. Members are matched to
// outages by the SubStation/Circuit/Location fields NextGen's AllUpnAccounts returns.
//
// The promises the AI makes ("we'll text you when it's back") live here as
// subscriptions; restore()/setEtr() emit events that notify.ts turns into texts / calls.
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { JsonStore } from './store.js';
import type { Member } from './members.js';

export type OutageStatus = 'active' | 'restored';

export interface Outage {
  id: string; // OMS-style id, e.g. OMS-261103-01
  area: string; // spoken area name ("Socastee, along Dick Pond Road")
  substation: number;
  circuit: number | null; // null = whole substation
  location: string | null; // set = single-location (individual / nested) outage
  customers: number;
  cause: string; // spoken ("a tree on the line")
  crew: string; // spoken ("crews are on site")
  etr: string | null; // ISO
  status: OutageStatus;
  startedAt: string;
  restoredAt?: string;
  reports: number; // member reports received (AI + text + agent)
  source: 'oms' | 'member_report' | 'nested';
}

export interface Subscription {
  id: string;
  outageId: string;
  memberSep: string;
  memberName: string;
  address: string;
  phone: string;
  channel: 'sms' | 'voice';
  createdAt: string;
  createdBy: 'ai' | 'agent' | 'sms' | 'web';
  status: 'waiting' | 'notified' | 'confirmed_on' | 'still_out' | 'failed';
  notifiedAt?: string;
  reply?: string;
}

interface State {
  outages: Outage[];
  subs: Subscription[];
  seq: number;
}

const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

function seedState(): State {
  return {
    seq: 3,
    subs: [],
    outages: [
      {
        id: 'OMS-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-01',
        area: 'Socastee, along Dick Pond Road and Peachtree Road',
        substation: 7,
        circuit: 2,
        location: null,
        customers: 1240,
        cause: 'a tree on the line',
        crew: 'crews are on site',
        etr: hours(2.5),
        status: 'active',
        startedAt: hours(-1.25),
        reports: 186,
        source: 'oms',
      },
      {
        id: 'OMS-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-02',
        area: 'Aynor, north of Highway 501',
        substation: 5,
        circuit: 1,
        location: null,
        customers: 312,
        cause: 'equipment damage that is still being assessed',
        crew: 'a crew is on the way',
        etr: hours(4),
        status: 'active',
        startedAt: hours(-0.5),
        reports: 41,
        source: 'oms',
      },
    ],
  };
}

export class OutageStore extends EventEmitter {
  private s: State;
  private store: JsonStore<State>;

  constructor(dataDir: string) {
    super();
    this.store = new JsonStore<State>(join(dataDir, 'outages.json'));
    this.s = this.store.load() ?? seedState();
  }

  private save(): void {
    this.store.save(this.s);
    this.emit('change');
  }

  reset(): void {
    this.s = seedState();
    this.save();
  }

  all(): Outage[] {
    return [...this.s.outages].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  active(): Outage[] {
    const act = this.all().filter((o) => o.status === 'active');
    // Demo safety: an active outage whose estimate has passed (e.g. seeded yesterday) rolls
    // forward to 2½ hours from now, so Savannah never reads yesterday's time (2026-10-29).
    const now = Date.now();
    let rolled = false;
    for (const o of act) {
      if (o.etr && Date.parse(o.etr) < now) {
        o.etr = new Date(Math.ceil((now + 2.5 * 3600_000) / 300_000) * 300_000).toISOString();
        rolled = true;
      }
    }
    if (rolled) this.save();
    return act;
  }

  get(id: string): Outage | undefined {
    return this.s.outages.find((o) => o.id === id);
  }

  /** The active outage covering this member: single-location first, then circuit, then substation. */
  forMember(m: Member): Outage | undefined {
    const act = this.active();
    return (
      act.find((o) => o.location === m.Location) ??
      act.find((o) => !o.location && o.substation === m.SubStation && o.circuit === m.Circuit) ??
      act.find((o) => !o.location && o.substation === m.SubStation && o.circuit === null)
    );
  }

  private nextId(): string {
    this.s.seq += 1;
    return 'OMS-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + String(this.s.seq).padStart(2, '0');
  }

  /**
   * A member reported an outage the OMS didn't know. Three single-location reports on one
   * circuit promote to a circuit outage ("we're seeing several reports from your area").
   */
  report(m: Member, details: { hazard: string; wholeHouse: string; neighbors: string; text?: string }, nested = false): Outage {
    const known = this.forMember(m);
    if (known && !nested) {
      known.reports += 1;
      this.save();
      return known;
    }
    const sameCircuit = this.active().filter(
      (o) => o.location && o.substation === m.SubStation && o.circuit === m.Circuit && o.source === 'member_report'
    );
    if (!nested && sameCircuit.length >= 2) {
      for (const o of sameCircuit) o.status = 'restored'; // folded into the circuit outage below
      const circuit: Outage = {
        id: this.nextId(),
        area: `${m.City.charAt(0) + m.City.slice(1).toLowerCase()} — substation ${m.SubStation}, circuit ${m.Circuit}`,
        substation: m.SubStation,
        circuit: m.Circuit,
        location: null,
        customers: 40 + sameCircuit.length * 25,
        cause: 'still being investigated',
        crew: 'a crew has been dispatched',
        etr: null,
        status: 'active',
        startedAt: new Date().toISOString(),
        reports: sameCircuit.length + 1,
        source: 'member_report',
      };
      // Move the folded locations' subscriptions onto the circuit outage so nobody is dropped.
      for (const sub of this.s.subs) if (sameCircuit.some((o) => o.id === sub.outageId)) sub.outageId = circuit.id;
      this.s.outages.push(circuit);
      this.save();
      this.emit('cluster', circuit);
      return circuit;
    }
    const o: Outage = {
      id: this.nextId(),
      area: m.ServAddr,
      substation: m.SubStation,
      circuit: m.Circuit,
      location: m.Location,
      customers: 1,
      cause: details.hazard && details.hazard !== 'none' ? details.hazard.replace(/_/g, ' ') : 'still being investigated',
      crew: details.hazard && details.hazard !== 'none' ? 'an emergency crew has been dispatched' : 'a crew will be assigned shortly',
      etr: null,
      status: 'active',
      startedAt: new Date().toISOString(),
      reports: 1,
      source: nested ? 'nested' : 'member_report',
    };
    this.s.outages.push(o);
    this.save();
    return o;
  }

  setEtr(id: string, etr: string | null): Outage | undefined {
    const o = this.get(id);
    if (!o) return undefined;
    o.etr = etr;
    this.save();
    this.emit('etr', o);
    return o;
  }

  restore(id: string): Outage | undefined {
    const o = this.get(id);
    if (!o || o.status === 'restored') return o;
    o.status = 'restored';
    o.restoredAt = new Date().toISOString();
    this.save();
    this.emit('restored', o);
    return o;
  }

  // ---- subscriptions ----------------------------------------------------------------

  subscriptions(): Subscription[] {
    return [...this.s.subs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  subsFor(outageId: string): Subscription[] {
    return this.s.subs.filter((x) => x.outageId === outageId);
  }

  subscribe(sub: Omit<Subscription, 'id' | 'createdAt' | 'status'>): Subscription {
    const existing = this.s.subs.find((x) => x.outageId === sub.outageId && x.memberSep === sub.memberSep && x.status === 'waiting');
    if (existing) {
      Object.assign(existing, { phone: sub.phone, channel: sub.channel });
      this.save();
      return existing;
    }
    const s: Subscription = { ...sub, id: `SUB-${this.s.subs.length + 1}`, createdAt: new Date().toISOString(), status: 'waiting' };
    this.s.subs.push(s);
    this.save();
    return s;
  }

  updateSub(id: string, patch: Partial<Subscription>): void {
    const s = this.s.subs.find((x) => x.id === id);
    if (!s) return;
    Object.assign(s, patch);
    this.save();
  }

  /** Most recent notified subscription for a phone — used to interpret an SMS reply. */
  lastNotifiedFor(phone: string): Subscription | undefined {
    return this.subscriptions().find((x) => x.phone === phone && (x.status === 'notified' || x.status === 'waiting'));
  }
}

export function spokenEtr(etr: string | null, tz: string): string {
  if (!etr) return 'not available yet — crews are still assessing';
  const d = new Date(etr);
  const today = new Date().toLocaleDateString('en-US', { timeZone: tz }) === d.toLocaleDateString('en-US', { timeZone: tz });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  return today ? `${time} today` : `${d.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz })} at ${time}`;
}
