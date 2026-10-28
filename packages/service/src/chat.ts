// Web chat (discovery item 6): a member on the co-op's website chats with Savannah — a
// real ElevenLabs text conversation when ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID are set,
// a scripted Savannah otherwise that still runs on our real data (it calls this service's
// own /api/tools/* handlers through app.inject, so member lookup, outage status, billing,
// payment links and journey steps are byte-for-byte the phone path). When the member asks
// for a person, or Savannah calls `escalate`, the chat waits for a live agent in the
// <horry-chat> Desktop widget with the whole transcript. Donor: home-services chat.ts.
//
// Correlation: the chat id IS the call-row guid (channel 'chat'). The real agent's tools
// get it as `sip_call_guid` (a dynamic variable we pass at initiation), so the existing
// tool handlers resolve the chat's row with no change to routes.ts — and the dashboard
// counts the chat like any call.
//
// Visitor side and agent side both poll (relative `api/...` paths behind /horry/).
import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { env, last10 } from './env.js';
import type { Deps } from './routes.js';
import type { Member } from './members.js';
import { displayName, displayAddress } from './members.js';
import type { Outage } from './outages.js';
import { spokenEtr } from './outages.js';
import type { CallRow } from './calls.js';

const ASSISTANT = 'Savannah';
const money = (n: number | null | undefined) => `$${(n ?? 0).toFixed(2)}`;
const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

export interface ChatMessage {
  seq: number;
  at: string;
  role: 'visitor' | 'assistant' | 'agent' | 'system';
  text: string;
  by?: string; // live agent's name on role 'agent'
  link?: { href: string; label: string }; // relative to the service root (pay.html?s=…)
}

export type ChatStatus = 'ai' | 'waiting' | 'agent' | 'closed';

export interface ChatSession {
  id: string; // = call-row guid
  name: string;
  contact: string; // what the visitor typed (phone or account), digits only
  memberSep?: string;
  memberName?: string;
  startedAt: string;
  lastAt: string;
  status: ChatStatus;
  agentName?: string;
  agentId?: string;
  messages: ChatMessage[];
  escalation?: { at: string; department: string; reason: string };
  closedBy?: 'visitor' | 'agent' | 'timeout';
  /** last visitor seq the live agent has seen (unread = visitor lines after it). */
  agentSeenSeq: number;
  // internals
  fellBack?: boolean;
  greetingEchoDropped?: boolean;
  lastOffer?: Offer;
  /** scripted mode: escalate AFTER the reply that announces it is shown */
  pendingEscalation?: Record<string, unknown>;
  shownPayments: string[];
}

type Offer = 'outage_confirm' | 'triage' | 'restoration' | 'payment' | 'identify' | undefined;

// ---------------------------------------------------------------------------------------
// The AI side: a transport delivers Savannah's replies for one session.

interface ChatTransport {
  start(session: ChatSession, vars: Record<string, string>, onReply: (text: string) => void, onDead: () => void): Promise<void> | void;
  userMessage(session: ChatSession, text: string): void;
  stop(id: string): void;
}

/** Real Savannah over an ElevenLabs text-only conversation socket (signed URL). */
class ElevenLabsChatTransport implements ChatTransport {
  private sockets = new Map<string, WebSocket>();
  private replied = new Set<string>();
  private onDeadFor = new Map<string, () => void>();
  /** Lines typed while the socket is still connecting — sent right after initiation. */
  private queued = new Map<string, string[]>();

  constructor(private apiKey: string, private agentId: string) {}

  async start(session: ChatSession, vars: Record<string, string>, onReply: (text: string) => void, onDead: () => void): Promise<void> {
    if (typeof WebSocket === 'undefined') throw new Error('this Node has no global WebSocket (needs Node 22+)');
    this.onDeadFor.set(session.id, onDead);
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(this.agentId)}`, {
      headers: { 'xi-api-key': this.apiKey },
      signal: AbortSignal.timeout(5000), // a hang falls back to the scripted assistant
    });
    if (!r.ok) throw new Error(`signed-url HTTP ${r.status}`);
    const { signed_url } = (await r.json()) as { signed_url: string };
    const ws = new WebSocket(signed_url);
    this.sockets.set(session.id, ws);
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          type: 'conversation_initiation_client_data',
          // Only conversation.text_only is a permitted override on this agent (checked
          // 2026-10-28); the greeting rides the {{first_message}} dynamic variable.
          conversation_config_override: { conversation: { text_only: true } },
          dynamic_variables: vars,
        })
      );
      for (const text of this.queued.get(session.id) ?? []) ws.send(JSON.stringify({ type: 'user_message', text }));
      this.queued.delete(session.id);
    });
    ws.addEventListener('message', (ev) => {
      try {
        const frame = JSON.parse(String(ev.data)) as {
          type?: string;
          ping_event?: { event_id?: number };
          agent_response_event?: { agent_response?: string };
          error?: unknown;
        };
        if (frame.type === 'ping') ws.send(JSON.stringify({ type: 'pong', event_id: frame.ping_event?.event_id }));
        else if (frame.type === 'agent_response' && frame.agent_response_event?.agent_response) {
          this.replied.add(session.id);
          onReply(frame.agent_response_event.agent_response);
        } else if (frame.type === 'error' || frame.error) {
          console.warn(`HORRY CHAT ${session.id}: assistant error frame — ${String(ev.data).slice(0, 300)}`);
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.addEventListener('close', (ev) => {
      if (this.sockets.get(session.id) !== ws) return; // deliberate stop()
      this.sockets.delete(session.id);
      if (!this.replied.has(session.id)) {
        console.warn(`HORRY CHAT ${session.id}: assistant socket closed before any reply (${ev.code} ${ev.reason})`);
        this.dead(session.id);
      }
    });
    ws.addEventListener('error', () => ws.close());
  }

  userMessage(session: ChatSession, text: string): void {
    const ws = this.sockets.get(session.id);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'user_message', text }));
      return;
    }
    if (ws && ws.readyState === 0) {
      this.queued.set(session.id, [...(this.queued.get(session.id) ?? []), text]);
      return;
    }
    this.dead(session.id); // never let a message vanish silently
  }

  stop(id: string): void {
    this.onDeadFor.delete(id);
    try {
      this.sockets.get(id)?.close();
    } catch {
      /* already closed */
    }
    this.sockets.delete(id);
    this.replied.delete(id);
    this.queued.delete(id);
  }

  private dead(id: string): void {
    const cb = this.onDeadFor.get(id);
    this.onDeadFor.delete(id);
    cb?.();
  }
}

/** Scripted Savannah: keyword-driven, but every fact comes from our own tool handlers. */
class ScriptedTransport implements ChatTransport {
  private replyTo = new Map<string, (text: string) => void>();

  constructor(private callTool: (name: string, guid: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>) {}

  start(session: ChatSession, _vars: Record<string, string>, onReply: (text: string) => void): void {
    this.replyTo.set(session.id, onReply);
  }

  userMessage(session: ChatSession, text: string): void {
    const onReply = this.replyTo.get(session.id);
    if (!onReply) return;
    void this.answer(session, text)
      .catch((err) => {
        console.warn(`HORRY CHAT ${session.id}: scripted reply failed — ${String(err)}`);
        return "I'm sorry — our member system isn't responding right now. Would you like me to connect you with a member services representative?";
      })
      .then((reply) =>
        setTimeout(() => {
          onReply(reply);
          const esc = session.pendingEscalation;
          session.pendingEscalation = undefined;
          if (esc) this.callTool('escalate', session.id, esc).catch((err) => console.warn(`HORRY CHAT ${session.id}: escalate failed — ${String(err)}`));
        }, 700 + Math.random() * 700).unref()
      );
  }

  stop(id: string): void {
    this.replyTo.delete(id);
  }

  private async answer(s: ChatSession, raw: string): Promise<string> {
    const t = raw.toLowerCase();
    const yes = /^(yes|yeah|yep|sure|ok|okay|please|y)\b|\byes\b|text me|send (it|the link)/.test(t);
    const no = /^(no|nope|not now|no thanks)\b/.test(t);
    const offer = s.lastOffer;
    s.lastOffer = undefined;

    // Identify first (the start form may have been left blank).
    if (!s.memberSep) {
      const d = raw.replace(/\D/g, '');
      if (d.length >= 10) {
        const body = d.length === 11 || (d.length > 10 && d.startsWith('0')) ? { account_number: d } : { phone_number: d.slice(-10) };
        const r = await this.callTool('lookup-member', s.id, body);
        if (r.found) {
          s.memberSep = String(r.account_number ?? '') || s.memberSep;
          s.memberName = String(r.member_name);
          return `Thanks — I found the account for ${r.member_name} at ${titleCase(String(r.service_address))}. What can I help you with today: an outage, your bill, or a payment?`;
        }
        s.lastOffer = 'identify';
        return "I couldn't find an account with that. Could you try the account number from your bill, or the phone number on the account?";
      }
      s.lastOffer = 'identify';
      return 'Happy to help! First, what is the phone number or account number on your Horry Electric account?';
    }

    if (/\b(wire|wires|line down|lines down|sparking|spark|fire|smoke|tree on (the|a) line)\b/.test(t)) {
      await this.callTool('report-outage', s.id, { whole_house: 'unknown', neighbors_out: 'unknown', hazard: /fire|smoke/.test(t) ? 'fire' : /spark/.test(t) ? 'sparking' : /tree/.test(t) ? 'tree_on_line' : 'wires_down', details: raw.slice(0, 200) });
      s.pendingEscalation = { department: 'outage', urgency: 'emergency', reason: 'wires_down', summary: `Web chat: member reports a hazard — "${raw.slice(0, 160)}"` };
      return 'Please stay at least 35 feet away from it, keep everyone else away, and don’t touch anything the line is touching. If anyone is hurt or there is a fire, call 911 first. I’m bringing our outage team into this chat right now.';
    }

    if (offer === 'triage') {
      const whole = /\bpart|some\b/.test(t) ? 'partial' : 'yes';
      const r = await this.callTool('report-outage', s.id, { whole_house: whole, neighbors_out: /neighbo/.test(t) ? 'yes' : 'unknown', hazard: 'none', details: `Web chat: ${raw.slice(0, 200)}` });
      s.lastOffer = 'restoration';
      const ref = String(r.reference ?? '').replace(/\s/g, '');
      return `Thank you — I've reported the outage. Your reference number is ${ref}.${r.several_reports_in_area ? " We're seeing several reports from your area and a crew has been dispatched." : ''}${whole === 'partial' ? ' Since only part of the house is out, please check your main breaker — we’ll still check the service.' : ''} Would you like a text when your power is back on?`;
    }
    if (offer === 'restoration' && (yes || /\btext\b/.test(t))) {
      const r = await this.callTool('subscribe-restoration', s.id, { channel: 'sms' });
      if (!r.ok) return String(r.next_step ?? 'I could not sign you up just now.');
      return `Done — we'll text ${fmtPhone(String(r.phone).replace(/\s/g, ''))} when your power is restored, and if the estimate changes. Is there anything else I can help with?`;
    }
    if (offer === 'payment' && yes) return this.paymentLink(s);
    // "No, my bill" (a quick-reply chip) is a no AND a new request — only a bare no ends here.
    if (offer && no && !/\b(bill|pay|owe|balance|extension|more time|outage|power)\b/.test(t)) return 'No problem. Is there anything else I can help you with?';

    if (/\b(extension|extend|more time|pay later|can't pay|cannot pay)\b/.test(t)) {
      // Same co-op rule as the agent's billing assistant: a week past the cut-off (or due) date,
      // never in the past, in the billing system's MM/DD/YY format.
      const bill = await this.callTool('get-billing', s.id);
      const base = parseMdY(String(bill.cutoff_date ?? '')) ?? parseMdY(String(bill.due_date ?? '')) ?? new Date();
      const pay = new Date(Math.max(base.getTime(), Date.now()) + 7 * 86400_000);
      const payBy = `${String(pay.getMonth() + 1).padStart(2, '0')}/${String(pay.getDate()).padStart(2, '0')}/${String(pay.getFullYear()).slice(-2)}`;
      const r = await this.callTool('request-payment-extension', s.id, { pay_by_date: payBy });
      if (!r.approved) return 'An extension isn’t available on this account right now. I can send you a secure payment link, or connect you with a member services representative — which would you prefer?';
      return `You're all set — I've extended your due date to ${pay.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}. Confirmation number ${String(r.confirmation).replace(/\s/g, '')}. Your service won't be disconnected while the extension is in place.`;
    }
    if (/\b(pay|payment|pay my bill)\b/.test(t)) return this.paymentLink(s);
    if (/\b(bill|balance|owe|due|amount|high)\b/.test(t)) {
      const r = await this.callTool('get-billing', s.id);
      if (r.ok === false) return String(r.next_step ?? 'Billing details are unavailable right now.');
      s.lastOffer = 'payment';
      const past = Number(r.past_due) > 0 ? ` ${money(Number(r.past_due))} of that is past due${r.cutoff_date !== 'none' ? `, with a cut-off date of ${r.cutoff_date}` : ''}.` : '';
      const high = /\bhigh\b/.test(t) ? ` Your usage over the last 30 days was ${r.usage_last_30_days_kwh} kWh — ${r.usage_change_vs_last_year} from the same time last year.` : '';
      return `Your balance is ${money(Number(r.amount_due))}, due ${r.due_date}.${past}${high} Would you like to pay now? I can send a secure payment link right here in the chat.`;
    }
    if (/\b(out|outage|power|lights|electric|electricity|restor|crew)\b/.test(t) || (offer === 'outage_confirm' && yes)) {
      const r = await this.callTool('get-outage-status', s.id);
      if (r.known) {
        s.lastOffer = 'restoration';
        return `Yes, we know about it. It's affecting about ${r.members_affected} members in the ${r.area} area — ${r.cause}, and ${r.crew_status}. Our current estimate to have the power back on is ${r.estimated_restoration} (estimates can change). If you see any lines down, stay at least 35 feet away and tell me right away. Would you like a text when your power is back on?`;
      }
      s.lastOffer = 'triage';
      return "I don't see a reported outage at your address yet, so let's report it. Is the whole house out, or just part of it — and are your neighbors out too? (If you see any lines down, stay at least 35 feet away and tell me.)";
    }
    if (/\b(thank|thanks|bye|goodbye|that's all|that is all|all set)\b/.test(t)) {
      await this.callTool('wrap-up', s.id, { outcome: 'Web chat handled by the virtual assistant', tags: '' });
      return `You're welcome${s.name ? `, ${s.name.split(' ')[0]}` : ''}! Thanks for being a Horry Electric member. You can close this chat any time.`;
    }
    return 'I can help with outages, your bill, payments and payment extensions — or connect you with a member services representative. What would you like to do?';
  }

  private async paymentLink(s: ChatSession): Promise<string> {
    const bill = await this.callTool('get-billing', s.id);
    const amount = Number(bill.amount_due ?? 0);
    if (!(amount > 0)) return 'Your account has no balance due right now. Is there anything else I can help with?';
    const r = await this.callTool('send-payment-link', s.id, { amount });
    if (!r.ok) return String(r.next_step ?? 'I could not create a payment link just now.');
    return `Here's your secure payment link for ${money(amount)}. You'll enter your card on the secure page — I never see your card number. Let me know once you're done.`;
  }
}

const fmtPhone = (p: string) => (/^\d{10}$/.test(p) ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p);

/** Visitor-side escalation intent — checked on EVERY message so the hand-off works in both modes. */
const WANTS_HUMAN =
  /\b(agent|human|person|representative|rep|someone real|real person|live (chat|person|agent)|speak (to|with) (a|an|someone)|talk (to|with) (a|an|someone))\b/i;

/** Billing-system dates are MM/DD/YY. */
function parseMdY(s: string): Date | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
  return new Date(y, Number(m[1]) - 1, Number(m[2]), 12);
}

const DEPT_LABEL: Record<string, string> ={ outage: 'outage', billing: 'billing', member_services: 'member services' };

// ---------------------------------------------------------------------------------------

const IDLE_CLOSE_MS = 20 * 60_000;
const FORGET_CLOSED_MS = 4 * 60 * 60_000;

class ChatManager extends EventEmitter {
  private sessions = new Map<string, ChatSession>();
  private seq = 0;
  private real?: ChatTransport;
  private scripted: ChatTransport;

  constructor(private d: Deps, callTool: (name: string, guid: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>) {
    super();
    this.scripted = new ScriptedTransport(callTool);
    if (env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID) this.real = new ElevenLabsChatTransport(env.ELEVENLABS_API_KEY, env.ELEVENLABS_AGENT_ID);
    // Savannah's tools write to the chat's call row: pick up escalations and payment links.
    d.calls.on('change', () => {
      for (const s of this.sessions.values()) if (s.status !== 'closed') this.syncFromRow(s);
    });
    setInterval(() => {
      const now = Date.now();
      for (const [id, s] of this.sessions) {
        if (s.status !== 'closed' && now - Date.parse(s.lastAt) > IDLE_CLOSE_MS) this.close(id, 'timeout');
        else if (s.status === 'closed' && now - Date.parse(s.lastAt) > FORGET_CLOSED_MS) this.sessions.delete(id);
      }
    }, 60_000).unref();
  }

  get mode(): 'live' | 'scripted' {
    return this.real ? 'live' : 'scripted';
  }

  get(id: string): ChatSession | undefined {
    return this.sessions.get(id);
  }

  all(): ChatSession[] {
    return [...this.sessions.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  async start(name: string, contact: string): Promise<ChatSession> {
    const { calls, mode } = this.d;
    const digits = contact.replace(/\D/g, '');
    const m = await this.identify(digits);
    const id = `chat-${Date.now().toString(36)}-${(this.seq++).toString(36)}`;
    const now = new Date().toISOString();
    const session: ChatSession = {
      id,
      name: name.trim() || (m ? titleCase(displayName(m)) : ''),
      contact: digits,
      memberSep: m?.MemberSep,
      memberName: m ? displayName(m) : undefined,
      startedAt: now,
      lastAt: now,
      status: 'ai',
      messages: [],
      agentSeenSeq: 0,
      shownPayments: [],
    };
    this.sessions.set(id, session);

    const storm = mode.get().storm;
    const phone = digits.length === 10 ? digits : last10(m?.CellPhone);
    const row = calls.seed({ guid: id, ani: phone, dnis: 'webchat', channel: 'chat', stormMode: storm, memberSep: m?.MemberSep, memberName: m ? displayName(m) : undefined });
    if (m) calls.step(row, 'identified', `${displayName(m)} — ${displayAddress(m)} (web chat start form)`);

    const o = m ? this.d.outages.forMember(m) : undefined;
    const greeting = this.greeting(session, m, o);
    if (o) session.lastOffer = 'outage_confirm';
    else if (!m) session.lastOffer = 'identify';
    const onReply = (text: string) => this.aiReply(id, text);
    const onDead = () => this.transportDied(id);
    if (this.real) {
      try {
        await this.real.start(session, await this.vars(session, m, o, greeting), onReply, onDead);
      } catch (err) {
        console.warn(`HORRY CHAT ${id}: live assistant unavailable (${String(err)}) — scripted assistant takes the chat`);
        session.fellBack = true;
      }
    } else session.fellBack = true;
    if (session.fellBack) this.scripted.start(session, {}, onReply, onDead);
    this.push(session, 'assistant', greeting);
    console.log(`HORRY CHAT ${id}: started (${session.name || 'anonymous'}${m ? ` → ${displayName(m)}` : ', not identified'}) ${session.fellBack ? 'scripted' : 'live'}`);
    return session;
  }

  visitorMessage(id: string, text: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.status === 'closed') return false;
    this.push(s, 'visitor', text);
    if (s.status !== 'ai') return true; // waiting / with an agent: the agent sees it
    if (WANTS_HUMAN.test(text)) {
      this.push(s, 'assistant', 'Of course — I’m bringing a member of our team into this chat now.');
      this.escalate(s, this.guessDepartment(s), 'visitor asked for a person');
      return true;
    }
    this.transportFor(s).userMessage(s, text);
    return true;
  }

  /** Agent picks the chat up (also a barge-in on a chat still with Savannah). */
  accept(id: string, agentName: string, agentId = ''): ChatSession | undefined {
    const s = this.sessions.get(id);
    if (!s || s.status === 'closed') return undefined;
    if (s.status === 'agent' && s.agentName && s.agentName !== agentName) return s; // already owned
    if (s.status === 'ai') this.escalate(s, this.guessDepartment(s), `${agentName} joined the chat`);
    if (s.status !== 'agent') {
      s.status = 'agent';
      s.agentName = agentName || 'Member Services';
      s.agentId = agentId;
      this.d.calls.step(this.row(s), 'agent_joined', `${s.agentName} picked up the web chat`);
      this.push(s, 'system', `You're now connected to ${s.agentName}.`);
    }
    s.agentSeenSeq = s.messages.length;
    return s;
  }

  agentMessage(id: string, text: string, agentName: string, agentId = ''): 'ok' | 'closed' | 'not_yours' {
    const s = this.accept(id, agentName, agentId);
    if (!s) return 'closed';
    if (s.agentName && s.agentName !== agentName) return 'not_yours'; // another agent owns it
    this.push(s, 'agent', text, s.agentName);
    s.agentSeenSeq = s.messages.length;
    return 'ok';
  }

  /** "Reset demo data": drop every chat (in memory only) so no rehearsal chat waits on the badge. */
  reset(): void {
    for (const s of this.sessions.values()) this.transportFor(s).stop(s.id);
    this.sessions.clear();
  }

  markSeen(id: string): void {
    const s = this.sessions.get(id);
    if (s && s.status === 'agent') s.agentSeenSeq = s.messages.length;
  }

  close(id: string, by: 'visitor' | 'agent' | 'timeout'): boolean {
    const s = this.sessions.get(id);
    if (!s || s.status === 'closed') return false;
    const was = s.status;
    s.status = 'closed';
    s.closedBy = by;
    this.transportFor(s).stop(id);
    this.push(s, 'system', by === 'visitor' ? 'The member left the chat.' : by === 'agent' ? 'This chat has ended. Thanks for chatting with Horry Electric!' : 'This chat ended after a period of inactivity.');
    this.finishRow(s, was);
    return true;
  }

  // ---- internals -----------------------------------------------------------------------

  private async identify(digits: string): Promise<Member | undefined> {
    if (!digits) return undefined;
    const { members, nextgen } = this.d;
    if (digits.length === 11 || (digits.length > 10 && digits.startsWith('0'))) return members.bySep(digits);
    if (digits.length >= 10) {
      const p = digits.slice(-10);
      const hit = (await nextgen.accountsInfo(1, p).catch(() => []))[0];
      return (hit ? members.bySep(String(hit.MemberSep)) : undefined) ?? members.byPhone(p)[0];
    }
    return members.bySep(digits);
  }

  private greeting(s: ChatSession, m: Member | undefined, o: Outage | undefined): string {
    const open = `Hi${m ? ` ${m.FirstName}` : s.name ? ` ${s.name.split(' ')[0]}` : ''}! I'm ${ASSISTANT}, Horry Electric's virtual assistant.`;
    if (m && o) return `${open} I see your account at ${titleCase(displayAddress(m))}. Are you chatting about the power outage in the ${o.area.split(',')[0]} area?`;
    if (m) return `${open} I see your account at ${titleCase(displayAddress(m))}. How can I help you today?`;
    return `${open} What's the phone number or account number on your account, so I can pull it up?`;
  }

  /** Same variables as the phone path's dynamicVars(), plus the chat rules in call_playbook. */
  private async vars(s: ChatSession, m: Member | undefined, o: Outage | undefined, greeting: string): Promise<Record<string, string>> {
    const { mode, nextgen } = this.d;
    const tz = env.BUSINESS_TIMEZONE;
    const st = mode.get();
    const fin = m ? await nextgen.financial(m.MemberSep).catch(() => null) : null;
    const play: string[] = [
      'THIS IS A TEXT WEB CHAT on the co-op website, not a phone call. The member typed their name and phone or account number into the chat form.',
      'Keep replies to one or two short sentences. Write numbers normally (no spaces between digits). Never say "hold", "call" or "hang up".',
      'Payment links you send with send_payment_link also appear right here in the chat — tell them to use the link in the chat.',
      'To hand off: write ONE sentence saying you are bringing a member of our team into this chat, then call escalate. Do not call wrap_up or end_call unless the member says goodbye.',
      st.storm
        ? 'STORM MODE IS ON: a major outage event is in progress. Lead with the outage; do not bring up bills unless the member does.'
        : 'Normal operations: the member may be chatting about billing, payments, service requests or an outage.',
    ];
    if (m && o) play.push(`There IS a known outage at this member's location (${o.area}); confirm it is what they are chatting about.`);
    if (m && m.OnCutOffList && !st.storm) play.push(`This account is past due ${money(m.PastDueAmount)} and on the cut-off list for ${m.CutOffDate}. If they ask about billing, explain gently and offer a payment or an extension.`);
    return {
      assistant_name: ASSISTANT,
      first_message: greeting,
      call_playbook: play.join('\n'),
      broadcast_message: st.broadcast ? `ANNOUNCEMENT to mention once, early in the chat: ${st.broadcast}` : '',
      member_found: m ? 'true' : 'false',
      member_name: m ? displayName(m) : s.name || 'unknown',
      first_name: m?.FirstName ?? (s.name.split(' ')[0] || 'there'),
      service_address: m ? displayAddress(m) : 'unknown',
      account_number: m ? m.MemberSep : '',
      outage_known: o ? 'true' : 'false',
      outage_area: o?.area ?? '',
      outage_customers: o ? String(o.customers) : '0',
      outage_cause: o?.cause ?? '',
      outage_crew: o?.crew ?? '',
      outage_etr: o ? spokenEtr(o.etr, tz) : '',
      outage_id: o?.id ?? '',
      life_support: m && m.PrioritySvc > 0 ? 'true' : 'false',
      balance_due: fin ? money(fin.AmountDue) : '',
      due_date: fin?.DueDate ?? '',
      past_due: fin ? money(fin.PastDueAmount) : '$0.00',
      cutoff_date: fin?.CutOffDate ?? 'none',
      storm_mode: st.storm ? 'true' : 'false',
      current_date: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz }),
      // The tools' call_guid is bound to this variable: it routes every tool call to the
      // chat's own call row (a web chat has no SIP header to fill it).
      sip_call_guid: s.id,
    };
  }

  private aiReply(id: string, text: string): void {
    const s = this.sessions.get(id);
    // 'waiting' too: the sentence announcing a hand-off can land just after the escalate tool.
    if (!s || (s.status !== 'ai' && s.status !== 'waiting')) return;
    const clean = text.trim();
    const first = s.messages[0];
    if (!s.greetingEchoDropped && first?.role === 'assistant' && clean === first.text) {
      s.greetingEchoDropped = true; // the live agent opens with the greeting we already showed
      return;
    }
    if (clean) this.push(s, 'assistant', clean);
    this.syncFromRow(s);
  }

  private transportDied(id: string): void {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'ai' || s.fellBack) return;
    s.fellBack = true;
    console.warn(`HORRY CHAT ${id}: live assistant conversation ended — scripted assistant takes over`);
    this.scripted.start(s, {}, (t) => this.aiReply(id, t), () => undefined);
    const last = s.messages[s.messages.length - 1];
    if (last?.role === 'visitor') this.scripted.userMessage(s, last.text);
  }

  /** Mirror what Savannah's tools wrote to the chat's call row into the chat. */
  private syncFromRow(s: ChatSession): void {
    const row = this.d.calls.get(s.id);
    if (!row) return;
    if (row.memberSep && row.memberSep !== s.memberSep) {
      s.memberSep = row.memberSep;
      s.memberName = row.memberName;
    }
    if (row.paymentId && !s.shownPayments.includes(row.paymentId)) {
      const p = this.d.payments.get(row.paymentId);
      if (p && p.method === 'link') {
        s.shownPayments.push(p.id);
        this.push(s, 'system', `Secure payment link — ${money(p.amount)}`, undefined, { href: `pay.html?s=${p.id}`, label: `Pay ${money(p.amount)} securely` });
      }
    }
    if (row.escalation && s.status === 'ai') this.escalate(s, row.escalation.department, row.escalation.reason, true);
  }

  private escalate(s: ChatSession, department: string, reason: string, fromTool = false): void {
    if (s.status !== 'ai') return;
    s.status = 'waiting';
    s.escalation = { at: new Date().toISOString(), department, reason };
    // Let a live assistant finish the sentence it is sending alongside the escalate tool.
    const transport = this.transportFor(s);
    if (fromTool && transport === this.real) setTimeout(() => transport.stop(s.id), 5000).unref();
    else transport.stop(s.id);
    const row = this.row(s);
    if (!fromTool) {
      const summary = `Web chat: ${reason}. ${s.messages.filter((m) => m.role === 'visitor').map((m) => m.text).slice(-2).join(' / ')}`.slice(0, 240);
      this.d.calls.patch(row, { escalation: { department, urgency: 'normal', reason: reason.replace(/\s+/g, '_'), summary, at: s.escalation.at } });
      this.d.calls.step(row, 'escalated', `${department} / normal: ${reason}`, department === 'outage' ? 'outage_escalation' : 'escalation');
    }
    this.push(s, 'system', `Connecting you with our ${DEPT_LABEL[department] ?? 'member services'} team — a live agent will join this chat shortly.`);
    console.log(`HORRY CHAT ${s.id}: ESCALATED ${department} (${reason})`);
  }

  private guessDepartment(s: ChatSession): string {
    const row = this.d.calls.get(s.id);
    const tags = row?.tags ?? [];
    const text = s.messages.filter((m) => m.role === 'visitor').map((m) => m.text).join(' ').toLowerCase();
    if (tags.includes('outage_known') || tags.includes('outage_reported') || /\b(out|outage|power|lights)\b/.test(text)) return 'outage';
    if (tags.includes('billing_inquiry') || tags.includes('payment') || /\b(bill|pay|balance|owe)\b/.test(text)) return 'billing';
    return 'member_services';
  }

  /** On close: the AI transcript, outcome and (if a person joined) the live-agent leg. */
  private finishRow(s: ChatSession, was: ChatStatus): void {
    const { calls } = this.d;
    const row = this.row(s);
    const aiPart = s.messages.filter((m) => !s.escalation || m.at <= s.escalation.at);
    const transcript = aiPart
      .filter((m) => m.role === 'visitor' || m.role === 'assistant')
      .map((m) => ({ role: m.role === 'assistant' ? ('agent' as const) : ('user' as const), text: m.text }));
    const steps = row.journey.map((j) => j.step);
    const did = [
      steps.includes('outage_known') && 'confirmed the known outage',
      steps.includes('outage_reported') && 'reported an outage',
      steps.includes('subscribed') && 'signed up for restoration texts',
      steps.includes('billing') && 'gave the balance',
      steps.includes('payment_link') && 'sent a secure payment link',
      steps.includes('payment') && 'took a payment',
      steps.includes('extension') && 'granted a payment extension',
    ].filter(Boolean);
    const who = s.memberName ? titleCase(s.memberName) : s.name || 'A visitor';
    const summary = `Web chat — ${who}. ${ASSISTANT} ${did.length ? did.join(', ') : 'answered the member'}${s.escalation ? `; handed to a live agent (${DEPT_LABEL[s.escalation.department] ?? s.escalation.department}: ${s.escalation.reason})` : ''}.`;
    const end = new Date().toISOString();
    const patch: Partial<CallRow> = {
      transcript,
      summary,
      durationSec: Math.round((Date.parse(end) - Date.parse(s.startedAt)) / 1000),
      outcome: row.outcome || (s.escalation ? 'escalated to live agent' : 'handled by the virtual assistant'),
      sentiment: sentiment(s),
    };
    if (s.escalation && was === 'agent' && s.agentName) {
      const agentLines = s.messages.filter((m) => m.role === 'agent').length;
      const dept = s.escalation.department;
      patch.agentLeg = {
        agentName: s.agentName,
        team: dept === 'outage' ? 'Outage queue' : dept === 'billing' ? 'Billing & Collections' : 'Member Services',
        endedAt: end,
        wrapUpCode: `Web chat - ${dept === 'outage' ? 'Outage' : dept === 'billing' ? 'Billing' : 'General'}`,
        summary: {
          reason: s.escalation.reason.replace(/_/g, ' '),
          actions: `Picked up the web chat with the assistant's transcript and replied ${agentLines} time${agentLines === 1 ? '' : 's'}.`,
          status: s.closedBy === 'agent' ? 'Resolved' : 'Member left the chat',
          followUp: 'None.',
        },
        source: 'posted',
      };
    } else if (s.escalation) {
      // Handed off but nobody picked it up: record that, or the summaries ticker would invent a
      // live-agent leg (or poll Cisco for 24 h with a chat id).
      patch.agentLeg = {
        agentName: '',
        team: '',
        endedAt: end,
        wrapUpCode: 'Web chat - Abandoned',
        summary: { reason: s.escalation.reason.replace(/_/g, ' '), actions: 'No agent joined.', status: 'Member left before an agent joined', followUp: 'Follow up with the member.' },
        source: 'posted',
      };
    }
    // agentLeg BEFORE endedAt: the summaries ticker only simulates legs for ended rows without one.
    calls.patch(row, patch);
    calls.patch(row, { endedAt: end });
  }

  private row(s: ChatSession): CallRow {
    return this.d.calls.get(s.id) ?? this.d.calls.seed({ guid: s.id, ani: '', dnis: 'webchat', channel: 'chat', stormMode: this.d.mode.get().storm });
  }

  private transportFor(s: ChatSession): ChatTransport {
    return s.fellBack || !this.real ? this.scripted : this.real;
  }

  private push(s: ChatSession, role: ChatMessage['role'], text: string, by?: string, link?: ChatMessage['link']): void {
    const now = new Date().toISOString();
    s.messages.push({ seq: s.messages.length + 1, at: now, role, text, ...(by ? { by } : {}), ...(link ? { link } : {}) });
    s.lastAt = now;
    this.emit('change', s);
  }
}

function sentiment(s: ChatSession): 'positive' | 'neutral' | 'negative' {
  const t = s.messages.filter((m) => m.role === 'visitor').map((m) => m.text.toLowerCase()).join(' ');
  const neg = (t.match(/\b(ridiculous|angry|again|unacceptable|frustrat|terrible|still out|hours)\b/g) ?? []).length;
  const pos = (t.match(/\b(thank|great|perfect|appreciate|awesome|wonderful)\b/g) ?? []).length;
  return neg > pos ? 'negative' : pos > 0 ? 'positive' : 'neutral';
}

/** Quick replies for the visitor, from Savannah's last line (hidden once a person has the chat). */
function suggestionsFor(s: ChatSession): string[] {
  if (s.status !== 'ai') return [];
  const last = s.messages[s.messages.length - 1];
  if (!last || last.role !== 'assistant') return [];
  const t = last.text.toLowerCase();
  if (/chatting about the power outage/.test(t)) return ['Yes, the outage', 'No, my bill', 'Talk to a person'];
  if (/text when your power is back/.test(t)) return ['Yes, text me', 'No thanks'];
  if (/would you like to pay now/.test(t)) return ['Yes, send the link', 'Not now', 'I need more time'];
  if (/whole house out/.test(t)) return ['The whole house', 'Just part of it'];
  if (/how can i help|anything else|what would you like/.test(t)) return ['Is my power out?', 'What do I owe?', 'Pay my bill', 'Talk to a person'];
  return [];
}

// ---------------------------------------------------------------------------------------
// HTTP surface (all relative-safe behind /horry/).

export function registerChat(f: FastifyInstance, d: Deps): void {
  // The scripted assistant runs the SAME tool handlers the live agent does.
  const callTool = async (name: string, guid: string, body: Record<string, unknown> = {}) => {
    const res = await f.inject({
      method: 'POST',
      url: `/api/tools/${name}`,
      headers: { 'content-type': 'application/json', ...(env.TOOL_SHARED_SECRET ? { 'x-tool-secret': env.TOOL_SHARED_SECRET } : {}) },
      payload: JSON.stringify({ call_guid: guid, caller_id: '', ...body }),
    });
    const out = res.json() as Record<string, unknown>;
    if (name === 'lookup-member' && out.found) out.account_number = d.calls.get(guid)?.memberSep ?? '';
    return out;
  };
  const chat = new ChatManager(d, callTool);

  const visitorView = (s: ChatSession, after = 0) => ({
    id: s.id,
    status: s.status,
    mode: s.status === 'agent' ? 'agent' : 'assistant',
    closed: s.status === 'closed',
    agentName: s.agentName ?? '',
    messages: s.messages.filter((m) => m.seq > after),
    suggestions: suggestionsFor(s),
  });
  const listView = (s: ChatSession) => {
    const lastVisitor = [...s.messages].reverse().find((m) => m.role === 'visitor');
    const last = s.messages[s.messages.length - 1];
    return {
      id: s.id,
      name: s.name,
      memberName: s.memberName ? titleCase(s.memberName) : '',
      memberSep: s.memberSep ?? '',
      status: s.status,
      startedAt: s.startedAt,
      lastAt: s.lastAt,
      agentName: s.agentName ?? '',
      department: s.escalation?.department ?? '',
      reason: s.escalation?.reason ?? '',
      waitingSince: s.status === 'waiting' ? s.escalation?.at ?? '' : '',
      unread: s.status === 'agent' ? s.messages.slice(s.agentSeenSeq).filter((m) => m.role === 'visitor').length : 0,
      lastText: last ? `${last.role === 'assistant' ? `${ASSISTANT}: ` : last.role === 'agent' ? `${last.by ?? 'Agent'}: ` : ''}${last.text}`.slice(0, 120) : '',
      lastVisitorAt: lastVisitor?.at ?? '',
    };
  };

  // ---- visitor (site.html bubble) ----
  f.post('/api/chat/start', async (req) => {
    const b = (req.body ?? {}) as { name?: string; contact?: string; phone?: string; account?: string };
    const s = await chat.start(String(b.name ?? '').slice(0, 80), String(b.contact ?? b.account ?? b.phone ?? '').slice(0, 30));
    return { ok: true, ...visitorView(s) };
  });
  f.post('/api/chat/:id/message', async (req, reply) => {
    const { id } = req.params as { id: string };
    const text = String(((req.body ?? {}) as { text?: string }).text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'text required' });
    if (!chat.visitorMessage(id, text.slice(0, 1000))) return reply.code(404).send({ error: 'chat not found or closed' });
    return { ok: true };
  });
  f.get('/api/chat/:id', async (req, reply) => {
    const s = chat.get((req.params as { id: string }).id);
    if (!s) return reply.code(404).send({ error: 'unknown chat' });
    return visitorView(s, Number((req.query as { after?: string }).after) || 0);
  });
  f.post('/api/chat/:id/close', async (req) => {
    const { id } = req.params as { id: string };
    const by = String(((req.body ?? {}) as { by?: string }).by ?? 'visitor');
    return { ok: chat.close(id, by === 'agent' ? 'agent' : 'visitor') };
  });

  // ---- agent (<horry-chat> / <horry-chat-badge>) ----
  f.get('/api/chats', async () => {
    const all = chat.all();
    return {
      assistant: chat.mode,
      waiting: all.filter((s) => s.status === 'waiting').length,
      active: all.filter((s) => s.status === 'agent').length,
      withAssistant: all.filter((s) => s.status === 'ai').length,
      unread: all.reduce((n, s) => n + (s.status === 'agent' ? s.messages.slice(s.agentSeenSeq).filter((m) => m.role === 'visitor').length : 0), 0),
      chats: all.slice(0, 40).map(listView),
    };
  });
  f.get('/api/chats/:id', async (req, reply) => {
    const s = chat.get((req.params as { id: string }).id);
    if (!s) return reply.code(404).send({ error: 'unknown chat' });
    if ((req.query as { seen?: string }).seen === '1') chat.markSeen(s.id);
    return { ...listView(s), contact: s.contact, escalation: s.escalation ?? null, messages: s.messages, journey: d.calls.get(s.id)?.journey ?? [] };
  });
  f.post('/api/chats/:id/accept', async (req, reply) => {
    const b = (req.body ?? {}) as { agentName?: string; agentId?: string };
    const s = chat.accept((req.params as { id: string }).id, String(b.agentName ?? '').trim() || 'Member Services', String(b.agentId ?? ''));
    if (!s) return reply.code(404).send({ error: 'chat not found or closed' });
    if (s.agentName && b.agentName && s.agentName !== b.agentName) return reply.code(409).send({ error: `${s.agentName} already has this chat` });
    return { ok: true, status: s.status, agentName: s.agentName };
  });
  f.post('/api/chats/:id/message', async (req, reply) => {
    const b = (req.body ?? {}) as { text?: string; agentName?: string; agentId?: string };
    const text = String(b.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'text required' });
    const r = chat.agentMessage((req.params as { id: string }).id, text.slice(0, 2000), String(b.agentName ?? '').trim() || 'Member Services', String(b.agentId ?? ''));
    if (r === 'closed') return reply.code(410).send({ error: 'this chat has ended' });
    if (r === 'not_yours') return reply.code(409).send({ error: 'another agent has this chat' });
    return { ok: true };
  });

  // The console's "Reset demo data" (POST api/reset in routes.ts) clears web chats too.
  f.addHook('onResponse', async (req, res) => {
    if (req.method === 'POST' && req.routeOptions.url === '/api/reset' && res.statusCode < 300) chat.reset();
  });
  f.post('/api/chats/:id/close', async (req) => ({ ok: chat.close((req.params as { id: string }).id, 'agent') }));

  console.log(`HORRY web chat: assistant ${chat.mode === 'live' ? 'LIVE (text conversation)' : 'scripted (offline)'}`);
}
