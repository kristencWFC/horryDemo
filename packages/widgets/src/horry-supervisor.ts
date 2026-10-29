// <horry-supervisor> — the supervisor's AI Operations page on the WxCC Desktop:
//   0. AI agent for all calls (Kristen 2026-10-29): Savannah answers every call with the
//      everyday greeting — busy days, short-staffed days, bill due dates. Same WxCC variable
//      as Storm Mode (the service writes true when either switch is on).
//   1. Storm Mode on/off (POST api/mode → WxCC global variable Global_StormMode) plus the
//      broadcast line Savannah reads to every caller.
//   2. Outage queue staffing (Kristen 2026-10-28, discovery item 3): tick the teams that
//      should take outage calls → POST api/staffing adds/removes those teams on the outage
//      queue's distribution group. Agents stay logged in to their own team.
//   3. Demo caller (Kristen 2026-10-28): which demo member the presenter's phone plays —
//      same api/settings the Storm Console uses, so the presenter never leaves the Desktop.
// Polls every 8 s (the service has no push channel); a pending selection is never
// overwritten by a poll.
import { LitElement, css, html, nothing } from 'lit';
import { DEFAULT_SERVER, api, darkmodeProperty, fmtClock } from './common.js';
import { themeStyles } from './theme.js';

interface ModeDto {
  storm: 'true' | 'false';
  aiAll: 'true' | 'false';
  aiRouting: 'true' | 'false';
  broadcast: string;
  updatedAt: string;
  updatedBy: string;
  wxcc: 'synced' | 'failed' | 'not_configured';
  wxccError: string;
}

interface TeamRow {
  id: string;
  name: string;
  onQueue: boolean;
  home: boolean;
}

interface StaffingDto {
  queue: { id: string; name: string };
  teams: TeamRow[];
  wxcc: 'synced' | 'failed' | 'not_configured';
  error?: string;
  updatedAt: string;
  updatedBy: string;
  history: { at: string; by: string; added: string[]; removed: string[] }[];
}

interface SettingsDto {
  demoAni: string;
  demoMemberSep: string;
  demoSmsTo?: string;
}

interface MemberOption {
  memberSep: string;
  name: string;
  address: string;
  inOutage: boolean;
  pastDue: number;
}

const fmtPhone = (p: string) => (/^\d{10}$/.test(p) ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p);

const WXCC_LABEL ={ synced: 'WxCC synced', failed: 'WxCC update failed', not_configured: 'demo mode' } as const;
const WXCC_CLASS = { synced: 'ok', failed: 'bad', not_configured: '' } as const;

export class HorrySupervisor extends LitElement {
  static properties = {
    server: { type: String },
    supervisor: { type: String },
    darkmode: darkmodeProperty,
    mode: { state: true },
    staffing: { state: true },
    pending: { state: true },
    confirm: { state: true },
    broadcastDraft: { state: true },
    busy: { state: true },
    error: { state: true },
    settings: { state: true },
    members: { state: true },
    callerDraft: { state: true },
    callerSaved: { state: true },
    textingLive: { state: true },
    resetDone: { state: true },
  };

  server = DEFAULT_SERVER;
  supervisor = '';
  darkmode = false;
  mode: ModeDto | null = null;
  staffing: StaffingDto | null = null;
  /** Team ids the supervisor has ticked but not applied yet (null = no pending edit). */
  pending: Set<string> | null = null;
  /** Which switch is waiting for "Yes" (empty = none). */
  confirm: '' | 'ai' | 'storm' | 'reset' = '';
  resetDone = false;
  broadcastDraft: string | null = null;
  busy = '';
  error = '';
  settings: SettingsDto | null = null;
  members: MemberOption[] = [];
  /** Unsaved phone / member edits (null = show what the service has). */
  callerDraft: { ani: string; sep: string; sms: string } | null = null;
  callerSaved = false;
  /** Real texts (the service has a texting number) vs simulated in the Storm Console outbox. */
  textingLive = false;
  private timer: number | undefined;

  static styles = [
    themeStyles,
    css`
      .wrap { display: grid; gap: 12px; }
      .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .between { justify-content: space-between; }
      .storm { display: grid; gap: 8px; }
      .group { font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--h-muted, inherit); opacity: .8; margin: 6px 2px -4px; }
      /* At a glance (Kristen 2026-10-29): colour only means "on". One summary line on top, a switch
         per mode (green when on), a green edge on the active card; every other button stays plain. */
      .summary { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 8px;
        background: var(--h-soft); border: 1px solid var(--h-border); }
      .summary.on { background: var(--h-ok-soft); border-color: var(--h-ok); }
      .summary .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--h-dim); flex: none; }
      .summary.on .dot { background: var(--h-ok); }
      .summary b { display: block; font-size: 15px; }
      .summary span { font-size: 12.5px; color: var(--h-dim); }
      .mode { border-left: 4px solid var(--h-border); }
      .mode.on { border-left-color: var(--h-ok); }
      .mode .state { font-size: 13px; color: var(--h-dim); }
      .mode.on .state { color: var(--h-ok); font-weight: 600; }
      .titlerow { display: flex; align-items: center; gap: 10px; }
      .switch { display: inline-flex; align-items: center; gap: 10px; background: none; border: 0; padding: 4px 0; cursor: pointer;
        font: inherit; font-size: 13px; font-weight: 600; color: var(--h-dim); }
      .switch .track { width: 46px; height: 26px; border-radius: 999px; background: var(--h-border); position: relative; transition: background .15s; flex: none; }
      .switch .knob { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff;
        box-shadow: 0 1px 3px rgba(0, 0, 0, .3); transition: left .15s; }
      .switch[aria-checked='true'] { color: var(--h-ok); }
      .switch[aria-checked='true'] .track { background: var(--h-ok); }
      .switch[aria-checked='true'] .knob { left: 23px; }
      .switch.partial .track { background: var(--h-ok-soft); box-shadow: inset 0 0 0 1.5px var(--h-ok); }
      .switch:disabled { cursor: default; opacity: .6; }
      .switch:focus-visible { outline: 2px solid var(--h-accent); outline-offset: 3px; border-radius: 6px; }
      button.apply { background: var(--h-navy); border-color: var(--h-navy); color: var(--h-bg); font-weight: 600; }
      button.apply:disabled { opacity: .45; }
      input[type='text'], select {
        font: inherit; width: 100%; padding: 6px 8px; border-radius: 6px;
        border: 1px solid var(--h-border); background: var(--h-bg); color: var(--h-text);
      }
      ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
      li label {
        display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 8px; align-items: center;
        padding: 6px 8px; border-radius: 6px; cursor: pointer;
      }
      li label:hover { background: var(--h-soft); }
      li.changed label { background: var(--h-accent-soft); }
      .counts { font-size: 12px; }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), 8000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.timer);
  }

  private get by(): string {
    return this.supervisor || 'supervisor';
  }

  private async refresh(): Promise<void> {
    try {
      const [mode, staffing, settings, members, health] = await Promise.all([
        api<ModeDto>(this.server, 'api/mode'),
        api<StaffingDto>(this.server, 'api/staffing'),
        api<SettingsDto>(this.server, 'api/settings'),
        api<{ members: MemberOption[] }>(this.server, 'api/members'),
        api<{ twilio?: boolean }>(this.server, 'health'),
      ]);
      this.textingLive = !!health.twilio;
      this.mode = mode;
      this.staffing = staffing;
      this.settings = settings;
      this.members = members.members;
    } catch (err) {
      this.error = `Can't reach the Horry service: ${(err as Error).message}`;
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

  // ---- AI agent + Storm Mode ---------------------------------------------------------

  private setMode(which: 'ai' | 'storm', on: boolean): Promise<void> {
    return this.run(which, async () => {
      type Raw = { storm: boolean; aiAll: boolean; aiRouting: boolean } & Omit<ModeDto, 'storm' | 'aiAll' | 'aiRouting'>;
      const m = await api<Raw>(this.server, 'api/mode', {
        method: 'POST',
        body: which === 'ai' ? { aiAll: on, by: this.by } : { storm: on, by: this.by },
      });
      const tf = (v: boolean) => (v ? 'true' : 'false') as 'true' | 'false';
      this.mode = { ...m, storm: tf(m.storm), aiAll: tf(m.aiAll), aiRouting: tf(m.aiRouting), wxccError: m.wxccError ?? '' };
      this.confirm = '';
    });
  }

  private saveBroadcast(): Promise<void> {
    const text = this.broadcastDraft ?? '';
    return this.run('broadcast', async () => {
      await api(this.server, 'api/mode/broadcast', { method: 'POST', body: { text } });
      this.broadcastDraft = null;
      await this.refresh();
    });
  }

  // ---- demo caller -------------------------------------------------------------------

  private editCaller(patch: Partial<{ ani: string; sep: string; sms: string }>): void {
    const base = this.callerDraft ?? { ani: this.settings?.demoAni ?? '', sep: this.settings?.demoMemberSep ?? '', sms: this.settings?.demoSmsTo ?? '' };
    this.callerDraft = { ...base, ...patch };
    this.callerSaved = false;
  }

  /** Storm Console "Reset demo data", from the Desktop: outages, balances, calls, chats, emails. */
  private resetDemo(): Promise<void> {
    return this.run('reset', async () => {
      await api(this.server, 'api/reset', { method: 'POST', body: {} });
      this.confirm = '';
      this.resetDone = true;
      await this.refresh();
    });
  }

  private saveCaller(): Promise<void> {
    const d = this.callerDraft;
    if (!d) return Promise.resolve();
    const ani = d.ani.replace(/\D/g, '').slice(-10);
    if (ani.length !== 10) {
      this.error = 'Enter the 10-digit number you will call from.';
      return Promise.resolve();
    }
    const smsTo = d.sms.replace(/D/g, '').slice(-10);
    if (smsTo && smsTo.length !== 10) {
      this.error = 'Enter a 10-digit cell number for demo texts, or leave it empty.';
      return Promise.resolve();
    }
    return this.run('caller', async () => {
      this.settings = await api<SettingsDto>(this.server, 'api/settings', { method: 'PATCH', body: { demoAni: ani, demoMemberSep: d.sep, demoSmsTo: smsTo } });
      this.callerDraft = null;
      this.callerSaved = true;
    });
  }

  // ---- staffing ----------------------------------------------------------------------

  private onQueueNow(): Set<string> {
    return new Set((this.staffing?.teams ?? []).filter((t) => t.onQueue).map((t) => t.id));
  }

  private toggle(id: string): void {
    const next = new Set(this.pending ?? this.onQueueNow());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const now = this.onQueueNow();
    const same = next.size === now.size && [...next].every((x) => now.has(x));
    this.pending = same ? null : next;
  }

  private applyStaffing(): Promise<void> {
    const ids = [...(this.pending ?? [])];
    return this.run('staffing', async () => {
      this.staffing = await api<StaffingDto>(this.server, 'api/staffing', { method: 'POST', body: { teamIds: ids, by: this.by } });
      this.pending = null;
    });
  }

  private resetStaffing(): Promise<void> {
    return this.run('staffing', async () => {
      this.staffing = await api<StaffingDto>(this.server, 'api/staffing/reset', { method: 'POST', body: { by: this.by } });
      this.pending = null;
    });
  }

  private teamName(id: string): string {
    return this.staffing?.teams.find((t) => t.id === id)?.name ?? id;
  }

  // ---- render ------------------------------------------------------------------------

  render() {
    const storm = this.mode?.storm === 'true';
    const extras = (this.staffing?.teams ?? []).filter((t) => t.onQueue && !t.home);
    return html`<div class="wrap">
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
      ${this.renderSummary(storm)}
      ${this.renderAi(storm)}
      <div class="group">Storm</div>
      ${this.renderStorm(storm)}
      ${!storm && extras.length && !this.pending
        ? html`<div class="note">
            Storm Mode is off, but ${extras.length} extra team${extras.length > 1 ? 's are' : ' is'} still on the outage queue
            (${extras.map((t) => t.name).join(', ')}).
            <div class="row" style="margin-top:6px">
              <button ?disabled=${!!this.busy} @click=${() => void this.resetStaffing()}>Return to normal staffing</button>
            </div>
          </div>`
        : nothing}
      ${this.renderStaffing()}
      <div class="group">Demo</div>
      ${this.renderCaller()}
    </div>`;
  }

  private renderCaller() {
    const s = this.settings;
    if (!s) return nothing;
    const ani = this.callerDraft?.ani ?? s.demoAni;
    const sep = this.callerDraft?.sep ?? s.demoMemberSep;
    const current = this.members.find((m) => m.memberSep === s.demoMemberSep);
    return html`<section class="card" aria-label="Demo caller">
      <h2>Demo caller</h2>
      <div class="dim">
        Calls from this number are treated as the member you pick: Savannah greets them by name and the agent's screen
        shows their account.
      </div>
      <div class="row">
        <input
          id="demo-ani"
          type="text"
          inputmode="tel"
          style="max-width:180px"
          placeholder="10-digit number"
          .value=${ani}
          @input=${(e: Event) => this.editCaller({ ani: (e.target as HTMLInputElement).value })}
        />
        <select
          id="demo-member"
          style="flex:1;min-width:220px"
          @change=${(e: Event) => this.editCaller({ sep: (e.target as HTMLSelectElement).value })}
        >
          ${this.members.map(
            (m) => html`<option value=${m.memberSep} ?selected=${m.memberSep === sep}>
              ${m.name} · ${m.address}${m.inOutage ? ' · in an outage' : ''}${m.pastDue > 0 ? ' · past due' : ''}
            </option>`,
          )}
        </select>
        <button class="apply" ?disabled=${!this.callerDraft || !!this.busy} @click=${() => void this.saveCaller()}>
          ${this.busy === 'caller' ? 'Saving…' : 'Save'}
        </button>
        ${this.callerDraft ? html`<button @click=${() => (this.callerDraft = null)}>Cancel</button>` : nothing}
      </div>
      <div class="row">
        <label for="demo-sms" class="dim" style="white-space:nowrap">Send demo texts to</label>
        <input
          id="demo-sms"
          type="text"
          inputmode="tel"
          style="max-width:180px"
          placeholder="any cell, or empty"
          .value=${this.callerDraft?.sms ?? s.demoSmsTo ?? ''}
          @input=${(e: Event) => this.editCaller({ sms: (e.target as HTMLInputElement).value })}
        />
        <span class="pill ${this.textingLive ? 'ok' : ''}">${this.textingLive ? 'texting live' : 'texts simulated'}</span>
      </div>
      <div class="dim">
        ${this.callerSaved ? 'Saved. ' : ''}Now: ${fmtPhone(s.demoAni) || 'no number'} calls as
        <strong>${current?.name ?? 'nobody'}</strong>.
        ${s.demoSmsTo
          ? html`Every text (outage updates, "power is back", pay links) goes to <strong>${fmtPhone(s.demoSmsTo)}</strong>.`
          : 'Texts go to the number the member gives.'}
        ${this.textingLive ? nothing : 'Until texting is live, texts show in the Storm Console.'}
      </div>
      ${this.confirm === 'reset'
        ? html`<div class="note">
            Reset the demo? Balances (Linda's ".18 is due again), outages and their estimates, calls, chats and emails go back
            to the start. Your demo numbers and the AI switches stay as they are.
            <div class="row" style="margin-top:6px">
              <button class="apply" ?disabled=${!!this.busy} @click=${() => void this.resetDemo()}>${this.busy === 'reset' ? 'Resetting…' : 'Yes, reset'}</button>
              <button @click=${() => (this.confirm = '')}>Cancel</button>
            </div>
          </div>`
        : html`<div class="row">
            <button ?disabled=${!!this.busy} @click=${() => { this.confirm = 'reset'; this.resetDone = false; }}>Reset demo data</button>
            ${this.resetDone ? html`<span class="dim">Done: back to the start.</span>` : nothing}
          </div>`}
    </section>`;
  }

  /** What callers get right now, in one line. */
  private renderSummary(storm: boolean) {
    const m = this.mode;
    if (!m) return nothing;
    const aiAll = m.aiAll === 'true';
    const [head, sub] = storm
      ? ['Savannah is answering every call: Storm Mode', 'She leads with the outage, confirms the estimate and offers a restoration text.']
      : aiAll
        ? ['Savannah is answering every call', 'Everyday greeting: she asks what they need and connects them with an agent when asked.']
        : ['Calls go straight to agents', 'Savannah is off. Turn on a switch below to have her answer first.'];
    return html`<div class="summary ${storm || aiAll ? 'on' : ''}" role="status">
      <span class="dot"></span>
      <div><b>${head}</b><span>${sub} Last change ${fmtClock(m.updatedAt)} by ${m.updatedBy}.</span></div>
    </div>`;
  }

  /** Switch in the card header; flipping it asks to confirm first. */
  private renderToggle(which: 'ai' | 'storm', on: boolean, label: string, partial = false) {
    return html`<button
      class="switch ${partial ? 'partial' : ''}"
      role="switch"
      aria-checked=${on ? 'true' : 'false'}
      aria-label=${label}
      ?disabled=${!this.mode || !!this.busy}
      @click=${() => (this.confirm = this.confirm === which ? '' : which)}
    >
      <span class="track"><span class="knob"></span></span>${on ? 'On' : partial ? 'Via Storm' : 'Off'}
    </button>`;
  }

  private renderConfirm(which: 'ai' | 'storm', on: boolean, ask: { on: string; off: string }) {
    if (this.confirm !== which) return nothing;
    return html`<div class="note">
      ${on ? ask.off : ask.on}
      <div class="row" style="margin-top:6px">
        <button class="apply" ?disabled=${!!this.busy} @click=${() => void this.setMode(which, !on)}>
          ${this.busy === which ? 'Updating…' : on ? 'Yes, turn it off' : 'Yes, turn it on'}
        </button>
        <button @click=${() => (this.confirm = '')}>Cancel</button>
      </div>
    </div>`;
  }

  private renderAi(storm: boolean) {
    const m = this.mode;
    const aiAll = m?.aiAll === 'true';
    const state = !m ? 'Loading…' : aiAll ? 'On: Savannah answers every call first' : storm ? 'Off, but Storm Mode has Savannah answering' : 'Off';
    return html`<section class="card storm mode ${aiAll ? 'on' : ''}" aria-label="AI agent">
      <div class="row between">
        <div class="titlerow">
          <h2>AI agent for all calls</h2>
          ${m ? html`<span class="pill ${WXCC_CLASS[m.wxcc]}" title=${m.wxccError}>${WXCC_LABEL[m.wxcc]}</span>` : nothing}
        </div>
        ${this.renderToggle('ai', aiAll, 'AI agent for all calls', !aiAll && storm)}
      </div>
      <div class="state">${state}</div>
      <div class="dim">
        For busy days, short-staffed days or bill due dates. Savannah greets every caller, asks what they need, handles
        outages, balances, payments and extensions, and connects them with a person whenever they ask.
      </div>
      ${this.renderConfirm('ai', aiAll, {
        on: 'Turn the AI agent on for all calls? New calls go to Savannah first, and she connects callers with an agent when needed.',
        off: storm
          ? 'Turn off AI for all calls? Storm Mode is still on, so Savannah keeps answering until Storm Mode is turned off.'
          : 'Turn off AI for all calls? New calls go straight to agents again.',
      })}
      <div style="display:grid;gap:4px">
        <h3>Note for Savannah to mention (optional)</h3>
        <div class="row">
          <input
            id="broadcast"
            type="text"
            placeholder="e.g. Bills are due on the 15th; you can pay by text link any time."
            .value=${this.broadcastDraft ?? m?.broadcast ?? ''}
            @input=${(e: Event) => (this.broadcastDraft = (e.target as HTMLInputElement).value)}
          />
          <button ?disabled=${this.broadcastDraft === null || !!this.busy} @click=${() => void this.saveBroadcast()}>Save message</button>
        </div>
      </div>
    </section>`;
  }

  private renderStorm(storm: boolean) {
    const m = this.mode;
    return html`<section class="card storm mode ${storm ? 'on' : ''}" aria-label="Storm Mode">
      <div class="row between">
        <h2>Storm Mode</h2>
        ${this.renderToggle('storm', storm, 'Storm Mode')}
      </div>
      <div class="state">${m ? (storm ? 'On: Savannah is answering outage calls' : 'Off') : 'Loading…'}</div>
      <div class="dim">
        Savannah answers every call and leads with the outage: once a member confirms their address, she asks whether
        the outage in their area is why they called, gives the restoration estimate and offers a text when power is back.
      </div>
      ${this.renderConfirm('storm', storm, {
        on: 'Turn Storm Mode on? New calls go to Savannah first, and she sends people to the outage queue when needed.',
        off: m?.aiAll === 'true'
          ? 'Turn Storm Mode off? AI for all calls is still on, so Savannah keeps answering with the everyday greeting.'
          : 'Turn Storm Mode off? New calls go back to normal routing.',
      })}
    </section>`;
  }

  private renderStaffing() {
    const s = this.staffing;
    if (!s) return html`<section class="card"><h2>Outage queue staffing</h2><div class="dim">Loading teams…</div></section>`;
    const now = this.onQueueNow();
    const sel = this.pending ?? now;
    const adding = [...sel].filter((id) => !now.has(id));
    const removing = [...now].filter((id) => !sel.has(id));
    const last = s.history[s.history.length - 1];
    return html`<section class="card" aria-label="Outage queue staffing">
      <div class="row between">
        <h2>Outage queue staffing</h2>
        <span class="pill ${WXCC_CLASS[s.wxcc]}" title=${s.error ?? ''}>${WXCC_LABEL[s.wxcc]}</span>
      </div>
      <div class="dim">
        Tick the teams that should take calls in <strong>${s.queue.name}</strong>. Their agents stay logged in to
        their own team and start getting outage calls as soon as you apply.
      </div>
      ${s.wxcc === 'failed' ? html`<div class="err">WxCC didn't accept the change: ${s.error}</div>` : nothing}
      <ul>
        ${s.teams.map((t) => {
          const checked = sel.has(t.id);
          const changed = checked !== now.has(t.id);
          return html`<li class=${changed ? 'changed' : ''}>
            <label>
              <input type="checkbox" id=${`team-${t.id}`} .checked=${checked} ?disabled=${!!this.busy} @change=${() => this.toggle(t.id)} />
              <span>${t.name}</span>
              ${t.home
                ? html`<span class="pill">normal</span>`
                : t.onQueue
                  ? html`<span class="pill warn">storm</span>`
                  : nothing}
            </label>
          </li>`;
        })}
      </ul>
      <div class="counts dim">
        ${now.size} team${now.size === 1 ? '' : 's'} on the queue now
        ${adding.length ? html` · adding ${adding.map((id) => this.teamName(id)).join(', ')}` : nothing}
        ${removing.length ? html` · removing ${removing.map((id) => this.teamName(id)).join(', ')}` : nothing}
      </div>
      <div class="row">
        <button class="apply" ?disabled=${!this.pending || sel.size === 0 || !!this.busy} @click=${() => void this.applyStaffing()}>
          ${this.busy === 'staffing' ? 'Updating queue…' : 'Apply to outage queue'}
        </button>
        ${this.pending ? html`<button @click=${() => (this.pending = null)}>Cancel</button>` : nothing}
        <button ?disabled=${!!this.busy} @click=${() => void this.resetStaffing()}>Return to normal</button>
      </div>
      ${sel.size === 0 ? html`<div class="err">Keep at least one team on the outage queue.</div>` : nothing}
      ${last
        ? html`<div class="dim">
            Last change ${fmtClock(last.at)} by ${last.by}:
            ${last.added.length ? `added ${last.added.map((id) => this.teamName(id)).join(', ')}` : ''}
            ${last.added.length && last.removed.length ? '; ' : ''}
            ${last.removed.length ? `removed ${last.removed.map((id) => this.teamName(id)).join(', ')}` : ''}
            ${!last.added.length && !last.removed.length ? 'no change' : ''}
          </div>`
        : nothing}
    </section>`;
  }
}

if (!customElements.get('horry-supervisor')) customElements.define('horry-supervisor', HorrySupervisor);
