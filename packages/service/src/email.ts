// Email ticketing (discovery item 6: replace the shared distribution group). Member emails
// become cards on a board (<horry-email>): topic, member account, how long it has waited.
// Agents pick an email (or a supervisor assigns one), the service drafts a reply from the
// member's real account data (deterministic templates, no outside AI call), the agent edits
// and sends. On storm days emails group by outage so one reply answers everyone in it.
// Pick semantics follow the home-services / Crete pick board (claim, 409 when someone else
// holds it, release, supervisor assign labelled "assigned by").
//
// Seed: data/emails.seed.json (minutesAgo offsets → ages look live). State persists to
// data/emails.json (gitignored); a snapshot older than 12 h is re-seeded on start so a
// demo never opens with day-old emails. POST api/reset (the console's "Reset demo data")
// also re-seeds via the onResponse hook below; POST api/emails/reset does it alone.
// Outbound mail is SIMULATED — the reply is logged on the email and as an account note.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { env } from './env.js';
import { JsonStore } from './store.js';
import type { MemberStore, Member } from './members.js';
import { displayName, displayAddress } from './members.js';
import type { NextGenClient } from './nextgen.js';
import type { OutageStore, Outage } from './outages.js';
import { spokenEtr } from './outages.js';

export type EmailTopic = 'outage' | 'billing' | 'payment' | 'arrangement' | 'start_stop' | 'budget' | 'trees' | 'general';
export type EmailStatus = 'new' | 'picked' | 'sent';

export const TOPIC_LABEL: Record<EmailTopic, string> = {
  outage: 'Outage',
  billing: 'High bill',
  payment: 'Payment',
  arrangement: 'Payment arrangement',
  start_stop: 'Start / stop service',
  budget: 'Budget billing',
  trees: 'Tree trimming',
  general: 'General',
};

interface SeedEmail {
  id: string;
  from: string;
  fromName: string;
  subject: string;
  body: string;
  topic: EmailTopic;
  minutesAgo: number;
  outageHint?: { substation: number; circuit: number | null };
  facts?: Record<string, string>;
}

export interface Email {
  id: string;
  from: string;
  fromName: string;
  subject: string;
  body: string;
  topic: EmailTopic;
  receivedAt: string;
  memberSep: string | null;
  matchedBy: 'email' | 'account_number' | null;
  outageHint?: { substation: number; circuit: number | null };
  facts?: Record<string, string>;
  status: EmailStatus;
  agent: string; // who holds it (picked/assigned) or sent it
  assignedBy: string; // set only when a supervisor assigned the CURRENT holder
  pickedAt?: string;
  draft?: string; // last AI draft / agent edit saved with it
  reply?: { subject: string; text: string; to: string; sentAt: string; by: string; bulkOutageId?: string; delivery: 'simulated' };
  history: { at: string; by: string; what: string }[];
}

interface State {
  seededAt: string;
  seq: number;
  emails: Email[];
}

const DEFAULT_AGENTS = 'Ashley Floyd,Brandon Hucks,Tonya Lewis';
const RESEED_AFTER_MS = 12 * 3600_000;
const money = (n: number | null | undefined) => `$${(n ?? 0).toFixed(2)}`;
const firstName = (m: Member | undefined, e: Email) => (m ? m.FirstName.charAt(0) + m.FirstName.slice(1).toLowerCase() : e.fromName.split(/\s+/)[0] || 'there');
const mmddyy = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`;
const SIGN = (agent: string) => `\n\n${agent || 'Member Services'}\nHorry Electric Cooperative\n843-369-2211 · horryelectric.com`;

export class EmailStore {
  private s: State;
  private store: JsonStore<State>;
  private seeds: SeedEmail[];
  /** Agents seen polling the board (for the supervisor's assign list). name → last seen ms */
  private seen = new Map<string, number>();

  constructor(
    dataDir: string,
    private readonly members: MemberStore,
  ) {
    this.seeds = (JSON.parse(readFileSync(join(dataDir, 'emails.seed.json'), 'utf8')) as { emails: SeedEmail[] }).emails;
    this.store = new JsonStore<State>(join(dataDir, 'emails.json'));
    const loaded = this.store.load();
    this.s = loaded && Date.now() - Date.parse(loaded.seededAt) < RESEED_AFTER_MS ? loaded : this.seed();
    if (this.s !== loaded) this.store.save(this.s);
  }

  private seed(): State {
    const now = Date.now();
    return {
      seededAt: new Date(now).toISOString(),
      seq: 1100,
      emails: this.seeds.map((x) => {
        const { minutesAgo, ...rest } = x;
        const e: Email = {
          ...rest,
          receivedAt: new Date(now - minutesAgo * 60_000).toISOString(),
          memberSep: null,
          matchedBy: null,
          status: 'new',
          agent: '',
          assignedBy: '',
          history: [],
        };
        this.match(e);
        return e;
      }),
    };
  }

  /** From address first, then an 11-digit account number written in the email. */
  private match(e: Email): void {
    const byMail = this.members.byEmail(e.from)[0];
    if (byMail) {
      e.memberSep = byMail.MemberSep;
      e.matchedBy = 'email';
      return;
    }
    for (const n of e.body.match(/\b\d{11}\b/g) ?? []) {
      const m = this.members.bySep(n);
      if (m) {
        e.memberSep = m.MemberSep;
        e.matchedBy = 'account_number';
        return;
      }
    }
  }

  reset(): void {
    this.s = this.seed();
    this.store.save(this.s);
  }

  all(): Email[] {
    return [...this.s.emails].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  get(id: string): Email | undefined {
    return this.s.emails.find((e) => e.id === id);
  }

  touchAgent(name: string): void {
    if (name) this.seen.set(name, Date.now());
  }

  seenAgents(): string[] {
    const cutoff = Date.now() - 10 * 60_000;
    return [...this.seen.entries()].filter(([, t]) => t > cutoff).map(([n]) => n);
  }

  private log(e: Email, by: string, what: string): void {
    e.history.push({ at: new Date().toISOString(), by, what });
    this.store.save(this.s);
  }

  /** Claim an email. false = someone else holds it, or it is already answered. */
  pick(e: Email, agent: string): boolean {
    if (e.status === 'sent') return false;
    if (e.status === 'picked' && e.agent.toLowerCase() !== agent.toLowerCase()) return false;
    e.status = 'picked';
    e.agent = agent;
    e.assignedBy = '';
    e.pickedAt = new Date().toISOString();
    this.log(e, agent, 'picked');
    return true;
  }

  /** Supervisor override: works on new or picked emails (re-assigns away from the holder). */
  assign(e: Email, agent: string, by: string): boolean {
    if (e.status === 'sent') return false;
    const prev = e.status === 'picked' ? e.agent : '';
    e.status = 'picked';
    e.agent = agent;
    e.assignedBy = by;
    e.pickedAt = new Date().toISOString();
    this.log(e, by, `assigned to ${agent}${prev && prev !== agent ? ` (was ${prev})` : ''}`);
    return true;
  }

  release(e: Email, agent: string): boolean {
    if (e.status !== 'picked') return false;
    const prev = e.agent;
    e.status = 'new';
    e.agent = '';
    e.assignedBy = '';
    e.pickedAt = undefined;
    this.log(e, agent || prev, 'released back to the board');
    return true;
  }

  saveDraft(e: Email, text: string): void {
    e.draft = text;
    this.store.save(this.s);
  }

  markSent(e: Email, reply: NonNullable<Email['reply']>): void {
    e.status = 'sent';
    e.agent = reply.by;
    e.reply = reply;
    e.draft = reply.text;
    this.log(e, reply.by, reply.bulkOutageId ? `answered with the ${reply.bulkOutageId} group reply` : 'reply sent');
  }
}

export interface EmailDeps {
  dataDir: string;
  members: MemberStore;
  nextgen: NextGenClient;
  outages: OutageStore;
}

export function registerEmail(f: FastifyInstance, d: EmailDeps): EmailStore {
  const { members, nextgen, outages } = d;
  const tz = env.BUSINESS_TIMEZONE;
  const store = new EmailStore(d.dataDir, members);

  const memberOf = (e: Email) => (e.memberSep ? members.bySep(e.memberSep) : undefined);

  /** Outage emails only: the member's active outage, else the one at the sender's stated feeder. */
  function outageOf(e: Email): Outage | undefined {
    if (e.topic !== 'outage') return undefined;
    const m = memberOf(e);
    if (m) return outages.forMember(m);
    const h = e.outageHint;
    if (!h) return undefined;
    const act = outages.active();
    return act.find((o) => !o.location && o.substation === h.substation && o.circuit === h.circuit) ?? act.find((o) => !o.location && o.substation === h.substation && o.circuit === null);
  }

  const outageDto = (o: Outage) => ({ id: o.id, area: o.area, customers: o.customers, cause: o.cause, crew: o.crew, etr: o.etr, etrText: spokenEtr(o.etr, tz), startedAt: o.startedAt });

  function card(e: Email) {
    const m = memberOf(e);
    const o = outageOf(e);
    return {
      id: e.id,
      from: e.from,
      fromName: m ? displayName(m) : e.fromName,
      subject: e.subject,
      preview: e.body.replace(/\s+/g, ' ').slice(0, 140),
      topic: e.topic,
      topicLabel: TOPIC_LABEL[e.topic],
      receivedAt: e.receivedAt,
      waitingMin: Math.max(0, Math.round(((e.reply ? Date.parse(e.reply.sentAt) : Date.now()) - Date.parse(e.receivedAt)) / 60_000)),
      status: e.status,
      agent: e.agent,
      assignedBy: e.assignedBy,
      member: m ? { memberSep: m.MemberSep, name: displayName(m), address: displayAddress(m), lifeSupport: m.PrioritySvc > 0, pastDue: m.PastDueAmount } : null,
      matchedBy: e.matchedBy,
      outageId: o?.id ?? '',
      outageArea: o?.area ?? '',
      sentAt: e.reply?.sentAt ?? '',
      bulk: Boolean(e.reply?.bulkOutageId),
    };
  }

  function groups() {
    const byOutage = new Map<string, { outage: Outage; emails: Email[] }>();
    for (const e of store.all()) {
      const o = outageOf(e);
      if (!o) continue;
      const g = byOutage.get(o.id) ?? { outage: o, emails: [] };
      g.emails.push(e);
      byOutage.set(o.id, g);
    }
    return [...byOutage.values()]
      .map(({ outage, emails }) => ({
        outage: outageDto(outage),
        open: emails.filter((e) => e.status !== 'sent').length,
        sent: emails.filter((e) => e.status === 'sent').length,
        emailIds: emails.map((e) => e.id),
        senders: emails.filter((e) => e.status !== 'sent').map((e) => card(e).fromName),
        lifeSupport: emails.some((e) => e.status !== 'sent' && (memberOf(e)?.PrioritySvc ?? 0) > 0),
      }))
      .sort((a, b) => b.open - a.open);
  }

  async function accountSummary(m: Member) {
    const fin = await nextgen.financial(m.MemberSep).catch(() => null);
    const kwh = m.KwhLast30;
    const kwhLy = m.KwhSameMonthLastYear;
    const budget = fin?.BudgetOrLevelizedBillAmount ?? fin?.LevelizedBillAmount ?? m.LevelizedBillAmount;
    return {
      memberSep: m.MemberSep,
      name: displayName(m),
      firstName: firstName(m, { fromName: '' } as Email),
      address: displayAddress(m),
      phone: m.CellPhone ?? m.Telephone,
      email: m.EmailAddr,
      status: fin?.AccountStatus ?? m.AcctStatus,
      rate: m.Rate,
      lifeSupport: m.PrioritySvc > 0,
      amountDue: fin?.AmountDue ?? m.AmountDue,
      dueDate: fin?.DueDate ?? m.DueDate,
      pastDue: fin?.PastDueAmount ?? m.PastDueAmount,
      cutOffDate: fin?.CutOffDate ?? m.CutOffDate,
      lastPayment: fin?.LastPayment ?? m.LastPayment,
      paymentDate: fin?.PaymentDate ?? m.PaymentDate,
      billDate: fin?.BillDate ?? m.BillDate,
      budgetAmount: budget && budget > 0 ? budget : 0,
      bankDraft: fin?.ChkProfileExists ?? m.BankDraft,
      cardOnFile: (fin?.CardProfileExists ?? m.CardProfileExists) ? `card ending ${fin?.Last4CcDigits ?? m.Last4CcDigits}` : '',
      extensionAllowed: fin?.AllowArrangementFlag ?? m.AllowArrangementFlag,
      kwhLast30: kwh,
      kwhSameMonthLastYear: kwhLy,
      usageChangePct: kwhLy ? Math.round(((kwh - kwhLy) / kwhLy) * 100) : 0,
      recentNotes: (m.Notes ?? []).slice(-3).reverse(),
    };
  }
  type Account = Awaited<ReturnType<typeof accountSummary>>;

  /** Deterministic "AI draft" from the member's account + the topic. Never asks for card numbers. */
  function draftFor(e: Email, a: Account | null, o: Outage | undefined, agent: string): { subject: string; text: string; basis: string[] } {
    const hi = `Hi ${a?.firstName ?? firstName(undefined, e)},\n\n`;
    const subject = `Re: ${e.subject}`;
    const basis: string[] = [];
    const sign = SIGN(agent);
    const noAccount =
      'I couldn\'t match this email address to an account. Could you reply with the account number from your bill (or the service address and the phone number on the account)? Please don\'t include any card or bank numbers in email.';
    let body: string;
    switch (e.topic) {
      case 'outage': {
        if (o) {
          basis.push(`Outage ${o.id}: ${o.area}, ${o.customers} members, ETR ${spokenEtr(o.etr, tz)}`);
          body =
            `Thank you for letting us know, and I'm sorry you're without power. ${a ? `Your home at ${a.address} is` : 'Your area is'} part of an outage in ${o.area} affecting about ${o.customers.toLocaleString('en-US')} members. ` +
            `The cause is ${o.cause}, ${o.crew}, and our current estimate for restoration is ${spokenEtr(o.etr, tz)}. You don't need to report it again; we'll update you if that estimate changes.`;
          if (a?.lifeSupport) {
            basis.push('Account is flagged for medical / life-support priority');
            body += `\n\nYour account is on our medical priority list, and I've flagged your home to the outage desk because of the medical equipment there. If your backup supply runs low before power is restored, please don't wait: call 911 or go somewhere with power, and call us at 843-369-2211 so we can help.`;
          }
          body += `\n\nPlease stay clear of any downed lines and report them by phone right away.`;
        } else {
          basis.push(a ? `No active outage at ${a.address}` : 'No account match and no outage at the stated location');
          body = a
            ? `Thank you for reporting this. We don't show a known outage at ${a.address} right now, so I've logged your report and a crew will check the service to your home. If your neighbors have power, please check your main breaker first.`
            : `Thank you for reporting this. ${noAccount} Then I can confirm whether your home is in a known outage.`;
        }
        break;
      }
      case 'payment':
        if (!a) { body = noAccount; break; }
        basis.push(`Last payment ${money(a.lastPayment)} on ${a.paymentDate}`, `Amount due ${money(a.amountDue)} by ${a.dueDate}`);
        body =
          `Thanks for checking. Your payment of ${money(a.lastPayment)} posted to your account on ${a.paymentDate}, so there's no late fee. ` +
          (a.pastDue > 0
            ? `Your account still shows ${money(a.pastDue)} past due; you can pay it securely at horryelectric.com or by phone.`
            : `Your account is current. Your next bill${a.amountDue > 0 ? ` of ${money(a.amountDue)}` : ''} is due ${a.dueDate}${a.bankDraft ? ' and will be drafted automatically' : ''}.`);
        break;
      case 'billing': {
        if (!a) { body = noAccount; break; }
        const up = a.usageChangePct >= 0;
        basis.push(`Usage last 30 days ${a.kwhLast30} kWh vs ${a.kwhSameMonthLastYear} kWh same period last year (${up ? '+' : ''}${a.usageChangePct}%)`, `Amount due ${money(a.amountDue)} by ${a.dueDate}`);
        body =
          `I looked at your account. Your bill of ${money(a.amountDue)} is due ${a.dueDate}. Over the last 30 days your home used ${a.kwhLast30.toLocaleString('en-US')} kWh, ` +
          `compared with ${a.kwhSameMonthLastYear.toLocaleString('en-US')} kWh for the same period last year, ${up ? 'up' : 'down'} about ${Math.abs(a.usageChangePct)} percent. ` +
          (up && a.usageChangePct >= 20
            ? `Your meter readings look normal, so the increase is in usage. The usual causes are heating or a heat pump running on emergency heat, a well pump or water heater, or a new appliance. We offer a free home energy check, and I'd be happy to schedule one.`
            : `That's in line with last year, so your meter appears to be working normally.`) +
          (a.budgetAmount ? '' : `\n\nIf you'd like the same payment each month, budget billing spreads your costs evenly across the year. Just reply and I can set it up.`);
        break;
      }
      case 'arrangement': {
        if (!a) { body = noAccount; break; }
        // Extension runs a week past the cut-off date (or a week from today when there is none).
        const [mm, dd, yy] = (a.cutOffDate ?? '').split('/').map(Number);
        const cut = mm && dd && yy ? new Date(2000 + yy, mm - 1, dd) : null;
        const payBy = new Date(Math.max(cut ? cut.getTime() : 0, Date.now()) + 7 * 86400_000);
        basis.push(`Past due ${money(a.pastDue)}${a.cutOffDate ? `, cut-off date ${a.cutOffDate}` : ''}`, `Extension allowed: ${a.extensionAllowed ? 'yes' : 'no'}`);
        body =
          a.pastDue <= 0
            ? `Good news: your account isn't past due. Your bill of ${money(a.amountDue)} is due ${a.dueDate}.`
            : a.extensionAllowed
              ? `I can help. Your account shows ${money(a.pastDue)} past due${a.cutOffDate ? ` with a cut-off date of ${a.cutOffDate}` : ''}. Your account qualifies for a payment extension until ${mmddyy(payBy)}. Reply "yes" and I'll put it on your account; as long as the past-due amount is paid by then, your service stays on. ` +
                `You can pay securely at horryelectric.com or by phone. Please don't send card or bank numbers by email.`
              : `Your account shows ${money(a.pastDue)} past due${a.cutOffDate ? ` with a cut-off date of ${a.cutOffDate}` : ''}. I wasn't able to add an extension online, so please call us at 843-369-2211 and we'll work out an arrangement with you. We also have assistance agencies we can refer you to.`;
        break;
      }
      case 'budget': {
        if (!a) { body = noAccount; break; }
        const est = Math.round(((a.kwhLast30 + a.kwhSameMonthLastYear) / 2) * 0.118 + 32);
        basis.push(a.budgetAmount ? `Already on budget billing at ${money(a.budgetAmount)}` : `Estimated budget amount ~$${est} from usage`);
        body = a.budgetAmount
          ? `You're already on budget billing at ${money(a.budgetAmount)} a month. We review the amount every year and will let you know before it changes.`
          : `Budget billing gives you the same bill each month, based on your average use over the past year, and we review it once a year. Based on your usage, your monthly amount would be about $${est}. ` +
            `${a.pastDue > 0 ? 'Your account needs to be current to enroll. ' : ''}Reply "yes" and I'll enroll you starting with your next bill.`;
        break;
      }
      case 'trees':
        basis.push(a ? `Service address ${a.address}` : 'No account match');
        body =
          `Thank you for the heads-up. I've opened a right-of-way request for the tree ${a ? `at ${a.address}` : 'you described'}, and our forestry team will look at it within 10 business days. ` +
          `Please don't try to trim limbs near the line yourself. If a limb is on the line and sparking, or the line comes down, call us right away at 843-369-2211.`;
        break;
      case 'start_stop': {
        const when = e.facts?.moveDate ?? 'the date you gave';
        const to = e.facts?.newAddress;
        if (a) {
          basis.push(`Current service ${a.address}`, `Bank draft: ${a.bankDraft ? 'yes' : 'no'}`);
          body =
            `Congratulations on the move. I've scheduled your service at ${a.address} to stop on ${when}${to ? ` and service at ${to} to start the same day` : ''}, so there's no gap. ` +
            `Your final bill for the old address will come to this email${a.bankDraft ? ' and be drafted as usual' : ''}. ${to ? 'If anyone else will be on the account at the new home, just reply with their name.' : 'Please reply with your new mailing address for the final bill.'}`;
        } else {
          basis.push('New member: no existing account');
          body =
            `Welcome to Horry Electric Cooperative! I'd be glad to get service started${to ? ` at ${to}` : ''} by ${when}. To set up your membership I'll need the full name of each person on the account, a phone number, and a copy of a photo ID. ` +
            `You can finish the application securely at horryelectric.com under Start Service, or reply with a good time to call. There's a one-time membership fee, and a deposit may apply.`;
        }
        break;
      }
      default:
        basis.push(a ? `Account ${a.memberSep}` : 'No account match');
        body = a ? `Thank you for your email. I've looked at your account at ${a.address}, and ` : noAccount;
    }
    return { subject, text: hi + body + sign, basis };
  }

  /** The storm-day group reply: one text for everyone in the outage; {first_name} filled per member. */
  function groupDraft(o: Outage, agent: string): string {
    return (
      `Hi {first_name},\n\nThank you for reporting the outage, and I'm sorry you're without power. Your home is part of an outage in ${o.area} affecting about ${o.customers.toLocaleString('en-US')} members. ` +
      `The cause is ${o.cause}, ${o.crew}, and our current estimate for restoration is ${spokenEtr(o.etr, tz)}. There's no need to report it again; we'll update you if that estimate changes.` +
      `\n\nPlease stay clear of any downed lines and report them by phone right away. If anyone at home depends on medical equipment, call us at 843-369-2211.` +
      SIGN(agent)
    );
  }

  async function send(e: Email, text: string, by: string, subject?: string, bulkOutageId?: string) {
    const m = memberOf(e);
    const reply = {
      subject: subject || `Re: ${e.subject}`,
      text: text.replace(/\{first_name\}/g, firstName(m, e)),
      to: e.from,
      sentAt: new Date().toISOString(),
      by,
      ...(bulkOutageId ? { bulkOutageId } : {}),
      delivery: 'simulated' as const,
    };
    store.markSent(e, reply);
    let noted = false;
    if (m) {
      noted = await nextgen
        .addNote(m.MemberSep, `Email ${e.id} answered by ${by}${bulkOutageId ? ` (outage ${bulkOutageId} group reply)` : ''}: "${e.subject}". Reply: ${reply.text.replace(/\s+/g, ' ').slice(0, 220)}`, 'AN')
        .then(() => true)
        .catch(() => false);
    }
    console.log(`HORRY EMAIL ${e.id}: reply sent by ${by} to ${e.from}${bulkOutageId ? ` (group ${bulkOutageId})` : ''} — simulated outbound${m ? `, note ${noted ? 'logged' : 'FAILED'} on ${m.MemberSep}` : ''}`);
    return { reply, accountNote: m ? (noted ? 'logged' : 'failed') : 'no_account' };
  }

  const who = (b: Record<string, unknown>, k = 'agent') => String(b[k] ?? '').trim();
  const bodyOf = (req: { body?: unknown }) => (req.body ?? {}) as Record<string, unknown>;
  const find = (id: string) => store.get(id);

  // ---- routes (relative-safe: pages call `api/emails...`) -------------------------------

  f.get('/api/emails', async (req) => {
    const q = req.query as Record<string, string>;
    if (q.agent) store.touchAgent(q.agent);
    let list = store.all();
    if (q.status) list = list.filter((e) => (q.status === 'open' ? e.status !== 'sent' : e.status === q.status));
    if (q.topic) list = list.filter((e) => e.topic === q.topic);
    if (q.mine && q.agent) list = list.filter((e) => e.agent.toLowerCase() === q.agent!.toLowerCase());
    const sent = list.filter((e) => e.status === 'sent').sort((a, b) => (b.reply?.sentAt ?? '').localeCompare(a.reply?.sentAt ?? ''));
    const ordered = [...list.filter((e) => e.status !== 'sent'), ...sent];
    const all = store.all();
    return {
      emails: ordered.map(card),
      counts: {
        new: all.filter((e) => e.status === 'new').length,
        picked: all.filter((e) => e.status === 'picked').length,
        sent: all.filter((e) => e.status === 'sent').length,
      },
      topics: TOPIC_LABEL,
      ...(q.group === 'outage' ? { groups: groups() } : {}),
    };
  });

  f.get('/api/emails/groups', async () => ({ groups: groups() }));

  f.get('/api/emails/agents', async () => {
    // Optional EMAIL_AGENTS="Name One,Name Two" in .env; otherwise a small fictional roster.
    const fixed = (process.env.EMAIL_AGENTS || DEFAULT_AGENTS).split(',').map((s) => s.trim()).filter(Boolean);
    const holders = store.all().map((e) => e.agent).filter(Boolean);
    return { agents: [...new Set([...store.seenAgents(), ...fixed, ...holders])].sort() };
  });

  f.get('/api/emails/:id', async (req, reply) => {
    const e = find((req.params as { id: string }).id);
    if (!e) return reply.code(404).send({ error: 'No such email' });
    const m = memberOf(e);
    const o = outageOf(e);
    return { ...card(e), body: e.body, draft: e.draft ?? '', reply: e.reply ?? null, history: e.history, facts: e.facts ?? {}, account: m ? await accountSummary(m) : null, outage: o ? outageDto(o) : null };
  });

  f.post('/api/emails/:id/pick', async (req, reply) => {
    const e = find((req.params as { id: string }).id);
    const agent = who(bodyOf(req));
    if (!e) return reply.code(404).send({ error: 'No such email' });
    if (!agent) return reply.code(400).send({ error: 'agent is required' });
    if (!store.pick(e, agent)) return reply.code(409).send({ error: e.status === 'sent' ? 'This email was already answered' : `Already picked by ${e.agent}`, email: card(e) });
    return { ok: true, email: card(e) };
  });

  f.post('/api/emails/:id/assign', async (req, reply) => {
    const e = find((req.params as { id: string }).id);
    const b = bodyOf(req);
    const agent = who(b);
    if (!e) return reply.code(404).send({ error: 'No such email' });
    if (!agent) return reply.code(400).send({ error: 'agent is required' });
    if (!store.assign(e, agent, who(b, 'by') || 'supervisor')) return reply.code(409).send({ error: 'This email was already answered' });
    return { ok: true, email: card(e) };
  });

  f.post('/api/emails/:id/release', async (req, reply) => {
    const e = find((req.params as { id: string }).id);
    const agent = who(bodyOf(req));
    if (!e) return reply.code(404).send({ error: 'No such email' });
    if (e.status === 'picked' && agent && e.agent.toLowerCase() !== agent.toLowerCase() && !bodyOf(req).force)
      return reply.code(409).send({ error: `Held by ${e.agent}` });
    if (!store.release(e, agent)) return reply.code(409).send({ error: 'Not picked' });
    return { ok: true, email: card(e) };
  });

  f.post('/api/emails/:id/draft', async (req, reply) => {
    const e = find((req.params as { id: string }).id);
    if (!e) return reply.code(404).send({ error: 'No such email' });
    const m = memberOf(e);
    const agent = who(bodyOf(req)) || e.agent;
    const dr = draftFor(e, m ? await accountSummary(m) : null, outageOf(e), agent);
    store.saveDraft(e, dr.text);
    return { ...dr, generated: 'ai_draft' };
  });

  f.post('/api/emails/:id/send', async (req, reply) => {
    const e = find((req.params as { id: string }).id);
    const b = bodyOf(req);
    const agent = who(b);
    const text = String(b.text ?? '').trim();
    if (!e) return reply.code(404).send({ error: 'No such email' });
    if (!agent || !text) return reply.code(400).send({ error: 'agent and text are required' });
    if (e.status === 'sent') return reply.code(409).send({ error: 'This email was already answered' });
    if (e.status === 'picked' && e.agent.toLowerCase() !== agent.toLowerCase()) return reply.code(409).send({ error: `Held by ${e.agent}` });
    if (/\b(?:\d[ -]?){13,19}\b/.test(text)) return reply.code(400).send({ error: 'The reply looks like it contains a card number. Remove it before sending.' });
    const r = await send(e, text, agent, b.subject ? String(b.subject) : undefined);
    return { ok: true, ...r, email: card(e) };
  });

  f.get('/api/emails/outage/:outageId/draft', async (req, reply) => {
    const o = outages.get((req.params as { outageId: string }).outageId);
    if (!o) return reply.code(404).send({ error: 'No such outage' });
    const g = groups().find((x) => x.outage.id === o.id);
    return { outage: outageDto(o), text: groupDraft(o, String((req.query as { agent?: string }).agent ?? '')), recipients: g?.open ?? 0, placeholder: '{first_name}' };
  });

  f.post('/api/emails/outage/:outageId/reply', async (req, reply) => {
    const id = (req.params as { outageId: string }).outageId;
    const o = outages.get(id);
    const b = bodyOf(req);
    const agent = who(b);
    if (!o) return reply.code(404).send({ error: 'No such outage' });
    if (!agent) return reply.code(400).send({ error: 'agent is required' });
    const text = String(b.text ?? '').trim() || groupDraft(o, agent);
    // Everyone still open in the group — including emails other agents had picked (the
    // group reply supersedes them; the history says so).
    const targets = store.all().filter((e) => e.status !== 'sent' && outageOf(e)?.id === id);
    const results = [];
    for (const e of targets) results.push({ id: e.id, to: e.from, ...(await send(e, text, agent, `Re: ${e.subject}`, id)) });
    return { ok: true, outageId: id, sent: results.length, results: results.map((r) => ({ id: r.id, to: r.to, accountNote: r.accountNote })) };
  });

  f.post('/api/emails/reset', async () => {
    store.reset();
    return { ok: true, emails: store.all().length };
  });

  // The console's "Reset demo data" (POST api/reset in routes.ts) re-seeds the inbox too.
  f.addHook('onResponse', async (req, res) => {
    if (req.method === 'POST' && req.routeOptions.url === '/api/reset' && res.statusCode < 300) store.reset();
  });

  return store;
}
