// <horry-member> — the live agent's screen pop from the co-op's billing system (NextGen CIS)
// for the selected call (discovery item 9: "Mitel couldn't do it").
//
// Inputs (WxCC Desktop layout, all optional): server, ani, interactionid, accountnumber,
// agentname, and interactionData (= $STORE.agentContact.taskSelected, used for the CAD
// variable `accountNumber` and as a fallback for ani / interaction id). darkmode is the
// usual string attribute.
//
// One poll (GET api/agent-desk) every 5 s while a call is selected: member, billing, usage,
// outage, what Savannah did on this call, recent payments, talking points. Billing
// assistant buttons POST api/agent-desk/{payment-link|card-on-file|extension|note}.
import { LitElement, css, html, nothing, svg } from 'lit';
import { DEFAULT_SERVER, api, darkmodeProperty, fmtClock, joinUrl } from './common.js';
import { themeStyles } from './theme.js';

interface Journey {
  at: string;
  step: string;
  detail: string;
  label: string;
}

interface Payment {
  id: string;
  amount: number;
  method: 'link' | 'keypad' | 'card_on_file';
  status: 'pending' | 'approved' | 'declined' | 'expired';
  createdAt: string;
  completedAt: string | null;
  last4: string | null;
  cardType: string | null;
  confirmation: string | null;
  phone: string;
  initiatedBy: 'ai' | 'agent';
}

interface DeskDto {
  found: true;
  member: {
    memberSep: string;
    name: string;
    firstName: string;
    address: string;
    cellPhone: string | null;
    homePhone: string | null;
    email?: string | null;
    rate: string;
    meter: string;
    lifeSupport: boolean;
    status: string;
  };
  billing: {
    currentBalance: number;
    amountDue: number;
    pastDue: number;
    dueDate: string;
    cutOffDate: string | null;
    onCutOffList: boolean;
    lastPayment: number;
    lastPaymentDate: string;
    billDate: string;
    cardOnFile: { last4: string; brand: string } | null;
    bankDraft: boolean;
    budgetAmount: number | null;
    paperless: boolean;
  } | null;
  usage: { last30Kwh: number; priorMonthKwh: number; sameMonthLastYearKwh: number; vsPriorMonthPct: number; vsLastYearPct: number; months?: { month: string; kwh: number }[] };
  outage: {
    id: string; area: string; customers: number; cause: string; crew: string; etrText: string;
    subscription?: { phone: string; channel: string; status: string } | null;
    textTo?: string;
  } | null;
  call: {
    guid: string;
    channel: string;
    startedAt: string;
    endedAt: string | null;
    journey: Journey[];
    summary: string | null;
    escalation: { department: string; urgency: string; reason: string; summary: string } | null;
    outcome: string | null;
    sentiment: string | null;
  } | null;
  payments: Payment[];
  notes: { at: string; type: string; text: string }[];
  talkingPoints: { tone: 'bad' | 'warn' | 'ok' | 'info'; text: string }[];
  actions: {
    paymentLink: { enabled: boolean; amount: number; phone: string };
    cardOnFile: { enabled: boolean; label: string };
    extension: { allowed: boolean; payBy: string; reason: string };
  };
  billingScreen: string;
}

type TaskLike = {
  interactionId?: string;
  ani?: string;
  callAssociatedDetails?: Record<string, unknown>;
  callAssociatedData?: Record<string, { value?: unknown } | string | undefined>;
  interaction?: TaskLike;
};

const money = (n: number | null | undefined) =>
  `$${(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPhone = (p: string | null | undefined) => {
  const d = String(p ?? '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p ?? '');
};
const signed = (n: number) => `${n > 0 ? '+' : ''}${n}%`;
const PAY_LABEL = { pending: 'waiting', approved: 'paid', declined: 'declined', expired: 'expired' } as const;
const PAY_CLASS = { pending: 'warn', approved: 'ok', declined: 'bad', expired: '' } as const;
const METHOD = { link: 'Text link', keypad: 'Keypad', card_on_file: 'Card on file' } as const;

/** Read a CAD variable from the Desktop's task object (value may be wrapped). */
function cadValue(task: TaskLike | null | undefined, name: string): string {
  const t = task?.interaction ?? task;
  const v = t?.callAssociatedData?.[name];
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : String(v.value ?? '');
}

export class HorryMember extends LitElement {
  static properties = {
    server: { type: String },
    ani: { type: String },
    interactionid: { type: String },
    accountnumber: { type: String },
    agentname: { type: String },
    interactionData: { attribute: false },
    darkmode: darkmodeProperty,
    data: { state: true },
    loadError: { state: true },
    notFound: { state: true },
    busy: { state: true },
    result: { state: true },
    amount: { state: true },
    phone: { state: true },
    subPhone: { state: true },
    payBy: { state: true },
    noteText: { state: true },
    showTranscript: { state: true },
  };

  server = DEFAULT_SERVER;
  ani = '';
  interactionid = '';
  accountnumber = '';
  agentname = '';
  interactionData: TaskLike | null = null;
  darkmode = false;
  data: DeskDto | null = null;
  loadError = '';
  notFound = false;
  busy = '';
  result: { ok: boolean; text: string } | null = null;
  /** Agent edits; null = use the suggested value from the service. */
  amount: string | null = null;
  phone: string | null = null;
  /** Unsaved cell for restoration texts (null = the default the service suggests). */
  subPhone: string | null = null;
  payBy: string | null = null;
  noteText = '';
  showTranscript = false;
  private timer: number | undefined;
  private key = '';

  static styles = [
    themeStyles,
    css`
      .wrap { display: grid; gap: 10px; }
      .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
      .between { justify-content: space-between; }
      .name { font-size: 16px; font-weight: 600; color: var(--h-navy); }
      .kv { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px 12px; margin: 0; }
      .kv div { min-width: 0; }
      .kv dt { font-size: 11px; color: var(--h-dim); text-transform: uppercase; letter-spacing: 0.04em; }
      .kv dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
      .kv dd.bad { color: var(--h-danger); }
      .big { font-size: 18px; }
      .tp { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
      .tp li { padding: 5px 8px; border-left: 3px solid var(--h-border); background: var(--h-soft); border-radius: 0 6px 6px 0; }
      .tp li.bad { border-color: var(--h-danger); background: var(--h-danger-soft); }
      .tp li.warn { border-color: var(--h-warn); background: var(--h-warn-soft); }
      .tp li.ok { border-color: var(--h-ok); background: var(--h-ok-soft); }
      .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
      .steps li { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 8px; }
      .steps .t { font-size: 11px; color: var(--h-dim); padding-top: 2px; }
      .steps .d { font-size: 12px; color: var(--h-dim); overflow-wrap: anywhere; }
      .bar { display: grid; grid-template-columns: 110px minmax(0, 1fr) 70px; gap: 6px; align-items: center; font-size: 12px; }
      .bar .track { height: 8px; background: var(--h-soft); border-radius: 4px; overflow: hidden; }
      .bar .fill { height: 100%; background: var(--h-navy); border-radius: 4px; }
      .bar .fill.now { background: var(--h-accent); }
      .bar .n { text-align: right; font-variant-numeric: tabular-nums; }
      .cis { border: 1px solid var(--h-border); border-radius: 8px; overflow: hidden; background: var(--h-bg); }
      .cisbar { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 7px 10px;
        background: var(--h-navy); color: var(--h-bg); font-size: 13px; }
      .cisbar button { font-size: 12px; padding: 3px 10px; background: var(--h-bg); color: var(--h-text); }
      .cisgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 1px; background: var(--h-border); }
      .cisgrid .cell { background: var(--h-bg); padding: 7px 10px; display: grid; gap: 2px; align-content: start; }
      .cisgrid .cell span { font-size: 11px; color: var(--h-dim); }
      .cisgrid .cell b { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
      .cisgrid .cell b.big { font-size: 17px; }
      .cisgrid .cell b.good { color: var(--h-ok); }
      .cisgrid .cell b.badc { color: var(--h-danger); }
      .cisgrid .cell b.warnc { color: var(--h-warn); }
      .cisbadges { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--h-border); background: var(--h-soft); }
      .badge { font-size: 11.5px; padding: 2px 8px; border: 1px solid var(--h-border); border-radius: 3px; background: var(--h-bg); }
      .badge.amber { border-color: var(--h-warn); background: var(--h-warn-soft); color: var(--h-warn); }
      .badge.green { border-color: var(--h-ok); background: var(--h-ok-soft); color: var(--h-ok); }
      .badge.red { border-color: var(--h-danger); background: var(--h-danger-soft); color: var(--h-danger); }
      /* Cap the size: the panel can be 1,500 px wide on a big screen (Kristen 2026-10-29). */
      .uchart { width: 100%; max-width: 480px; height: auto; display: block; margin: 4px 0 2px; }
      .restore { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--h-border); display: grid; gap: 6px; }
      .uchart .ulab { font-size: 11px; fill: var(--h-text); font-variant-numeric: tabular-nums; }
      .uchart .umon { font-size: 10.5px; fill: var(--h-dim); }
      .uchart .umon.now { fill: var(--h-text); font-weight: 600; }
      input[type='text'], textarea {
        font: inherit; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--h-border);
        background: var(--h-bg); color: var(--h-text); min-width: 0;
      }
      textarea { width: 100%; resize: vertical; min-height: 44px; }
      .field { display: grid; gap: 2px; flex: 1 1 120px; }
      .field label { font-size: 11px; color: var(--h-dim); }
      .ok-msg { border-left: 3px solid var(--h-ok); background: var(--h-ok-soft); padding: 8px 10px; border-radius: 0 6px 6px 0; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      td { padding: 4px 4px; border-top: 1px solid var(--h-border); vertical-align: top; }
      td.r { text-align: right; font-variant-numeric: tabular-nums; }
      .empty { text-align: center; padding: 24px 8px; color: var(--h-dim); }
      details summary { cursor: pointer; color: var(--h-dim); font-size: 12px; }
    `,
  ];

  // ---- inputs ------------------------------------------------------------------------

  private get guid(): string {
    const t = this.interactionData?.interaction ?? this.interactionData;
    return String(this.interactionid || this.interactionData?.interactionId || t?.interactionId || '').trim();
  }

  private get callerAni(): string {
    const t = this.interactionData?.interaction ?? this.interactionData;
    return String(this.ani || t?.callAssociatedDetails?.ani || t?.ani || '').trim();
  }

  private get account(): string {
    return String(this.accountnumber || cadValue(this.interactionData, 'accountNumber') || '').trim();
  }

  private query(): string {
    const p = new URLSearchParams();
    if (this.guid) p.set('guid', this.guid);
    if (this.callerAni) p.set('ani', this.callerAni);
    if (this.account) p.set('sep', this.account);
    return p.toString();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.timer);
    this.timer = undefined;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.key = '';
    this.requestUpdate();
  }

  protected updated(): void {
    const key = this.query();
    if (key === this.key) return;
    this.key = key;
    window.clearInterval(this.timer);
    this.timer = undefined;
    this.data = null;
    this.notFound = false;
    this.loadError = '';
    this.result = null;
    this.amount = this.phone = this.payBy = null;
    this.noteText = '';
    if (!key) return; // no call selected: empty state, no polling
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), 5000);
  }

  private async refresh(): Promise<void> {
    const key = this.key;
    if (!key) return;
    try {
      const d = await api<DeskDto>(this.server, `api/agent-desk?${key}`);
      if (key !== this.key) return;
      this.data = d;
      this.notFound = false;
      this.loadError = '';
    } catch (err) {
      if (key !== this.key) return;
      const msg = (err as Error).message;
      if (/no member/i.test(msg)) this.notFound = true;
      else this.loadError = `Can't reach the billing system: ${msg}`;
    }
  }

  // ---- actions -----------------------------------------------------------------------

  private async act(label: string, path: string, body: Record<string, unknown>): Promise<void> {
    const d = this.data;
    if (!d) return;
    this.busy = label;
    this.result = null;
    try {
      const r = await api<{ ok: boolean; message: string }>(this.server, `api/agent-desk/${path}`, {
        method: 'POST',
        body: { guid: this.guid || undefined, sep: d.member.memberSep, agent: this.agentname || undefined, ...body },
      });
      this.result = { ok: r.ok !== false, text: r.message };
      await this.refresh();
    } catch (err) {
      this.result = { ok: false, text: (err as Error).message };
    } finally {
      this.busy = '';
    }
  }

  private amountValue(): number {
    return Number(String(this.amount ?? this.data?.actions.paymentLink.amount ?? '').replace(/[$,\s]/g, ''));
  }

  private openBilling(): void {
    if (!this.data) return;
    window.open(joinUrl(this.server, this.data.billingScreen), '_blank', 'noopener');
  }

  // ---- render ------------------------------------------------------------------------

  render() {
    if (!this.key) {
      return html`<div class="empty">
        <h2>Member account</h2>
        <p>Select a call to see the member's account, billing and what Savannah already did.</p>
      </div>`;
    }
    const d = this.data;
    if (!d) {
      if (this.notFound)
        return html`<div class="wrap"><div class="note">No member account matches ${fmtPhone(this.callerAni) || 'this caller'}. Ask for the service address or account number.</div></div>`;
      return html`<div class="wrap">${this.loadError ? html`<div class="err">${this.loadError}</div>` : html`<div class="dim">Loading member account…</div>`}</div>`;
    }
    return html`<div class="wrap">
      ${this.loadError ? html`<div class="err">${this.loadError}</div>` : nothing}
      ${this.renderHeader(d)} ${this.renderSavannah(d)} ${this.renderPoints(d)} ${this.renderBilling(d)} ${this.renderAssistant(d)}
      ${this.renderOutage(d)} ${this.renderUsage(d)} ${this.renderPayments(d)}
    </div>`;
  }

  /** Screen pop styled like the billing system's account header (Kristen 2026-10-29). */
  private renderHeader(d: DeskDto) {
    const m = d.member;
    const b = d.billing;
    const cell = (label: string, value: unknown, cls = '') => html`<div class="cell"><span>${label}</span><b class=${cls}>${value}</b></div>`;
    return html`<section class="cis" aria-label="Member account">
      <div class="cisbar">
        <span><strong>Member account</strong> · billing system</span>
        <button @click=${() => this.openBilling()} title="Open the member's account in the billing system">Open billing screen ↗</button>
      </div>
      <div class="cisgrid">
        ${cell('Account / Sep', m.memberSep, 'big')}
        ${cell('Member name', m.name, 'big')}
        ${cell('Status', m.status, m.status === 'Active' ? 'good' : 'warnc')}
        ${cell('Service address', m.address)}
        ${cell('Primary phone', fmtPhone(m.cellPhone || m.homePhone))}
        ${cell('Email', m.email || '—')}
        ${b
          ? html`${cell('Current balance', money(b.currentBalance), 'big')}
              ${cell('Amount due', `${money(b.amountDue)} by ${b.dueDate}`)}
              ${cell('Past due', money(b.pastDue), b.pastDue > 0 ? 'badc' : '')}
              ${cell('Cut-off date', b.cutOffDate ?? 'None', b.cutOffDate ? 'badc' : '')}
              ${cell('Last payment', b.lastPayment ? `${money(b.lastPayment)} on ${b.lastPaymentDate}` : '—')}
              ${cell('Bill date', b.billDate || '—')}`
          : cell('Billing', 'Billing system unavailable')}
      </div>
      <div class="cisbadges">
        ${d.outage ? html`<span class="badge amber">Active outage ${d.outage.id}</span>` : nothing}
        ${m.lifeSupport ? html`<span class="badge red">Life support</span>` : nothing}
        ${b?.onCutOffList ? html`<span class="badge red">Disconnect pending</span>` : nothing}
        ${b?.cardOnFile ? html`<span class="badge green">Card on file ${b.cardOnFile.brand} ••${b.cardOnFile.last4}</span>` : nothing}
        ${b?.bankDraft ? html`<span class="badge green">Bank draft</span>` : nothing}
        ${b?.budgetAmount ? html`<span class="badge green">Budget billing</span>` : nothing}
        ${b?.paperless ? html`<span class="badge">Paperless</span>` : nothing}
        <span class="badge">${m.rate} · meter ${m.meter}</span>
      </div>
    </section>`;
  }

  private renderSavannah(d: DeskDto) {
    const c = d.call;
    if (!c) return nothing;
    const steps = c.journey;
    const esc = c.escalation;
    return html`<section class="card" aria-label="What Savannah did">
      <div class="row between">
        <h3>What Savannah did on this call</h3>
        ${esc ? html`<span class="pill ${esc.urgency === 'emergency' ? 'bad' : 'warn'}">Transferred · ${esc.department.replace(/_/g, ' ')}</span>` : nothing}
      </div>
      ${esc
        ? html`<div class="note"><strong>Why transferred:</strong> ${esc.reason.replace(/_/g, ' ')}${esc.summary ? html`<br />${esc.summary}` : nothing}</div>`
        : nothing}
      ${steps.length
        ? html`<ul class="steps">
            ${steps.map(
              (s) => html`<li>
                <span class="t">${fmtClock(s.at)}</span>
                <span><strong>${s.label}</strong><br /><span class="d">${s.detail}</span></span>
              </li>`,
            )}
          </ul>`
        : html`<div class="dim">Nothing yet.</div>`}
      ${c.summary ? html`<div><h3>Summary</h3><div>${c.summary}</div></div>` : nothing}
    </section>`;
  }

  private renderPoints(d: DeskDto) {
    if (!d.talkingPoints.length) return nothing;
    return html`<section class="card" aria-label="Talking points">
      <h3>Talking points</h3>
      <ul class="tp">
        ${d.talkingPoints.map((t) => html`<li class=${t.tone}>${t.text}</li>`)}
      </ul>
    </section>`;
  }

  private renderBilling(d: DeskDto) {
    const b = d.billing;
    if (!b) return html`<section class="card"><h3>Billing</h3><div class="err">Billing details are unavailable right now.</div></section>`;
    const ext = d.actions.extension;
    return html`<section class="card" aria-label="Billing">
      <h3>Billing</h3>
      <dl class="kv">
        <div><dt>Amount due</dt><dd class="big">${money(b.amountDue)}</dd></div>
        <div><dt>Due date</dt><dd>${b.dueDate}</dd></div>
        <div><dt>Past due</dt><dd class=${b.pastDue > 0 ? 'bad' : ''}>${money(b.pastDue)}</dd></div>
        <div><dt>Cut-off date</dt><dd class=${b.cutOffDate ? 'bad' : ''}>${b.cutOffDate ?? 'None'}</dd></div>
        <div><dt>Balance</dt><dd>${money(b.currentBalance)}</dd></div>
        <div><dt>Last payment</dt><dd>${money(b.lastPayment)} on ${b.lastPaymentDate}</dd></div>
        <div><dt>Pay method</dt><dd>${b.bankDraft ? 'Bank draft' : b.cardOnFile ? `${b.cardOnFile.brand} ••${b.cardOnFile.last4} on file` : 'None on file'}</dd></div>
        <div><dt>Budget plan</dt><dd>${b.budgetAmount ? `${money(b.budgetAmount)}/mo` : 'No'}</dd></div>
        <div><dt>Extension</dt><dd>${ext.allowed ? `Allowed to ${ext.payBy}` : ext.reason}</dd></div>
      </dl>
    </section>`;
  }

  private renderAssistant(d: DeskDto) {
    const a = d.actions;
    const busy = !!this.busy;
    const amt = this.amountValue();
    const amtOk = amt > 0;
    return html`<section class="card" aria-label="Billing assistant">
      <h3>Billing assistant</h3>
      ${this.result ? html`<div class=${this.result.ok ? 'ok-msg' : 'err'} role="status">${this.result.text}</div>` : nothing}
      <div class="row">
        <div class="field">
          <label for="amt">Amount</label>
          <input id="amt" type="text" inputmode="decimal" .value=${this.amount ?? a.paymentLink.amount.toFixed(2)} @input=${(e: Event) => (this.amount = (e.target as HTMLInputElement).value)} />
        </div>
        <div class="field">
          <label for="ph">Text to</label>
          <input id="ph" type="text" inputmode="tel" .value=${this.phone ?? fmtPhone(a.paymentLink.phone)} @input=${(e: Event) => (this.phone = (e.target as HTMLInputElement).value)} />
        </div>
      </div>
      <div class="row">
        <button class="primary" ?disabled=${busy || !a.paymentLink.enabled || !amtOk}
          @click=${() => void this.act('link', 'payment-link', { amount: amt, phone: (this.phone ?? a.paymentLink.phone).replace(/\D/g, '') })}>
          ${this.busy === 'link' ? 'Sending…' : 'Text secure pay link'}
        </button>
        ${a.cardOnFile.enabled
          ? html`<button ?disabled=${busy || !amtOk} @click=${() => void this.act('card', 'card-on-file', { amount: amt })}>
              ${this.busy === 'card' ? 'Charging…' : `Pay with ${a.cardOnFile.label}`}
            </button>`
          : nothing}
      </div>
      <div class="dim" style="font-size:12px">The member enters card details on their own phone. Card numbers never reach this desktop.</div>
      ${a.extension.allowed
        ? html`<div class="row">
            <div class="field" style="flex:0 1 120px">
              <label for="payby">Pay by (MM/DD/YY)</label>
              <input id="payby" type="text" .value=${this.payBy ?? a.extension.payBy} @input=${(e: Event) => (this.payBy = (e.target as HTMLInputElement).value)} />
            </div>
            <button style="align-self:end" ?disabled=${busy} @click=${() => void this.act('ext', 'extension', { payBy: this.payBy ?? a.extension.payBy })}>
              ${this.busy === 'ext' ? 'Requesting…' : 'Grant payment extension'}
            </button>
          </div>
          <div class="dim" style="font-size:12px">${a.extension.reason}</div>`
        : html`<div class="dim" style="font-size:12px">Payment extension: ${a.extension.reason}</div>`}
      <div class="field">
        <label for="note">Account note</label>
        <textarea id="note" placeholder="e.g. Member asked about budget billing; mailed brochure." .value=${this.noteText} @input=${(e: Event) => (this.noteText = (e.target as HTMLTextAreaElement).value)}></textarea>
      </div>
      <div class="row">
        <button ?disabled=${busy || !this.noteText.trim()} @click=${() => void this.act('note', 'note', { text: this.noteText }).then(() => { if (this.result?.ok) this.noteText = ''; })}>
          ${this.busy === 'note' ? 'Saving…' : 'Add note'}
        </button>
      </div>
    </section>`;
  }

  /** Restoration texts: sign the member up (or change the number) right from the call. */
  private renderRestoration(o: NonNullable<DeskDto['outage']>) {
    const sub = o.subscription;
    const value = this.subPhone ?? fmtPhone(sub?.phone ?? o.textTo ?? '');
    return html`<div class="restore">
      <div class="row between">
        <strong>Text when power is back</strong>
        ${sub ? html`<span class="pill ok">Signed up · ${fmtPhone(sub.phone)}</span>` : html`<span class="pill">Not signed up</span>`}
      </div>
      <div class="row">
        <input
          type="text"
          inputmode="tel"
          aria-label="Cell number for restoration texts"
          style="max-width:200px"
          placeholder="10-digit cell"
          .value=${value}
          @input=${(e: Event) => (this.subPhone = (e.target as HTMLInputElement).value)}
        />
        <button class=${sub ? '' : 'primary'} ?disabled=${!!this.busy}
          @click=${() => void this.act('restore', 'restoration', { phone: value.replace(/\D/g, '') }).then(() => (this.subPhone = null))}>
          ${this.busy === 'restore' ? 'Signing up…' : sub ? 'Update number' : 'Sign up for restoration texts'}
        </button>
      </div>
      <div class="dim" style="font-size:12px">They get a confirmation now, a text if the estimate changes, and one when power is back.</div>
    </div>`;
  }

  private renderOutage(d: DeskDto) {
    const o = d.outage;
    return html`<section class="card" aria-label="Outage">
      <div class="row between">
        <h3>Outage at this address</h3>
        ${o ? html`<span class="pill warn">${o.id}</span>` : html`<span class="pill ok">Power on</span>`}
      </div>
      ${o
        ? html`<dl class="kv">
            <div><dt>Area</dt><dd>${o.area}</dd></div>
            <div><dt>Members out</dt><dd>${o.customers.toLocaleString()}</dd></div>
            <div><dt>Cause</dt><dd>${o.cause}</dd></div>
            <div><dt>Crew</dt><dd>${o.crew}</dd></div>
            <div><dt>Estimate</dt><dd>${o.etrText}</dd></div>
          </dl>
          ${this.renderRestoration(o)}`
        : html`<div class="dim">No known outage at this service location.</div>`}
    </section>`;
  }

  private renderUsage(d: DeskDto) {
    const u = d.usage;
    const months = u.months ?? [];
    return html`<section class="card" aria-label="Usage">
      <div class="row between">
        <h3>Usage, last 13 months (kWh)</h3>
        <span class="pill ${u.vsLastYearPct >= 15 ? 'warn' : ''}">${signed(u.vsLastYearPct)} vs last year</span>
      </div>
      ${months.length ? this.usageChart(months) : nothing}
      <div class="dim" style="font-size:12px">
        First bar = same month last year (${u.sameMonthLastYearKwh.toLocaleString()} kWh); orange = this month
        (${u.last30Kwh.toLocaleString()} kWh, ${signed(u.vsPriorMonthPct)} vs prior month).
      </div>
    </section>`;
  }

  /** Vertical bars, oldest → newest. Navy history, accent = this month; the first bar (same
   *  month last year) and the last carry value labels; every bar has a hover title. */
  private usageChart(months: { month: string; kwh: number }[]) {
    const W = 360, H = 124, top = 16, base = 106, gap = 3; // sized for the ~400px interaction panel
    const n = months.length;
    const max = Math.max(...months.map((m) => m.kwh), 1);
    const bw = (W - gap * (n - 1)) / n;
    const bars = months.map((m, i) => {
      const h = Math.max(2, Math.round(((base - top) * m.kwh) / max));
      const x = i * (bw + gap), y = base - h, r = Math.min(3, bw / 2);
      const now = i === n - 1, ly = i === 0;
      // Rounded data end (top), square at the baseline.
      const d = `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${base} Z`;
      return svg`<g>
        <title>${m.month}: ${m.kwh.toLocaleString()} kWh</title>
        <path d=${d} fill=${now ? 'var(--h-accent)' : 'var(--h-navy)'} opacity=${now || ly ? 1 : 0.55}></path>
        ${now || ly ? svg`<text x=${x + bw / 2} y=${y - 4} text-anchor="middle" class="ulab">${m.kwh.toLocaleString()}</text>` : nothing}
        <text x=${x + bw / 2} y=${base + 14} text-anchor="middle" class="umon ${now ? 'now' : ''}">${m.month.split(' ')[0]}</text>
      </g>`;
    });
    return html`<svg class="uchart" viewBox="0 0 ${W} ${H}" role="img"
      aria-label=${`Monthly usage: ${months.map((m) => `${m.month} ${m.kwh} kWh`).join(', ')}`}>
      <line x1="0" x2=${W} y1=${base + 0.5} y2=${base + 0.5} stroke="var(--h-border)"></line>
      ${bars}
    </svg>`;
  }

  private renderPayments(d: DeskDto) {
    return html`<section class="card" aria-label="Recent payments and notes">
      <h3>Recent payments</h3>
      ${d.payments.length
        ? html`<table>
            ${d.payments.map(
              (p) => html`<tr>
                <td>${fmtClock(p.createdAt)}</td>
                <td>${METHOD[p.method]} · ${p.initiatedBy === 'ai' ? 'Savannah' : 'Agent'}${p.confirmation ? html`<br /><span class="dim">conf ${p.confirmation}</span>` : nothing}</td>
                <td class="r">${money(p.amount)}</td>
                <td class="r"><span class="pill ${PAY_CLASS[p.status]}">${PAY_LABEL[p.status]}</span></td>
              </tr>`,
            )}
          </table>`
        : html`<div class="dim">Last payment ${money(d.billing?.lastPayment)} on ${d.billing?.lastPaymentDate ?? '—'}.</div>`}
      ${d.notes.length
        ? html`<details>
            <summary>Account notes (${d.notes.length})</summary>
            <ul class="steps" style="margin-top:6px">
              ${d.notes.map((n) => html`<li><span class="t">${fmtClock(n.at)}</span><span class="d">${n.text}</span></li>`)}
            </ul>
          </details>`
        : nothing}
    </section>`;
  }
}

if (!customElements.get('horry-member')) customElements.define('horry-member', HorryMember);
