// <horry-chat> — web chats from the co-op website on the WxCC Desktop (discovery item 6).
// A member chats with Savannah on site.html; when they ask for a person (or Savannah
// escalates) the chat waits here. The agent picks it up, sees the whole transcript
// (Savannah's part included) plus the member's account summary, replies, and closes.
// Donor: home-services ihs-sms (webchat threads) — simplified to polling, no socket.
//
// <horry-chat-badge> — compact header pill: chats waiting for an agent + unread replies.
//
// Both poll the service (relative paths via joinUrl — behind nginx /horry/).
import { LitElement, css, html, nothing } from 'lit';
import { DEFAULT_SERVER, api, darkmodeProperty, fmtClock } from './common.js';
import { themeStyles } from './theme.js';

type ChatStatus = 'ai' | 'waiting' | 'agent' | 'closed';

interface ChatRow {
  id: string;
  name: string;
  memberName: string;
  memberSep: string;
  status: ChatStatus;
  startedAt: string;
  lastAt: string;
  agentName: string;
  department: string;
  reason: string;
  waitingSince: string;
  unread: number;
  lastText: string;
}

interface ChatList {
  assistant: 'live' | 'scripted';
  waiting: number;
  active: number;
  withAssistant: number;
  unread: number;
  chats: ChatRow[];
}

interface ChatMessage {
  seq: number;
  at: string;
  role: 'visitor' | 'assistant' | 'agent' | 'system';
  text: string;
  by?: string;
  link?: { href: string; label: string };
}

interface ChatDetail extends ChatRow {
  contact: string;
  messages: ChatMessage[];
  journey: { at: string; step: string; detail: string }[];
  handoff?: { reason: string; did: string[]; theirWords: string };
}

interface MemberCard {
  member: { memberSep: string; name: string; address: string; phone: string | null; email: string | null; lifeSupport: boolean };
  billing: { AmountDue: number; DueDate: string; PastDueAmount: number; CutOffDate: string | null; CardProfileExists: boolean; Last4CcDigits: string | null } | null;
  outage: { id: string; area: string; customers: number; cause: string; crew: string; etrText: string } | null;
}

const STATUS_LABEL: Record<ChatStatus, string> = { ai: 'With Savannah', waiting: 'Waiting', agent: 'Live', closed: 'Ended' };
const STATUS_CLASS: Record<ChatStatus, string> = { ai: '', waiting: 'bad', agent: 'ok', closed: '' };
const DEPT: Record<string, string> = { outage: 'Outage', billing: 'Billing', member_services: 'Member services' };
const fmtPhone = (p: string | null) => (p && /^\d{10}$/.test(p) ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p || '—');
const money = (n: number | null | undefined) => `$${(n ?? 0).toFixed(2)}`;
const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

function waitText(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function chime(): void {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.35);
  } catch {
    /* audio blocked until the agent interacts — the badge still shows the count */
  }
}

export class HorryChat extends LitElement {
  static properties = {
    server: { type: String },
    agentname: { type: String },
    agentid: { type: String },
    darkmode: darkmodeProperty,
    list: { state: true },
    selectedId: { state: true },
    detail: { state: true },
    card: { state: true },
    draft: { state: true },
    busy: { state: true },
    error: { state: true },
    showClosed: { state: true },
  };

  server = DEFAULT_SERVER;
  agentname = '';
  agentid = '';
  darkmode = false;
  list: ChatList | null = null;
  selectedId = '';
  detail: ChatDetail | null = null;
  card: MemberCard | null = null;
  draft = '';
  busy = '';
  error = '';
  /** Ended chats are listed for review by default; the agent can fold the section away. */
  showClosed = true;
  private timer: number | undefined;
  private lastWaiting = new Set<string>();
  private cardFor = '';
  private renderedSeq = 0;

  static styles = [
    themeStyles,
    css`
      :host { padding: 0; }
      .grid { display: grid; grid-template-columns: minmax(200px, 280px) minmax(0, 1fr); height: 100%; min-height: 420px; }
      @media (max-width: 680px) { .grid { grid-template-columns: 1fr; grid-template-rows: auto minmax(360px, 1fr); } }
      aside { border-right: 1px solid var(--h-border); display: flex; flex-direction: column; min-height: 0; background: var(--h-soft); }
      .ahead { padding: 10px 12px; display: grid; gap: 6px; border-bottom: 1px solid var(--h-border); }
      .counts { display: flex; gap: 6px; flex-wrap: wrap; }
      ul { list-style: none; margin: 0; padding: 6px; overflow: auto; flex: 1; display: grid; gap: 4px; align-content: start; }
      li button {
        width: 100%; text-align: left; display: grid; gap: 2px; padding: 8px 10px; border-radius: 8px;
        border: 1px solid transparent; background: transparent;
      }
      li button:hover { background: var(--h-bg); border-color: var(--h-border); }
      li button.sel { background: var(--h-bg); border-color: var(--h-accent); }
      li .top { display: flex; justify-content: space-between; gap: 6px; align-items: center; }
      li .who { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      li .last { font-size: 12px; color: var(--h-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .unread { background: var(--h-accent); color: #fff; border-radius: 999px; font-size: 11px; padding: 0 6px; font-weight: 700; }
      .toggle { font-size: 12px; padding: 2px 8px; }
      li.sect { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--h-border); }
      li.sect .toggle { width: 100%; text-align: left; border: 0; background: transparent; color: var(--h-dim); font-weight: 600; }
      li.ended .who { color: var(--h-dim); }
      section.conv { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
      .chead { padding: 10px 14px; border-bottom: 1px solid var(--h-border); display: grid; gap: 8px; }
      .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .between { justify-content: space-between; }
      .acct { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 6px 14px; font-size: 12.5px; }
      .acct b { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--h-dim); font-weight: 600; }
      .msgs { flex: 1; overflow: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
      .m { max-width: 80%; padding: 7px 11px; border-radius: 10px; overflow-wrap: anywhere; }
      .m .t { white-space: pre-wrap; }
      .m .lbl { display: block; font-size: 10.5px; font-weight: 700; color: var(--h-dim); margin-bottom: 2px; }
      .m.visitor { align-self: flex-start; background: var(--h-soft); border: 1px solid var(--h-border); }
      .m.assistant { align-self: flex-end; background: var(--h-bg); border: 1px dashed var(--h-border); color: var(--h-dim); }
      .m.agent { align-self: flex-end; background: var(--h-navy); color: var(--h-bg); }
      .m.agent .lbl { color: inherit; opacity: 0.8; }
      .m.system { align-self: center; font-size: 12px; color: var(--h-accent); background: var(--h-accent-soft); border-radius: 999px; padding: 3px 12px; text-align: center; }
      .m.system a { color: inherit; font-weight: 600; }
      .divider { align-self: stretch; text-align: center; font-size: 11px; color: var(--h-dim); border-top: 1px solid var(--h-border); padding-top: 4px; }
      /* Kristen 2026-10-29: summary on top, transcript scrolls in the middle, a roomy reply area with quick replies. */
      .sum { margin: 10px 14px 0; padding: 10px 12px; border-radius: 8px; background: var(--h-soft); border: 1px solid var(--h-border);
        border-left: 4px solid var(--h-accent); display: grid; gap: 6px; font-size: 13px; }
      .sum h3 { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--h-dim); }
      .sum ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; overflow: visible; }
      .sum li::before { content: '✓ '; color: var(--h-ok); font-weight: 700; }
      .sum .why { font-weight: 600; }
      .sum q { font-style: italic; }
      .tlabel { padding: 8px 14px 0; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--h-dim); font-weight: 600; }
      .msgs { border-top: 1px solid var(--h-border); border-bottom: 1px solid var(--h-border); margin: 4px 14px 0; border-radius: 6px;
        border-left: 1px solid var(--h-border); border-right: 1px solid var(--h-border); background: var(--h-bg); }
      .composer { display: grid; gap: 8px; padding: 10px 14px 12px; background: var(--h-soft); border-top: 1px solid var(--h-border); margin-top: 10px; }
      .quick { display: flex; flex-wrap: wrap; gap: 6px; }
      .quick button { font-size: 12px; padding: 4px 10px; border-radius: 999px; background: var(--h-bg); }
      .quick button:hover { border-color: var(--h-accent); color: var(--h-accent); }
      .send { display: flex; gap: 8px; align-items: flex-end; }
      textarea {
        flex: 1; font: inherit; resize: vertical; padding: 9px 11px; border-radius: 8px; min-height: 96px;
        border: 1px solid var(--h-border); background: var(--h-bg); color: var(--h-text);
      }
      .send button { min-width: 84px; padding: 10px 14px; }
      .empty { margin: auto; text-align: center; color: var(--h-dim); padding: 24px; display: grid; gap: 6px; }
      .journey { font-size: 12px; color: var(--h-dim); }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), 2500);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.timer);
  }

  private get me(): string {
    return this.agentname || 'Member Services';
  }

  private async refresh(): Promise<void> {
    try {
      const list = await api<ChatList>(this.server, 'api/chats');
      const waiting = new Set(list.chats.filter((c) => c.status === 'waiting').map((c) => c.id));
      if ([...waiting].some((id) => !this.lastWaiting.has(id))) chime();
      this.lastWaiting = waiting;
      this.list = list;
      if (!this.selectedId) {
        const first = list.chats.find((c) => c.status === 'waiting') ?? list.chats.find((c) => c.status === 'agent' && c.agentName === this.me);
        if (first) this.selectedId = first.id;
      }
      if (this.selectedId) await this.loadDetail();
      this.error = '';
    } catch (err) {
      this.error = `Can't reach the chat service: ${(err as Error).message}`;
    }
  }

  private async loadDetail(): Promise<void> {
    const mine = this.detail?.status === 'agent' && this.detail.agentName === this.me;
    const d = await api<ChatDetail>(this.server, `api/chats/${encodeURIComponent(this.selectedId)}${mine ? '?seen=1' : ''}`).catch(() => null);
    if (!d) {
      this.detail = null;
      this.selectedId = '';
      return;
    }
    this.detail = d;
    if (d.memberSep && this.cardFor !== d.memberSep) {
      this.cardFor = d.memberSep;
      this.card = await api<MemberCard>(this.server, `api/member?sep=${encodeURIComponent(d.memberSep)}`).catch(() => null);
    } else if (!d.memberSep) {
      this.cardFor = '';
      this.card = null;
    }
  }

  private async select(id: string): Promise<void> {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.detail = null;
    this.renderedSeq = 0;
    await this.loadDetail();
  }

  private async act(kind: 'accept' | 'send' | 'close'): Promise<void> {
    const id = this.selectedId;
    if (!id || this.busy) return;
    this.busy = kind;
    try {
      if (kind === 'accept') await api(this.server, `api/chats/${encodeURIComponent(id)}/accept`, { method: 'POST', body: { agentName: this.me, agentId: this.agentid } });
      if (kind === 'send') {
        const text = this.draft.trim();
        if (!text) return;
        await api(this.server, `api/chats/${encodeURIComponent(id)}/message`, { method: 'POST', body: { text, agentName: this.me, agentId: this.agentid } });
        this.draft = '';
      }
      if (kind === 'close') await api(this.server, `api/chats/${encodeURIComponent(id)}/close`, { method: 'POST', body: {} });
      await this.refresh();
      this.error = '';
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.busy = '';
    }
  }

  protected updated(): void {
    const box = this.renderRoot.querySelector('.msgs');
    const n = this.detail?.messages.length ?? 0;
    if (box && n !== this.renderedSeq) {
      this.renderedSeq = n;
      box.scrollTop = box.scrollHeight;
    }
  }

  render() {
    return html`<div class="grid">
      ${this.renderList()}
      <section class="conv" aria-label="Chat">${this.renderConversation()}</section>
    </div>`;
  }

  private renderList() {
    const l = this.list;
    const open = (l?.chats ?? []).filter((c) => c.status !== 'closed');
    const ended = (l?.chats ?? []).filter((c) => c.status === 'closed');
    return html`<aside aria-label="Web chats">
      <div class="ahead">
        <div class="row between">
          <h2>Web chats</h2>
          ${l?.assistant === 'scripted' ? html`<span class="pill" title="The virtual assistant is running its offline script">demo mode</span>` : nothing}
        </div>
        <div class="counts">
          <span class="pill ${l?.waiting ? 'bad' : ''}">${l?.waiting ?? 0} waiting</span>
          <span class="pill ${l?.active ? 'ok' : ''}">${l?.active ?? 0} live</span>
          <span class="pill">${l?.withAssistant ?? 0} with Savannah</span>
        </div>
      </div>
      ${this.error ? html`<div class="err" style="margin:8px">${this.error}</div>` : nothing}
      <ul>
        ${open.length === 0 ? html`<li class="dim" style="padding:10px">No open web chats right now.</li>` : nothing}
        ${open.map((c) => this.renderItem(c))}
        ${ended.length
          ? html`<li class="sect">
              <button class="toggle" aria-expanded=${this.showClosed ? 'true' : 'false'} @click=${() => (this.showClosed = !this.showClosed)}>
                ${this.showClosed ? '▾' : '▸'} Ended · last 7 days (${ended.length})
              </button>
            </li>`
          : nothing}
        ${this.showClosed ? ended.map((c) => this.renderItem(c)) : nothing}
      </ul>
    </aside>`;
  }

  private renderItem(c: ChatRow) {
    const closed = c.status === 'closed';
    const when = new Date(c.lastAt).toDateString() === new Date().toDateString()
      ? fmtClock(c.lastAt)
      : `${new Date(c.lastAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${fmtClock(c.lastAt)}`;
    return html`<li class=${closed ? 'ended' : ''}>
      <button class=${c.id === this.selectedId ? 'sel' : ''} @click=${() => void this.select(c.id)}>
        <span class="top">
          <span class="who">${c.memberName || c.name || 'Website visitor'}</span>
          ${c.unread ? html`<span class="unread">${c.unread}</span>` : html`<span class="pill ${STATUS_CLASS[c.status]}">${STATUS_LABEL[c.status]}</span>`}
        </span>
        <span class="last">
          ${c.status === 'waiting'
            ? html`<strong>${DEPT[c.department] ?? 'Member services'}</strong> · waiting ${waitText(c.waitingSince)}`
            : closed
              ? `${when} · ${c.agentName || 'Savannah only'}`
              : c.status === 'agent' ? html`${c.agentName} · ${fmtClock(c.lastAt)}` : fmtClock(c.lastAt)}
        </span>
        <span class="last">${c.lastText}</span>
      </button>
    </li>`;
  }

  private renderConversation() {
    const d = this.detail;
    if (!d) {
      return html`<div class="empty">
        <strong>No chat selected</strong>
        <span>Chats that need a person appear on the left. Savannah handles the rest on her own. Pick an ended chat to read it again.</span>
      </div>`;
    }
    const mine = d.status === 'agent' && d.agentName === this.me;
    const othersChat = d.status === 'agent' && !mine;
    const escAt = d.messages.find((m) => m.role === 'system' && /^Connecting you/.test(m.text))?.seq ?? 0;
    return html`
      <div class="chead">
        <div class="row between">
          <div>
            <h2>${d.memberName || d.name || 'Website visitor'}</h2>
            <div class="dim" style="font-size:12px">
              Web chat · started ${fmtClock(d.startedAt)}${d.department ? html` · ${DEPT[d.department] ?? d.department}: ${d.reason.replace(/_/g, ' ')}` : nothing}
            </div>
          </div>
          <div class="row">
            <span class="pill ${STATUS_CLASS[d.status]}">${d.status === 'agent' ? `Live · ${d.agentName}` : STATUS_LABEL[d.status]}</span>
            ${d.status === 'waiting' || d.status === 'ai'
              ? html`<button class="primary" ?disabled=${!!this.busy} @click=${() => void this.act('accept')}>${d.status === 'ai' ? 'Join chat' : 'Accept chat'}</button>`
              : nothing}
            ${mine ? html`<button ?disabled=${!!this.busy} @click=${() => void this.act('close')}>End chat</button>` : nothing}
          </div>
        </div>
        ${this.renderAccount(d)}
      </div>
      ${this.renderHandoff(d)}
      <div class="tlabel">Full conversation</div>
      <div class="msgs" aria-live="polite">
        ${d.messages.map((m) => html`${m.seq === escAt ? html`<div class="divider">Handed off by Savannah — everything above is the virtual assistant's part</div>` : nothing}${this.renderMsg(m)}`)}
      </div>
      ${mine
        ? html`<div class="composer">
            <div class="quick" role="group" aria-label="Quick replies">
              ${this.quickReplies(d).map(
                (q) => html`<button type="button" title=${q.text} @click=${() => this.useQuick(q.text)}>${q.label}</button>`,
              )}
            </div>
            <div class="send">
            <textarea
              rows="4"
              aria-label="Reply to the member"
              placeholder="Reply to ${d.memberName ? titleCase(d.memberName).split(' ')[0] : 'the member'}…"
              .value=${this.draft}
              @input=${(e: Event) => (this.draft = (e.target as HTMLTextAreaElement).value)}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void this.act('send');
                }
              }}
            ></textarea>
            <button class="primary" ?disabled=${!this.draft.trim() || !!this.busy} @click=${() => void this.act('send')}>Send</button>
            </div>
            <div class="dim" style="font-size:11.5px">Enter sends · Shift+Enter for a new line · a quick reply fills the box so you can edit it first</div>
          </div>`
        : othersChat
          ? html`<div class="note" style="margin:10px 14px">${d.agentName} has this chat.</div>`
          : d.status === 'closed'
            ? html`<div class="dim" style="padding:10px 14px">This chat has ended.</div>`
            : nothing}
    `;
  }

  private renderHandoff(d: ChatDetail) {
    const h = d.handoff;
    if (!h || (!h.reason && !h.did.length && !h.theirWords)) return nothing;
    return html`<div class="sum" aria-label="Summary">
      <h3>Summary from Savannah</h3>
      ${h.reason ? html`<div class="why">Why it came to you: ${h.reason}</div>` : nothing}
      ${h.did.length ? html`<ul>${h.did.map((x) => html`<li>${x}</li>`)}</ul>` : html`<div class="dim">Savannah didn't complete anything on the account yet.</div>`}
      ${h.theirWords ? html`<div>In their words: <q>${h.theirWords}</q></div>` : nothing}
    </div>`;
  }

  private quickReplies(d: ChatDetail): { label: string; text: string }[] {
    const me = this.me.split(/\s+/)[0] || this.me;
    const member = d.memberName ? titleCase(d.memberName).split(' ')[0] : '';
    const hi = member ? `Hi ${member}, this` : 'Hello, this';
    return [
      { label: 'Greeting', text: `${hi} is ${me} with Horry Electric. How can I help you today?` },
      { label: 'I read your chat', text: `${hi} is ${me} with Horry Electric. I've read your conversation with Savannah, so you won't need to repeat anything.` },
      { label: 'One moment', text: 'Let me check on that for you. One moment, please.' },
      { label: 'Outage update', text: "I'll make sure you get a text as soon as your power is restored, and if the estimate changes." },
      { label: 'Anything else?', text: 'Is there anything else I can help you with today?' },
      { label: 'Closing', text: 'Thank you for chatting with Horry Electric Cooperative. Have a great day!' },
    ];
  }

  private useQuick(text: string): void {
    this.draft = text;
    void this.updateComplete.then(() => {
      const ta = this.renderRoot.querySelector('textarea');
      ta?.focus();
      ta?.setSelectionRange(text.length, text.length);
    });
  }

  private renderAccount(d: ChatDetail) {
    const c = this.card;
    if (!d.memberSep || !c) {
      return html`<div class="note">Not identified yet${d.contact ? ` — typed ${d.contact}` : ''}. Ask for the account number or the phone number on the account.</div>`;
    }
    const b = c.billing;
    return html`<div class="acct">
      <div><b>Account</b>${c.member.memberSep}</div>
      <div><b>Service address</b>${titleCase(c.member.address)}</div>
      <div><b>Phone</b>${fmtPhone(c.member.phone)}</div>
      ${b
        ? html`<div><b>Balance</b>${money(b.AmountDue)} due ${b.DueDate}${b.PastDueAmount > 0 ? html` · <span style="color:var(--h-danger)">${money(b.PastDueAmount)} past due</span>` : nothing}</div>`
        : nothing}
      <div><b>Outage</b>${c.outage ? html`<span style="color:var(--h-accent)">${c.outage.area.split(',')[0]} · ${c.outage.customers} out · ETR ${c.outage.etrText}</span>` : 'None at this address'}</div>
      ${c.member.lifeSupport ? html`<div><b>Priority</b><span class="pill bad">Life support</span></div>` : nothing}
    </div>`;
  }

  private renderMsg(m: ChatMessage) {
    const lbl =
      m.role === 'visitor' ? 'Member' : m.role === 'assistant' ? 'Savannah · virtual assistant' : m.role === 'agent' ? m.by ?? 'Agent' : '';
    const href = m.link ? `${this.server.replace(/\/+$/, '')}/${m.link.href}` : '';
    // No whitespace between the tags: the text span is pre-wrap.
    return html`<div class="m ${m.role}" title=${fmtClock(m.at)}>${lbl ? html`<span class="lbl">${lbl} · ${fmtClock(m.at)}</span>` : nothing}<span class="t">${m.text}</span>${m.link ? html` · <a href=${href} target="_blank" rel="noopener">${m.link.label}</a>` : nothing}</div>`;
  }
}

/** Header pill: chats waiting on an agent (+ unread member replies). Polls every 4 s. */
export class HorryChatBadge extends LitElement {
  static properties = {
    server: { type: String },
    darkmode: darkmodeProperty,
    waiting: { state: true },
    unread: { state: true },
    up: { state: true },
  };

  server = DEFAULT_SERVER;
  darkmode = false;
  waiting = 0;
  unread = 0;
  up = true;
  private timer: number | undefined;

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), 4000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    try {
      const l = await api<ChatList>(this.server, 'api/chats');
      if (l.waiting > this.waiting || l.unread > this.unread) chime();
      this.waiting = l.waiting;
      this.unread = l.unread;
      this.up = true;
    } catch {
      this.up = false;
    }
  }

  render() {
    const n = this.waiting + this.unread;
    return html`<span
      class="pill ${n ? 'hot' : ''} ${this.up ? '' : 'down'}"
      title="${this.waiting} web chat${this.waiting === 1 ? '' : 's'} waiting for an agent · ${this.unread} unread member repl${this.unread === 1 ? 'y' : 'ies'} — open Web Chats to answer"
      >Web chats <b>${n}</b></span
    >`;
  }

  // Not themeStyles: a header pill must stay compact (no card padding/background).
  static styles = css`
    :host { display: inline-flex; align-items: center; font: 12.5px/1 'Segoe UI', system-ui, sans-serif; }
    .pill { display: inline-flex; align-items: center; gap: 7px; padding: 6px 12px; border-radius: 999px;
      background: rgba(18, 58, 94, 0.08); color: #123a5e; font-weight: 700; white-space: nowrap; }
    :host([darkmode='true']) .pill { background: rgba(255, 255, 255, 0.12); color: #e3e8ee; }
    .pill b { background: #64748b; color: #fff; border-radius: 999px; min-width: 18px; height: 18px;
      display: inline-flex; align-items: center; justify-content: center; padding: 0 5px; font-size: 11px; }
    .pill.hot b { background: #b8620a; }
    .pill.down { opacity: 0.55; }
  `;
}

if (!customElements.get('horry-chat')) customElements.define('horry-chat', HorryChat);
if (!customElements.get('horry-chat-badge')) customElements.define('horry-chat-badge', HorryChatBadge);
