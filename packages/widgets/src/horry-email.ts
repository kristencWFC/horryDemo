// <horry-email> — email ticketing board for the WxCC Desktop (a full nav page; discovery
// item 6, replacing the shared distribution group). Look and behaviour follow the
// home-services / Crete pick board: cards with topic, member and a live "waiting" age;
// Pick claims one, a supervisor can Assign one to a named agent.
//   - Board: three columns (New / Picked / Sent) + topic filter chips.
//   - Detail pane: the email, the member's account summary (+ outage), an AI draft built
//     from the account (editable), Send / Release / Assign.
//   - Storm Mode on (GET api/mode → storm 'true'): an "Outage groups" view — one reply
//     per outage answers every member who emailed about it ({first_name} filled per member).
// Polls every 5 s; a draft being edited is never overwritten by a poll.
//
// Desktop layout: <horry-email server="https://kcdev2.workflowconcepts.com/horry"
//   agentname="$STORE.agent.agentName" darkmode="$STORE.app.darkMode">
// Optional: assign="false" hides the supervisor Assign control.
import { LitElement, css, html, nothing } from 'lit';
import { DEFAULT_SERVER, api, darkmodeProperty, fmtClock } from './common.js';
import { themeStyles } from './theme.js';

interface EmailCard {
  id: string;
  from: string;
  fromName: string;
  subject: string;
  preview: string;
  topic: string;
  topicLabel: string;
  receivedAt: string;
  waitingMin: number;
  status: 'new' | 'picked' | 'sent';
  agent: string;
  assignedBy: string;
  member: { memberSep: string; name: string; address: string; lifeSupport: boolean; pastDue: number } | null;
  matchedBy: 'email' | 'account_number' | null;
  outageId: string;
  outageArea: string;
  sentAt: string;
  bulk: boolean;
}

interface OutageDto {
  id: string;
  area: string;
  customers: number;
  cause: string;
  crew: string;
  etr: string | null;
  etrText: string;
}

interface Account {
  memberSep: string;
  name: string;
  address: string;
  phone: string | null;
  email: string | null;
  status: string;
  rate: string;
  lifeSupport: boolean;
  amountDue: number;
  dueDate: string;
  pastDue: number;
  cutOffDate: string | null;
  lastPayment: number;
  paymentDate: string;
  budgetAmount: number;
  bankDraft: boolean;
  cardOnFile: string;
  extensionAllowed: boolean;
  kwhLast30: number;
  kwhSameMonthLastYear: number;
  usageChangePct: number;
  recentNotes: { at: string; type: string; text: string }[];
}

interface EmailDetail extends EmailCard {
  body: string;
  draft: string;
  reply: { subject: string; text: string; to: string; sentAt: string; by: string; bulkOutageId?: string } | null;
  history: { at: string; by: string; what: string }[];
  account: Account | null;
  outage: OutageDto | null;
}

interface Group {
  outage: OutageDto;
  open: number;
  sent: number;
  emailIds: string[];
  senders: string[];
  lifeSupport: boolean;
}

interface ListDto {
  emails: EmailCard[];
  counts: { new: number; picked: number; sent: number };
  topics: Record<string, string>;
  groups?: Group[];
}

const money = (n: number) => `$${n.toFixed(2)}`;

function age(min: number): string {
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ${min % 60} m` : `${Math.floor(h / 24)} d ${h % 24} h`;
}

export class HorryEmail extends LitElement {
  static properties = {
    server: { type: String },
    agentname: { type: String },
    assign: { type: String },
    darkmode: darkmodeProperty,
    list: { state: true },
    storm: { state: true },
    view: { state: true },
    topic: { state: true },
    selected: { state: true },
    detail: { state: true },
    draft: { state: true },
    dirty: { state: true },
    basis: { state: true },
    agents: { state: true },
    assignTo: { state: true },
    groupDraft: { state: true },
    busy: { state: true },
    error: { state: true },
    toast: { state: true },
    now: { state: true },
  };

  server = DEFAULT_SERVER;
  agentname = '';
  assign = 'true';
  darkmode = false;
  list: ListDto | null = null;
  storm = false;
  view: 'board' | 'groups' = 'board';
  topic = '';
  selected = '';
  detail: EmailDetail | null = null;
  draft = '';
  dirty = false;
  basis: string[] = [];
  agents: string[] = [];
  assignTo = '';
  /** Outage id → editable group reply text. */
  groupDraft: Record<string, string> = {};
  busy = '';
  error = '';
  toast = '';
  now = Date.now();
  private timer: number | undefined;
  private toastTimer: number | undefined;
  private stormSeen = false;

  static styles = [
    themeStyles,
    css`
      :host { display: flex; flex-direction: column; min-height: 0; gap: 10px; }
      .head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; justify-content: space-between; }
      .tabs, .chips, .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
      .tab { border-radius: 999px; padding: 4px 12px; }
      .tab.on { background: var(--h-navy); border-color: var(--h-navy); color: var(--h-bg); font-weight: 600; }
      .chip { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
      .chip.on { background: var(--h-accent-soft); border-color: var(--h-accent); color: var(--h-accent); font-weight: 600; }
      .stormflag { font-weight: 600; color: var(--h-accent); }
      .main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(360px, 1fr); gap: 12px; }
      @media (max-width: 1000px) { .main { grid-template-columns: 1fr; } }
      .board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; min-height: 0; overflow: auto; align-content: start; }
      .col { background: var(--h-soft); border-radius: 8px; padding: 8px; display: grid; gap: 6px; align-content: start; min-height: 120px; }
      .colhead { display: flex; justify-content: space-between; align-items: center; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--h-dim); padding: 0 2px 4px; }
      .ecard { border: 1px solid var(--h-border); border-left: 4px solid var(--h-navy); background: var(--h-bg); border-radius: 6px; padding: 8px; display: grid; gap: 4px; cursor: pointer; text-align: left; }
      .ecard:hover { border-color: var(--h-text); }
      .ecard.sel { outline: 2px solid var(--h-accent); }
      .ecard.t-outage { border-left-color: var(--h-accent); }
      .ecard.mine { background: var(--h-accent-soft); }
      .ecard .who { font-weight: 600; display: flex; justify-content: space-between; gap: 6px; }
      .ecard .subj { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ecard .meta { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: 12px; }
      .age { font-variant-numeric: tabular-nums; font-size: 12px; white-space: nowrap; }
      .age.warn { color: var(--h-warn); font-weight: 600; }
      .age.bad { color: var(--h-danger); font-weight: 600; }
      .pane { border: 1px solid var(--h-border); border-radius: 8px; padding: 12px; overflow: auto; min-height: 0; display: grid; gap: 12px; align-content: start; }
      .empty { color: var(--h-dim); padding: 24px; text-align: center; }
      .mail { background: var(--h-soft); border-radius: 6px; padding: 10px; white-space: pre-wrap; }
      .kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; }
      .kv dt { color: var(--h-dim); }
      .kv dd { margin: 0; }
      textarea, select, input[type='text'] {
        font: inherit; width: 100%; padding: 8px; border-radius: 6px;
        border: 1px solid var(--h-border); background: var(--h-bg); color: var(--h-text);
      }
      textarea { min-height: 220px; resize: vertical; line-height: 1.5; }
      .ai { font-size: 11px; font-weight: 600; color: var(--h-accent); text-transform: uppercase; letter-spacing: 0.05em; }
      .basis { font-size: 12px; margin: 0; padding-left: 18px; color: var(--h-dim); }
      .toast { position: sticky; top: 0; z-index: 2; background: var(--h-navy); color: var(--h-bg); padding: 6px 12px; border-radius: 6px; }
      .groups { display: grid; gap: 10px; overflow: auto; min-height: 0; }
      .big { font-size: 15px; font-weight: 600; color: var(--h-navy); }
      .hist { font-size: 12px; color: var(--h-dim); margin: 0; padding-left: 18px; }
      .sentbox { border-left: 3px solid var(--h-ok); background: var(--h-ok-soft); padding: 8px 10px; border-radius: 0 6px 6px 0; white-space: pre-wrap; }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
    this.timer = window.setInterval(() => {
      this.now = Date.now();
      void this.refresh();
    }, 5000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.timer);
    window.clearTimeout(this.toastTimer);
  }

  private get me(): string {
    return this.agentname || 'Agent';
  }

  private get canAssign(): boolean {
    return this.assign !== 'false';
  }

  private say(msg: string): void {
    this.toast = msg;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toast = ''), 4000);
  }

  private async refresh(): Promise<void> {
    try {
      const [list, mode, agents] = await Promise.all([
        api<ListDto>(this.server, `api/emails?group=outage&agent=${encodeURIComponent(this.me)}`),
        api<{ storm: 'true' | 'false' }>(this.server, 'api/mode'),
        this.canAssign ? api<{ agents: string[] }>(this.server, 'api/emails/agents') : Promise.resolve({ agents: [] }),
      ]);
      this.list = list;
      this.storm = mode.storm === 'true';
      this.agents = agents.agents;
      if (this.storm && !this.stormSeen) this.view = 'groups'; // first time storm is seen, open the groups view
      this.stormSeen = this.storm;
      if (!this.storm && this.view === 'groups') this.view = 'board';
      this.error = '';
      if (this.selected) await this.loadDetail(this.selected, false);
    } catch (err) {
      this.error = `Can't reach the email service: ${(err as Error).message}`;
    }
  }

  private async loadDetail(id: string, fresh: boolean): Promise<void> {
    const d = await api<EmailDetail>(this.server, `api/emails/${encodeURIComponent(id)}`);
    if (this.selected !== id) return;
    this.detail = d;
    if (fresh || !this.dirty) this.draft = d.status === 'sent' ? (d.reply?.text ?? '') : d.draft;
    // Auto-draft the first time the holder opens their own email.
    if (fresh && d.status === 'picked' && this.isMine(d) && !d.draft) await this.makeDraft();
  }

  private isMine(e: EmailCard): boolean {
    return e.status === 'picked' && e.agent.toLowerCase() === this.me.toLowerCase();
  }

  private async open(id: string): Promise<void> {
    if (this.selected === id) return;
    this.selected = id;
    this.detail = null;
    this.draft = '';
    this.dirty = false;
    this.basis = [];
    this.assignTo = '';
    try {
      await this.loadDetail(id, true);
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  private async run(label: string, fn: () => Promise<void>): Promise<void> {
    this.busy = label;
    this.error = '';
    try {
      await fn();
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.busy = '';
    }
  }

  private pick(id: string): Promise<void> {
    return this.run('pick', async () => {
      await api(this.server, `api/emails/${id}/pick`, { method: 'POST', body: { agent: this.me } });
      this.say('Email picked. It is yours now.');
      this.selected = '';
      await this.open(id);
      await this.refresh();
    });
  }

  private release(id: string): Promise<void> {
    return this.run('release', async () => {
      await api(this.server, `api/emails/${id}/release`, { method: 'POST', body: { agent: this.me } });
      this.say('Email returned to the board.');
      this.dirty = false;
      await this.refresh();
    });
  }

  private doAssign(id: string): Promise<void> {
    const to = this.assignTo.trim();
    if (!to) return Promise.resolve();
    return this.run('assign', async () => {
      await api(this.server, `api/emails/${id}/assign`, { method: 'POST', body: { agent: to, by: this.me } });
      this.say(`Assigned to ${to}.`);
      this.assignTo = '';
      await this.refresh();
    });
  }

  private makeDraft(): Promise<void> {
    const id = this.selected;
    return this.run('draft', async () => {
      const r = await api<{ text: string; basis: string[] }>(this.server, `api/emails/${id}/draft`, { method: 'POST', body: { agent: this.me } });
      if (this.selected !== id) return;
      this.draft = r.text;
      this.basis = r.basis;
      this.dirty = false;
    });
  }

  private send(id: string): Promise<void> {
    const text = this.draft.trim();
    if (!text) return Promise.resolve();
    return this.run('send', async () => {
      const r = await api<{ accountNote: string }>(this.server, `api/emails/${id}/send`, { method: 'POST', body: { agent: this.me, text } });
      this.dirty = false;
      this.say(r.accountNote === 'logged' ? 'Reply sent and noted on the member account.' : 'Reply sent.');
      await this.refresh();
    });
  }

  private async loadGroupDraft(outageId: string): Promise<void> {
    await this.run(`gdraft-${outageId}`, async () => {
      const r = await api<{ text: string }>(this.server, `api/emails/outage/${encodeURIComponent(outageId)}/draft?agent=${encodeURIComponent(this.me)}`);
      this.groupDraft = { ...this.groupDraft, [outageId]: r.text };
    });
  }

  private sendGroup(g: Group): Promise<void> {
    const text = this.groupDraft[g.outage.id];
    return this.run(`gsend-${g.outage.id}`, async () => {
      const r = await api<{ sent: number }>(this.server, `api/emails/outage/${encodeURIComponent(g.outage.id)}/reply`, {
        method: 'POST',
        body: { agent: this.me, text },
      });
      const { [g.outage.id]: _done, ...rest } = this.groupDraft;
      this.groupDraft = rest;
      this.say(`One reply sent to ${r.sent} member${r.sent === 1 ? '' : 's'} about ${g.outage.area}.`);
      await this.refresh();
    });
  }

  // ---- render ------------------------------------------------------------------------

  render() {
    const l = this.list;
    return html`
      ${this.toast ? html`<div class="toast" role="status">${this.toast}</div>` : nothing}
      <div class="head">
        <div class="row">
          <h2>Member email</h2>
          ${l ? html`<span class="pill">${l.counts.new} new</span><span class="pill warn">${l.counts.picked} in progress</span><span class="pill ok">${l.counts.sent} answered</span>` : nothing}
          ${this.storm ? html`<span class="stormflag">Storm Mode on</span>` : nothing}
        </div>
        <div class="tabs">
          <button class="tab ${this.view === 'board' ? 'on' : ''}" @click=${() => (this.view = 'board')}>Board</button>
          ${this.storm
            ? html`<button class="tab ${this.view === 'groups' ? 'on' : ''}" @click=${() => (this.view = 'groups')}>
                Outage groups${l?.groups?.length ? ` (${l.groups.filter((g) => g.open).length})` : ''}
              </button>`
            : nothing}
        </div>
      </div>
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
      ${!l ? html`<div class="empty">Loading the inbox…</div>` : this.view === 'groups' ? this.renderGroups(l.groups ?? []) : this.renderBoard(l)}
    `;
  }

  private renderBoard(l: ListDto) {
    const topics = Object.entries(l.topics).filter(([k]) => l.emails.some((e) => e.topic === k));
    const shown = this.topic ? l.emails.filter((e) => e.topic === this.topic) : l.emails;
    const cols: { key: EmailCard['status']; label: string }[] = [
      { key: 'new', label: 'New' },
      { key: 'picked', label: 'Picked' },
      { key: 'sent', label: 'Sent' },
    ];
    return html`
      <div class="chips" aria-label="Topic filter">
        <button class="chip ${this.topic ? '' : 'on'}" @click=${() => (this.topic = '')}>All topics</button>
        ${topics.map(
          ([k, label]) => html`<button class="chip ${this.topic === k ? 'on' : ''}" @click=${() => (this.topic = this.topic === k ? '' : k)}>
            ${label} · ${l.emails.filter((e) => e.topic === k && e.status !== 'sent').length}
          </button>`,
        )}
      </div>
      <div class="main">
        <div class="board">
          ${cols.map((c) => {
            const items = shown.filter((e) => e.status === c.key).slice(0, c.key === 'sent' ? 15 : 100);
            return html`<section class="col" aria-label=${c.label}>
              <div class="colhead"><span>${c.label}</span><span>${shown.filter((e) => e.status === c.key).length}</span></div>
              ${items.length ? items.map((e) => this.renderCard(e)) : html`<div class="dim" style="padding:8px">None</div>`}
            </section>`;
          })}
        </div>
        <div class="pane">${this.renderDetail()}</div>
      </div>
    `;
  }

  private renderCard(e: EmailCard) {
    const ageCls = e.status === 'sent' ? '' : e.waitingMin >= 120 ? 'bad' : e.waitingMin >= 45 ? 'warn' : '';
    return html`<div
      class="ecard t-${e.topic} ${this.selected === e.id ? 'sel' : ''} ${this.isMine(e) ? 'mine' : ''}"
      role="button"
      tabindex="0"
      @click=${() => void this.open(e.id)}
      @keydown=${(ev: KeyboardEvent) => ev.key === 'Enter' && void this.open(e.id)}
    >
      <div class="who">
        <span>${e.fromName}</span>
        <span class="age ${ageCls}" title=${`Received ${fmtClock(e.receivedAt)}`}>${e.status === 'sent' ? `answered in ${age(e.waitingMin)}` : age(e.waitingMin)}</span>
      </div>
      <div class="subj">${e.subject}</div>
      <div class="meta">
        <span class="pill ${e.topic === 'outage' ? 'warn' : ''}">${e.topicLabel}</span>
        ${e.member ? html`<span class="dim">Acct ${e.member.memberSep}</span>` : html`<span class="pill bad">No account match</span>`}
        ${e.member?.lifeSupport ? html`<span class="pill bad">Medical priority</span>` : nothing}
      </div>
      ${e.status === 'picked'
        ? html`<div class="dim" style="font-size:12px">${this.isMine(e) ? 'You' : e.agent}${e.assignedBy ? ` · assigned by ${e.assignedBy}` : ''}</div>`
        : e.status === 'sent'
          ? html`<div class="dim" style="font-size:12px">${e.agent}${e.bulk ? ' · outage group reply' : ''}</div>`
          : html`<div class="row"><button class="primary" ?disabled=${!!this.busy} @click=${(ev: Event) => { ev.stopPropagation(); void this.pick(e.id); }}>Pick</button></div>`}
    </div>`;
  }

  private renderDetail() {
    const d = this.detail;
    if (!this.selected) return html`<div class="empty">Pick an email to open it here with the member's account.</div>`;
    if (!d) return html`<div class="empty">Opening…</div>`;
    const mine = this.isMine(d);
    return html`
      <div style="display:grid;gap:4px">
        <div class="row" style="justify-content:space-between">
          <span class="big">${d.subject}</span>
          <span class="pill ${d.topic === 'outage' ? 'warn' : ''}">${d.topicLabel}</span>
        </div>
        <div class="dim">From ${d.fromName} &lt;${d.from}&gt; · received ${fmtClock(d.receivedAt)} · ${d.status === 'sent' ? 'answered' : `waiting ${age(d.waitingMin)}`}</div>
      </div>
      <div class="mail">${d.body}</div>
      ${this.renderAccount(d)}
      ${d.status === 'sent' && d.reply
        ? html`<div style="display:grid;gap:4px">
            <h3>Reply sent ${fmtClock(d.reply.sentAt)} by ${d.reply.by}${d.reply.bulkOutageId ? ' (outage group reply)' : ''}</h3>
            <div class="sentbox">${d.reply.text}</div>
          </div>`
        : html`
            ${d.status === 'new'
              ? html`<div class="row"><button class="primary" ?disabled=${!!this.busy} @click=${() => void this.pick(d.id)}>Pick this email</button></div>`
              : !mine
                ? html`<div class="note">${d.agent} is working on this email${d.assignedBy ? ` (assigned by ${d.assignedBy})` : ''}.</div>`
                : this.renderReply(d)}
            ${this.canAssign ? this.renderAssign(d) : nothing}
          `}
      ${d.history.length
        ? html`<ul class="hist">${d.history.map((h) => html`<li>${fmtClock(h.at)} · ${h.by}: ${h.what}</li>`)}</ul>`
        : nothing}
    `;
  }

  private renderReply(d: EmailDetail) {
    return html`<div style="display:grid;gap:6px">
      <div class="row" style="justify-content:space-between">
        <span class="ai">AI draft from the member's account · review before sending</span>
        <button ?disabled=${!!this.busy} @click=${() => void this.makeDraft()}>${this.busy === 'draft' ? 'Drafting…' : this.draft ? 'Redraft' : 'Draft reply'}</button>
      </div>
      ${this.basis.length ? html`<ul class="basis">${this.basis.map((b) => html`<li>${b}</li>`)}</ul>` : nothing}
      <textarea
        id="reply"
        aria-label="Reply"
        .value=${this.draft}
        @input=${(e: Event) => {
          this.draft = (e.target as HTMLTextAreaElement).value;
          this.dirty = true;
        }}
      ></textarea>
      <div class="row">
        <button class="primary" ?disabled=${!this.draft.trim() || !!this.busy} @click=${() => void this.send(d.id)}>
          ${this.busy === 'send' ? 'Sending…' : `Send to ${d.from}`}
        </button>
        <button ?disabled=${!!this.busy} @click=${() => void this.release(d.id)}>Release to board</button>
      </div>
    </div>`;
  }

  private renderAssign(d: EmailDetail) {
    const options = this.agents.filter((a) => a.toLowerCase() !== (d.status === 'picked' ? d.agent.toLowerCase() : ''));
    return html`<div style="display:grid;gap:4px">
      <h3>Supervisor: assign to an agent</h3>
      <div class="row" style="flex-wrap:nowrap">
        <input
          type="text"
          list="horry-email-agents"
          placeholder="Agent name"
          .value=${this.assignTo}
          @input=${(e: Event) => (this.assignTo = (e.target as HTMLInputElement).value)}
        />
        <datalist id="horry-email-agents">${options.map((a) => html`<option value=${a}></option>`)}</datalist>
        <button ?disabled=${!this.assignTo.trim() || !!this.busy} @click=${() => void this.doAssign(d.id)}>
          ${this.busy === 'assign' ? 'Assigning…' : 'Assign'}
        </button>
      </div>
    </div>`;
  }

  private renderAccount(d: EmailDetail) {
    const a = d.account;
    const o = d.outage;
    return html`<section class="card" aria-label="Member account">
      <div class="row" style="justify-content:space-between">
        <h2>${a ? a.name : 'No matching account'}</h2>
        ${a ? html`<span class="dim">Account ${a.memberSep}${d.matchedBy === 'account_number' ? ' (from the account number in the email)' : ''}</span>` : nothing}
      </div>
      ${a
        ? html`<dl class="kv">
            <dt>Service address</dt><dd>${a.address}</dd>
            <dt>Phone</dt><dd>${a.phone ?? '—'}</dd>
            <dt>Amount due</dt><dd>${money(a.amountDue)} by ${a.dueDate}${a.bankDraft ? ' · bank draft' : ''}</dd>
            ${a.pastDue > 0 ? html`<dt>Past due</dt><dd><span class="pill bad">${money(a.pastDue)}</span>${a.cutOffDate ? ` cut-off ${a.cutOffDate}` : ''}${a.extensionAllowed ? ' · extension allowed' : ''}</dd>` : nothing}
            <dt>Last payment</dt><dd>${money(a.lastPayment)} on ${a.paymentDate}</dd>
            <dt>Budget billing</dt><dd>${a.budgetAmount ? money(a.budgetAmount) + ' a month' : 'No'}</dd>
            <dt>Usage (30 days)</dt><dd>${a.kwhLast30.toLocaleString('en-US')} kWh · ${a.usageChangePct >= 0 ? 'up' : 'down'} ${Math.abs(a.usageChangePct)}% vs last year</dd>
            ${a.lifeSupport ? html`<dt>Priority</dt><dd><span class="pill bad">Medical / life-support</span></dd>` : nothing}
          </dl>`
        : html`<div class="dim">${d.from} isn't on any account. The draft asks the sender for an account number.</div>`}
      ${o
        ? html`<div class="note"><strong>In outage ${o.id}:</strong> ${o.area} · ${o.customers.toLocaleString('en-US')} members · ${o.cause} · ${o.crew} · restoration ${o.etrText}</div>`
        : nothing}
    </section>`;
  }

  private renderGroups(groups: Group[]) {
    if (!groups.length) return html`<div class="empty">No emails are about an active outage right now.</div>`;
    return html`<div class="groups">
      <div class="dim">Storm view: emails grouped by outage. One reply goes to every member below, each greeted by name.</div>
      ${groups.map((g) => {
        const text = this.groupDraft[g.outage.id];
        return html`<section class="card" aria-label=${`Outage ${g.outage.id}`}>
          <div class="row" style="justify-content:space-between">
            <span class="big">${g.outage.area}</span>
            <span class="row"><span class="pill warn">${g.open} waiting</span>${g.sent ? html`<span class="pill ok">${g.sent} answered</span>` : nothing}</span>
          </div>
          <div class="dim">
            ${g.outage.id} · ${g.outage.customers.toLocaleString('en-US')} members out · ${g.outage.cause} · ${g.outage.crew} · restoration ${g.outage.etrText}
          </div>
          ${g.open ? html`<div>From: ${g.senders.join(', ')}</div>` : nothing}
          ${g.lifeSupport ? html`<div class="err">A member on medical priority emailed about this outage. Check their email before the group reply goes out.</div>` : nothing}
          ${g.open === 0
            ? html`<div class="dim">Everyone in this group has been answered.</div>`
            : text === undefined
              ? html`<div class="row">
                  <button class="primary" ?disabled=${!!this.busy} @click=${() => void this.loadGroupDraft(g.outage.id)}>
                    ${this.busy === `gdraft-${g.outage.id}` ? 'Drafting…' : `Draft one reply for ${g.open} member${g.open === 1 ? '' : 's'}`}
                  </button>
                </div>`
              : html`<span class="ai">AI draft · {first_name} is filled in for each member</span>
                  <textarea
                    aria-label="Group reply"
                    .value=${text}
                    @input=${(e: Event) => (this.groupDraft = { ...this.groupDraft, [g.outage.id]: (e.target as HTMLTextAreaElement).value })}
                  ></textarea>
                  <div class="row">
                    <button class="primary" ?disabled=${!text.trim() || !!this.busy} @click=${() => void this.sendGroup(g)}>
                      ${this.busy === `gsend-${g.outage.id}` ? 'Sending…' : `Send to all ${g.open}`}
                    </button>
                    <button @click=${() => {
                      const { [g.outage.id]: _x, ...rest } = this.groupDraft;
                      this.groupDraft = rest;
                    }}>Cancel</button>
                  </div>`}
        </section>`;
      })}
    </div>`;
  }
}

if (!customElements.get('horry-email')) customElements.define('horry-email', HorryEmail);
