// <horry-supervisor> — the supervisor's storm controls on the WxCC Desktop:
//   1. Storm Mode on/off (POST api/mode → WxCC global variable Global_StormMode) plus the
//      broadcast line Savannah reads to every caller.
//   2. Outage queue staffing (Kristen 2026-10-28, discovery item 3): tick the teams that
//      should take outage calls → POST api/staffing adds/removes those teams on the outage
//      queue's distribution group. Agents stay logged in to their own team.
// Polls every 8 s (the service has no push channel); a pending selection is never
// overwritten by a poll.
import { LitElement, css, html, nothing } from 'lit';
import { DEFAULT_SERVER, api, darkmodeProperty, fmtClock } from './common.js';
import { themeStyles } from './theme.js';

interface ModeDto {
  storm: 'true' | 'false';
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

const WXCC_LABEL = { synced: 'WxCC synced', failed: 'WxCC update failed', not_configured: 'demo mode' } as const;
const WXCC_CLASS = { synced: 'ok', failed: 'bad', not_configured: '' } as const;

export class HorrySupervisor extends LitElement {
  static properties = {
    server: { type: String },
    supervisor: { type: String },
    darkmode: darkmodeProperty,
    mode: { state: true },
    staffing: { state: true },
    pending: { state: true },
    confirmStorm: { state: true },
    broadcastDraft: { state: true },
    busy: { state: true },
    error: { state: true },
  };

  server = DEFAULT_SERVER;
  supervisor = '';
  darkmode = false;
  mode: ModeDto | null = null;
  staffing: StaffingDto | null = null;
  /** Team ids the supervisor has ticked but not applied yet (null = no pending edit). */
  pending: Set<string> | null = null;
  confirmStorm = false;
  broadcastDraft: string | null = null;
  busy = '';
  error = '';
  private timer: number | undefined;

  static styles = [
    themeStyles,
    css`
      .wrap { display: grid; gap: 12px; }
      .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .between { justify-content: space-between; }
      .storm { display: grid; gap: 8px; }
      .state { font-size: 18px; font-weight: 600; }
      .state.on { color: var(--h-accent); }
      .bigbtn { padding: 10px 16px; font-size: 14px; }
      input[type='text'] {
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
      const [mode, staffing] = await Promise.all([
        api<ModeDto>(this.server, 'api/mode'),
        api<StaffingDto>(this.server, 'api/staffing'),
      ]);
      this.mode = mode;
      this.staffing = staffing;
    } catch (err) {
      this.error = `Can't reach the storm service: ${(err as Error).message}`;
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

  // ---- Storm Mode --------------------------------------------------------------------

  private setStorm(on: boolean): Promise<void> {
    return this.run('storm', async () => {
      const m = await api<{ storm: boolean } & Omit<ModeDto, 'storm'>>(this.server, 'api/mode', {
        method: 'POST',
        body: { storm: on, by: this.by },
      });
      this.mode = { ...m, storm: m.storm ? 'true' : 'false', wxccError: m.wxccError ?? '' };
      this.confirmStorm = false;
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
    </div>`;
  }

  private renderStorm(storm: boolean) {
    const m = this.mode;
    return html`<section class="card storm" aria-label="Storm Mode">
      <div class="row between">
        <h2>Storm Mode</h2>
        ${m ? html`<span class="pill ${WXCC_CLASS[m.wxcc]}" title=${m.wxccError}>${WXCC_LABEL[m.wxcc]}</span>` : nothing}
      </div>
      <div class="state ${storm ? 'on' : ''}">${m ? (storm ? 'ON: Savannah is answering outage calls' : 'Off: normal routing') : 'Loading…'}</div>
      ${m ? html`<div class="dim">Last changed ${fmtClock(m.updatedAt)} by ${m.updatedBy}</div>` : nothing}
      ${this.confirmStorm
        ? html`<div class="note">
            ${storm
              ? 'Turn Storm Mode off? New calls go back to normal routing.'
              : 'Turn Storm Mode on? New calls go to Savannah first, and she sends people to the outage queue when needed.'}
            <div class="row" style="margin-top:6px">
              <button class="primary" ?disabled=${!!this.busy} @click=${() => void this.setStorm(!storm)}>
                ${this.busy === 'storm' ? 'Updating…' : storm ? 'Yes, turn it off' : 'Yes, turn it on'}
              </button>
              <button @click=${() => (this.confirmStorm = false)}>Cancel</button>
            </div>
          </div>`
        : html`<div class="row">
            <button class="bigbtn ${storm ? '' : 'primary'}" ?disabled=${!m || !!this.busy} @click=${() => (this.confirmStorm = true)}>
              ${storm ? 'Turn off Storm Mode' : 'Turn on Storm Mode'}
            </button>
          </div>`}
      <div style="display:grid;gap:4px">
        <h3>Message Savannah reads to every caller</h3>
        <div class="row">
          <input
            id="broadcast"
            type="text"
            placeholder="e.g. Crews are working the Socastee area tonight."
            .value=${this.broadcastDraft ?? m?.broadcast ?? ''}
            @input=${(e: Event) => (this.broadcastDraft = (e.target as HTMLInputElement).value)}
          />
          <button ?disabled=${this.broadcastDraft === null || !!this.busy} @click=${() => void this.saveBroadcast()}>Save message</button>
        </div>
      </div>
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
        <button class="primary" ?disabled=${!this.pending || sel.size === 0 || !!this.busy} @click=${() => void this.applyStaffing()}>
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
