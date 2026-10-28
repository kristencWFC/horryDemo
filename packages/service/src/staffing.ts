// Storm staffing (discovery item 3: "quickly bring on up to 50 extra staff as agents in an
// outage queue"). Kristen's design 2026-10-28: the easiest lever is to add the extra
// staff's TEAMS to the outage queue — agents keep logging in to their own team, and the
// moment their team is on Q_Horry_Outage they get outage calls. The supervisor widget
// picks the teams; this module edits the queue's call distribution groups through the
// WxCC Config API (same Service App as Storm Mode).
//
// The queue's teams as first seen are its NORMAL staffing ("home" teams) — snapshotted
// once into data/staffing.json so "Return to normal" restores exactly that. Storm teams
// join distribution group 1 (they get calls right away, alongside the home teams).
//
// VERIFY on the first live test: PUT contact-service-queue/{id} with the GET body back
// (replace-style, like cad-variable). If the PUT rejects read-only fields, strip them
// here; the bulk upsert (POST contact-service-queue/bulk) is the fallback.
// Unset WXCC_OUTAGE_QUEUE_ID = simulated teams, so the widget demos without WxCC.
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { env, staffingConfigured } from './env.js';
import { JsonStore } from './store.js';
import { webexAccessToken } from './webex.js';

interface DistGroup {
  order: number;
  duration: number;
  agentGroups: { teamId: string }[];
  [k: string]: unknown;
}

export interface TeamRow {
  id: string;
  name: string;
  onQueue: boolean;
  home: boolean; // on the queue in normal (non-storm) staffing
}

export interface StaffingState {
  queue: { id: string; name: string };
  teams: TeamRow[];
  wxcc: 'synced' | 'failed' | 'not_configured';
  error?: string;
  updatedAt: string;
  updatedBy: string;
  history: { at: string; by: string; added: string[]; removed: string[] }[];
}

interface Saved {
  normalGroups: DistGroup[] | null; // snapshot of the queue's groups before the first storm change
  simOnQueue: string[]; // sim mode only
  updatedAt: string;
  updatedBy: string;
  history: StaffingState['history'];
}

// Sim mode: Horry-shaped departments (discovery: 109 employees, 33–35 CC agents).
const SIM_QUEUE = { id: 'sim-q-outage', name: 'Q_Horry_Outage' };
const SIM_TEAMS = [
  { id: 'sim-member-services', name: 'Member Services', home: true },
  { id: 'sim-billing', name: 'Billing & Collections', home: false },
  { id: 'sim-member-accounting', name: 'Member Accounting', home: false },
  { id: 'sim-engineering', name: 'Engineering', home: false },
  { id: 'sim-operations', name: 'Operations Dispatch', home: false },
  { id: 'sim-energy-services', name: 'Energy Services', home: false },
  { id: 'sim-it', name: 'IT', home: false },
];

const teamIdsOf = (groups: DistGroup[]): Set<string> =>
  new Set(groups.flatMap((g) => (g.agentGroups ?? []).map((a) => a.teamId)));

export class StaffingStore extends EventEmitter {
  private store: JsonStore<Saved>;
  private s: Saved;
  private wxcc: StaffingState['wxcc'] = staffingConfigured() ? 'synced' : 'not_configured';
  private error: string | undefined;
  private teamCache: { at: number; teams: { id: string; name: string }[] } | null = null;

  constructor(dataDir: string) {
    super();
    this.store = new JsonStore<Saved>(join(dataDir, 'staffing.json'));
    this.s = this.store.load() ?? {
      normalGroups: null,
      simOnQueue: SIM_TEAMS.filter((t) => t.home).map((t) => t.id),
      updatedAt: new Date().toISOString(),
      updatedBy: 'system',
      history: [],
    };
  }

  async get(): Promise<StaffingState> {
    if (!staffingConfigured()) return this.simState();
    try {
      const [queue, all] = await Promise.all([this.getQueue(), this.listTeams()]);
      const groups = (queue.callDistributionGroups ?? []) as DistGroup[];
      const on = teamIdsOf(groups);
      const home = teamIdsOf(this.s.normalGroups ?? groups);
      const teams = this.pickable(all, new Set([...on, ...home]));
      this.wxcc = 'synced';
      this.error = undefined;
      return this.state({ id: String(queue.id), name: String(queue.name ?? 'Outage queue') }, teams.map((t) => ({ ...t, onQueue: on.has(t.id), home: home.has(t.id) })));
    } catch (err) {
      this.wxcc = 'failed';
      this.error = (err as Error).message.slice(0, 300);
      return this.state({ id: env.WXCC_OUTAGE_QUEUE_ID ?? '', name: 'Outage queue' }, []);
    }
  }

  /** Make exactly `teamIds` the teams on the outage queue. */
  async set(teamIds: string[], by: string): Promise<StaffingState> {
    const want = new Set(teamIds.filter(Boolean));
    if (want.size === 0) throw new Error('Keep at least one team on the outage queue.');
    if (!staffingConfigured()) {
      const before = new Set(this.s.simOnQueue);
      this.s.simOnQueue = SIM_TEAMS.map((t) => t.id).filter((id) => want.has(id));
      this.record(before, new Set(this.s.simOnQueue), by);
      return this.simState();
    }
    const queue = await this.getQueue();
    const groups = structuredClone((queue.callDistributionGroups ?? []) as DistGroup[]);
    const before = teamIdsOf(groups);
    const allowed = new Set(this.pickable(await this.listTeams(), new Set([...before, ...teamIdsOf(this.s.normalGroups ?? [])])).map((t) => t.id));
    const foreign = [...want].filter((id) => !allowed.has(id));
    if (foreign.length) throw new Error(`Not a Horry team: ${foreign.join(', ')}`);
    this.s.normalGroups ??= structuredClone(groups); // first change: remember normal staffing
    for (const g of groups) g.agentGroups = (g.agentGroups ?? []).filter((a) => want.has(a.teamId));
    const kept = teamIdsOf(groups);
    const first = groups.find((g) => g.agentGroups.length) ?? groups[0];
    const target: DistGroup = first ?? { order: 1, duration: 0, agentGroups: [] };
    if (!first) groups.push(target);
    for (const id of want) if (!kept.has(id)) target.agentGroups.push({ teamId: id });
    await this.putQueue(queue, groups.filter((g) => g.agentGroups.length));
    this.record(before, want, by);
    return this.get();
  }

  /** Back to the staffing the queue had before the first storm change. */
  async reset(by: string): Promise<StaffingState> {
    if (!staffingConfigured()) return this.set(SIM_TEAMS.filter((t) => t.home).map((t) => t.id), by);
    if (!this.s.normalGroups) return this.get(); // never changed
    const queue = await this.getQueue();
    const before = teamIdsOf((queue.callDistributionGroups ?? []) as DistGroup[]);
    await this.putQueue(queue, this.s.normalGroups);
    this.record(before, teamIdsOf(this.s.normalGroups), by);
    this.s.normalGroups = null; // the next storm snapshots afresh (Control Hub may have changed)
    this.store.save(this.s);
    return this.get();
  }

  // ---- internals -------------------------------------------------------------------

  private record(before: Set<string>, after: Set<string>, by: string): void {
    const added = [...after].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));
    this.s.updatedAt = new Date().toISOString();
    this.s.updatedBy = by || 'supervisor';
    this.s.history.push({ at: this.s.updatedAt, by: this.s.updatedBy, added, removed });
    this.s.history = this.s.history.slice(-30);
    this.store.save(this.s);
    this.emit('change');
    console.log(`HORRY STAFFING by ${this.s.updatedBy}: +[${added.join(',')}] -[${removed.join(',')}] (wxcc ${this.wxcc})`);
  }

  private state(queue: StaffingState['queue'], teams: TeamRow[]): StaffingState {
    teams.sort((a, b) => Number(b.home) - Number(a.home) || a.name.localeCompare(b.name));
    return {
      queue,
      teams,
      wxcc: this.wxcc,
      ...(this.error ? { error: this.error } : {}),
      updatedAt: this.s.updatedAt,
      updatedBy: this.s.updatedBy,
      history: this.s.history.slice(-10),
    };
  }

  private simState(): StaffingState {
    const on = new Set(this.s.simOnQueue);
    return this.state(SIM_QUEUE, SIM_TEAMS.map((t) => ({ id: t.id, name: t.name, home: t.home, onQueue: on.has(t.id) })));
  }

  private base(): string {
    return `${env.WXCC_API_BASE.replace(/\/$/, '')}/organization/${env.WEBEX_ORG_ID}`;
  }

  private async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await webexAccessToken()}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  private async getQueue(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base()}/contact-service-queue/${env.WXCC_OUTAGE_QUEUE_ID}`, { headers: await this.headers() });
    if (!res.ok) throw new Error(`GET contact-service-queue HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as Record<string, unknown>;
  }

  private async putQueue(queue: Record<string, unknown>, groups: DistGroup[]): Promise<void> {
    const body = { ...queue, callDistributionGroups: groups };
    const res = await fetch(`${this.base()}/contact-service-queue/${env.WXCC_OUTAGE_QUEUE_ID}`, {
      method: 'PUT',
      headers: await this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      this.wxcc = 'failed';
      this.error = `PUT contact-service-queue HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      throw new Error(this.error);
    }
  }

  /** Teams the picker may offer: name starts with WXCC_STAFFING_TEAM_PREFIX, or already on the queue. */
  private pickable(teams: { id: string; name: string }[], keep: Set<string>): { id: string; name: string }[] {
    const prefix = env.WXCC_STAFFING_TEAM_PREFIX.toLowerCase();
    return teams.filter((t) => keep.has(t.id) || t.name.toLowerCase().startsWith(prefix));
  }

  /** v2/team, every page; cached a minute (teams rarely change mid-storm). */
  private async listTeams(): Promise<{ id: string; name: string }[]> {
    if (this.teamCache && Date.now() - this.teamCache.at < 60_000) return this.teamCache.teams;
    const teams: { id: string; name: string }[] = [];
    const headers = await this.headers();
    for (let page = 0; page < 20; page++) {
      const res = await fetch(`${this.base()}/v2/team?page=${page}&pageSize=100`, { headers });
      if (!res.ok) throw new Error(`GET v2/team HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = (await res.json()) as { data?: { id: string; name: string; active?: boolean }[]; meta?: { totalPages?: number } };
      for (const t of j.data ?? []) if (t.active !== false) teams.push({ id: t.id, name: t.name });
      if (!j.data?.length || page + 1 >= (j.meta?.totalPages ?? 1)) break;
    }
    this.teamCache = { at: Date.now(), teams };
    return teams;
  }
}
