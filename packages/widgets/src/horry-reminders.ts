// <horry-reminders> — Payment reminders (demo use case 3, Kristen 2026-11-02): upload a list
// of past-due accounts, check it, pick Voice (Savannah calls each member) or Text (secure pay
// link), send, and watch each row's outcome. Supervisor nav page; preview at reminders.html.
//
// Inputs: server, supervisor (name for the log), darkmode.
// Calls: POST api/reminders/parse (CSV → rows), POST api/reminders (send), GET api/reminders.
import { LitElement, css, html, nothing } from 'lit';
import { DEFAULT_SERVER, api, darkmodeProperty, fmtClock } from './common.js';
import { themeStyles } from './theme.js';

interface Row { account: string; name: string; phone: string; amount: number; dueDate: string }
interface BatchRow extends Row { id: string; status: string; outcome?: string; updatedAt: string }
interface Batch { id: string; createdAt: string; by: string; channel: 'voice' | 'sms'; done: boolean; rows: BatchRow[] }
interface ListDto { configured: boolean; callerNumber: string; demoNumber: string; batches: Batch[] }

const STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: 'queued', cls: '' },
  calling: { label: 'Savannah is calling', cls: 'warn' },
  sent: { label: 'text sent', cls: 'ok' },
  paid: { label: 'paid', cls: 'ok' },
  promised: { label: 'promised to pay', cls: 'ok' },
  completed: { label: 'reminded', cls: 'ok' },
  no_answer: { label: 'no answer', cls: 'warn' },
  declined: { label: 'declined', cls: 'warn' },
  failed: { label: 'failed', cls: 'bad' },
};
const money = (n: number) => `$${n.toFixed(2)}`;
const fmtPhone = (p: string) => (/^\d{10}$/.test(p) ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p);

export class HorryReminders extends LitElement {
  static properties = {
    server: { type: String },
    supervisor: { type: String },
    darkmode: darkmodeProperty,
    list: { state: true },
    draft: { state: true },
    channel: { state: true },
    csvText: { state: true },
    busy: { state: true },
    error: { state: true },
    notice: { state: true },
  };

  server = DEFAULT_SERVER;
  supervisor = '';
  darkmode = false;
  list: ListDto | null = null;
  /** Parsed, editable rows waiting to be sent (null = nothing loaded yet). */
  draft: Row[] | null = null;
  channel: 'voice' | 'sms' = 'voice';
  csvText = '';
  busy = '';
  error = '';
  notice = '';
  private timer: number | undefined;

  static styles = [
    themeStyles,
    css`
      .wrap { display: grid; gap: 12px; }
      /* KPI tiles across the top (Kristen 2026-11-03: "fancier, with KPI cards"). */
      .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
      .tile { background: var(--h-bg); border: 1px solid var(--h-border); border-radius: 8px; padding: 12px 14px; display: grid; gap: 2px; border-top: 3px solid var(--h-navy); }
      .tile .k { font-size: 12px; color: var(--h-dim); }
      .tile .v { font-size: 30px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.15; }
      .tile .n { font-size: 12px; color: var(--h-dim); }
      .tile.good { border-top-color: var(--h-ok); }
      .tile.good .v { color: var(--h-ok); }
      .tile.warn { border-top-color: var(--h-warn); }
      .split { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--h-border); margin-top: 6px; }
      .split i { display: block; height: 100%; }
      .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .between { justify-content: space-between; }
      .group { font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--h-muted, inherit); opacity: .8; margin: 6px 2px -4px; }
      textarea { width: 100%; min-height: 90px; resize: vertical; font: 12px/1.4 Consolas, monospace; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th { text-align: left; font-size: 11px; color: var(--h-dim); font-weight: 600; padding: 4px 6px; border-bottom: 1px solid var(--h-border); }
      td { padding: 5px 6px; border-top: 1px solid var(--h-border); vertical-align: middle; }
      td.r, th.r { text-align: right; font-variant-numeric: tabular-nums; }
      td input { width: 100%; max-width: 150px; font-size: 13px; padding: 3px 6px; }
      .x { background: none; border: 0; color: var(--h-dim); cursor: pointer; font-size: 14px; padding: 0 4px; }
      .choice { display: flex; gap: 8px; flex-wrap: wrap; }
      .choice label { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid var(--h-border); border-radius: 8px; cursor: pointer; }
      .choice label.on { border-color: var(--h-ok); background: var(--h-ok-soft); }
      .choice input { width: auto; }
      .apply { background: var(--h-navy); color: var(--h-bg); border-color: var(--h-navy); }
      .ok-msg { border-left: 3px solid var(--h-ok); background: var(--h-ok-soft); padding: 8px 10px; border-radius: 0 6px 6px 0; }
      .batch { border-left: 4px solid var(--h-border); }
      .batch.live { border-left-color: var(--h-warn); }
      .batch.done { border-left-color: var(--h-ok); }
      .prog { height: 6px; background: var(--h-soft); border-radius: 3px; overflow: hidden; }
      .prog > div { height: 100%; background: var(--h-ok); transition: width .3s; }
      .dim.small { font-size: 12px; }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), 3000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    try {
      this.list = await api<ListDto>(this.server, 'api/reminders');
      if (this.error.startsWith("Can't reach")) this.error = '';
    } catch (err) {
      if (!this.list) this.error = `Can't reach the service: ${(err as Error).message}`;
    }
  }

  private async parse(text: string): Promise<void> {
    this.error = '';
    this.notice = '';
    this.busy = 'parse';
    try {
      const r = await api<{ rows: Row[]; errors: string[] }>(this.server, 'api/reminders/parse', { method: 'POST', body: { text } });
      this.draft = r.rows;
      if (r.errors.length) this.error = r.errors.join(' ');
      if (!r.rows.length && !r.errors.length) this.error = 'No rows found in that list.';
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.busy = '';
    }
  }

  private async loadSample(): Promise<void> {
    const text = await (await fetch(new URL('reminders-sample.csv', this.server.replace(/\/?$/, '/')).href)).text();
    this.csvText = text;
    await this.parse(text);
  }

  private onFile(e: Event): void {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      this.csvText = String(reader.result ?? '');
      void this.parse(this.csvText);
    };
    reader.readAsText(file);
  }

  private edit(i: number, patch: Partial<Row>): void {
    if (!this.draft) return;
    this.draft = this.draft.map((r, j) => (j === i ? { ...r, ...patch } : r));
  }

  private pointAtDemo(): void {
    const n = this.list?.demoNumber ?? '';
    if (!this.draft || n.length !== 10) return;
    this.draft = this.draft.map((r) => ({ ...r, phone: n }));
    this.notice = `Every row now goes to ${fmtPhone(n)} (the demo caller number on AI Operations).`;
  }

  private async send(): Promise<void> {
    if (!this.draft?.length) return;
    this.error = '';
    this.busy = 'send';
    try {
      const rows = this.draft.map((r) => ({ ...r, phone: r.phone.replace(/\D/g, '').slice(-10), amount: Number(String(r.amount).replace(/[$,]/g, '')) }));
      const bad = rows.findIndex((r) => r.phone.length !== 10 || !(r.amount > 0));
      if (bad >= 0) throw new Error(`Row ${bad + 1}: check the phone number and amount.`);
      await api<Batch>(this.server, 'api/reminders', { method: 'POST', body: { channel: this.channel, rows, by: this.supervisor || 'Supervisor' } });
      this.notice = this.channel === 'voice' ? `Savannah is calling ${rows.length} member${rows.length === 1 ? '' : 's'} now, one at a time.` : `${rows.length} reminder text${rows.length === 1 ? '' : 's'} on the way.`;
      this.draft = null;
      this.csvText = '';
      await this.refresh();
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.busy = '';
    }
  }

  render() {
    const l = this.list;
    return html`<div class="wrap">
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
      ${this.renderKpis(l)}
      ${this.renderNew(l)}
      <div class="group">Sent lists</div>
      ${l && l.batches.length ? l.batches.map((b) => this.renderBatch(b)) : html`<div class="card dim">Nothing sent yet.</div>`}
    </div>`;
  }

  /** Totals across every list sent: reminded, reached, paid (count, %, dollars), promised, still owed. */
  private renderKpis(l: ListDto | null) {
    const rows = (l?.batches ?? []).flatMap((b) => b.rows.map((r) => ({ ...r, channel: b.channel })));
    const calls = rows.filter((r) => r.channel === 'voice');
    const texts = rows.filter((r) => r.channel === 'sms');
    const reached = calls.filter((r) => ['paid', 'promised', 'completed', 'declined'].includes(r.status)).length;
    const paid = rows.filter((r) => r.status === 'paid');
    const promised = rows.filter((r) => r.status === 'promised');
    const collected = paid.reduce((n, r) => n + (Number(r.amount) || 0), 0);
    const owed = rows.filter((r) => r.status !== 'paid').reduce((n, r) => n + (Number(r.amount) || 0), 0);
    const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—');
    const inFlight = rows.filter((r) => r.status === 'queued' || r.status === 'calling').length;
    return html`<section class="tiles" aria-label="Reminder results">
      <div class="tile"><span class="k">Members reminded</span><span class="v">${rows.length}</span><span class="n">${calls.length} call${calls.length === 1 ? '' : 's'} · ${texts.length} text${texts.length === 1 ? '' : 's'}${inFlight ? ` · ${inFlight} in progress` : ''}</span></div>
      <div class="tile"><span class="k">Calls answered</span><span class="v">${reached}</span><span class="n">${pct(reached, calls.length)} of calls placed</span></div>
      <div class="tile good"><span class="k">Payments completed</span><span class="v">${paid.length}</span><span class="n">${pct(paid.length, rows.length)} of members reminded</span>
        <div class="split"><i style="width:${rows.length ? Math.round((paid.length / rows.length) * 100) : 0}%;background:var(--h-ok)"></i></div></div>
      <div class="tile good"><span class="k">Collected</span><span class="v">${money(collected)}</span><span class="n">${money(owed)} still past due</span></div>
      <div class="tile ${promised.length ? 'warn' : ''}"><span class="k">Promised to pay</span><span class="v">${promised.length}</span><span class="n">${money(promised.reduce((n, r) => n + (Number(r.amount) || 0), 0))} promised</span></div>
    </section>`;
  }

  private renderNew(l: ListDto | null) {
    const d = this.draft;
    const total = d?.reduce((n, r) => n + (Number(r.amount) || 0), 0) ?? 0;
    return html`<section class="card" aria-label="New reminder list">
      <div class="row between">
        <h2>Payment reminders</h2>
        ${l ? html`<span class="pill ${l.configured ? 'ok' : ''}">${l.configured ? `calls from ${fmtPhone(l.callerNumber)}` : 'calls simulated — no outbound number attached'}</span>` : nothing}
      </div>
      ${!d
        ? html`<div class="row">
            <label class="apply" style="display:inline-block;padding:6px 12px;border-radius:6px;cursor:pointer">
              Choose CSV file <input type="file" accept=".csv,text/csv" style="display:none" @change=${(e: Event) => this.onFile(e)} />
            </label>
            <button ?disabled=${!!this.busy} @click=${() => void this.loadSample()}>Load the sample list</button>
            <span class="dim small">or paste the rows below</span>
          </div>
          <textarea placeholder="Account,Name,Phone,Amount,Due date
00230115001,Jamie Skipper,843-555-0118,194.00,10/28/26" .value=${this.csvText} @input=${(e: Event) => (this.csvText = (e.target as HTMLTextAreaElement).value)}></textarea>
          <div class="row"><button ?disabled=${!!this.busy || !this.csvText.trim()} @click=${() => void this.parse(this.csvText)}>${this.busy === 'parse' ? 'Reading…' : 'Check the list'}</button></div>`
        : html`<table>
            <thead><tr><th>#</th><th>Member</th><th>Account</th><th>Phone</th><th class="r">Amount</th><th>Due</th><th></th></tr></thead>
            <tbody>
              ${d.map((r, i) => html`<tr>
                <td class="r">${i + 1}</td>
                <td>${r.name || html`<span class="dim">—</span>`}</td>
                <td>${r.account || html`<span class="dim">—</span>`}</td>
                <td><input type="text" inputmode="tel" .value=${fmtPhone(r.phone)} @input=${(e: Event) => this.edit(i, { phone: (e.target as HTMLInputElement).value })} /></td>
                <td class="r"><input type="text" inputmode="decimal" style="max-width:90px;text-align:right" .value=${Number(r.amount).toFixed(2)} @input=${(e: Event) => this.edit(i, { amount: Number((e.target as HTMLInputElement).value) })} /></td>
                <td>${r.dueDate || html`<span class="dim">—</span>`}</td>
                <td><button class="x" title="Remove" @click=${() => (this.draft = d.filter((_, j) => j !== i))}>✕</button></td>
              </tr>`)}
            </tbody>
          </table>
          <div class="row between">
            <span class="dim small">${d.length} account${d.length === 1 ? '' : 's'} · ${money(total)} past due</span>
            <span class="row">
              ${l?.demoNumber ? html`<button ?disabled=${!!this.busy} @click=${() => this.pointAtDemo()}>Send every row to the demo number</button>` : nothing}
              <button ?disabled=${!!this.busy} @click=${() => { this.draft = null; this.notice = ''; }}>Start over</button>
            </span>
          </div>
          <div class="choice" role="radiogroup" aria-label="How to remind them">
            <label class=${this.channel === 'voice' ? 'on' : ''}>
              <input type="radio" name="ch" .checked=${this.channel === 'voice'} @change=${() => (this.channel = 'voice')} />
              <span><strong>Voice</strong><br /><span class="dim small">Savannah calls, reminds them of the amount and offers to take the payment.</span></span>
            </label>
            <label class=${this.channel === 'sms' ? 'on' : ''}>
              <input type="radio" name="ch" .checked=${this.channel === 'sms'} @change=${() => (this.channel = 'sms')} />
              <span><strong>Text</strong><br /><span class="dim small">A reminder with a secure pay link.</span></span>
            </label>
          </div>
          <div class="row">
            <button class="apply" ?disabled=${!!this.busy || !d.length} @click=${() => void this.send()}>
              ${this.busy === 'send' ? 'Sending…' : this.channel === 'voice' ? `Have Savannah call ${d.length} member${d.length === 1 ? '' : 's'}` : `Text ${d.length} reminder${d.length === 1 ? '' : 's'}`}
            </button>
          </div>`}
      ${this.notice ? html`<div class="ok-msg" role="status">${this.notice}</div>` : nothing}
    </section>`;
  }

  private renderBatch(b: Batch) {
    const finished = b.rows.filter((r) => !['queued', 'calling'].includes(r.status)).length;
    const paid = b.rows.filter((r) => r.status === 'paid').length;
    return html`<section class="card batch ${b.done ? 'done' : 'live'}" aria-label="Reminder list">
      <div class="row between">
        <div><strong>${b.channel === 'voice' ? 'Savannah called' : 'Texted'} ${b.rows.length} member${b.rows.length === 1 ? '' : 's'}</strong>
          <span class="dim small"> · ${fmtClock(b.createdAt)} by ${b.by}</span></div>
        <span class="pill ${b.done ? 'ok' : 'warn'}">${b.done ? `done · ${paid} paid` : `${finished} of ${b.rows.length} done`}</span>
      </div>
      <div class="prog"><div style="width:${b.rows.length ? Math.round((finished / b.rows.length) * 100) : 0}%"></div></div>
      <table>
        <thead><tr><th>Member</th><th>Phone</th><th class="r">Amount</th><th>Status</th><th>Outcome</th></tr></thead>
        <tbody>
          ${b.rows.map((r) => {
            const s = STATUS[r.status] ?? { label: r.status, cls: '' };
            return html`<tr>
              <td>${r.name || r.account || '—'}</td>
              <td>${fmtPhone(r.phone)}</td>
              <td class="r">${money(r.amount)}</td>
              <td><span class="pill ${s.cls}">${s.label}</span></td>
              <td class="dim small">${r.outcome ?? ''}</td>
            </tr>`;
          })}
        </tbody>
      </table>
    </section>`;
  }
}

if (!customElements.get('horry-reminders')) customElements.define('horry-reminders', HorryReminders);
