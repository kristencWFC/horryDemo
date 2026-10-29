// Live agent's desktop (discovery item 9: "screen pop from NISC — Mitel couldn't do it").
//
//   GET  api/agent-desk?guid=&ani=&sep=     → everything <horry-member> shows in one poll:
//        member, billing (NextGen financial), usage, outage, what Savannah did on this call,
//        recent payments + notes, deterministic talking points, which actions are allowed.
//   GET  api/agent-desk/account?sep=         → the same plus billing/payment history for the
//        mock billing-system screen (public/billing.html).
//   POST api/agent-desk/payment-link          → text a secure pay link (same Payments + Sms path
//        as Savannah's send_payment_link, so it shows in the Storm Console texts).
//   POST api/agent-desk/card-on-file          → charge the card already on file (no card data).
//   POST api/agent-desk/extension             → NextGen RequestPaymentExtension when allowed.
//   POST api/agent-desk/note                  → NextGen UpdateUpnAccounts note.
//
// No external AI: talking points are rules over the data. Card numbers never pass here.
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { env, baseUrl, last10 } from './env.js';
import { JsonStore } from './store.js';
import type { MemberStore, Member } from './members.js';
import { displayName, displayAddress } from './members.js';
import type { NextGenClient, Financial } from './nextgen.js';
import type { OutageStore } from './outages.js';
import { spokenEtr } from './outages.js';
import type { CallStore, CallRow } from './calls.js';
import type { Sms } from './sms.js';
import type { Payments, PaymentSession } from './payments.js';

export interface AgentDeskDeps {
  dataDir: string;
  members: MemberStore;
  nextgen: NextGenClient;
  outages: OutageStore;
  calls: CallStore;
  sms: Sms;
  payments: Payments;
}

interface TalkingPoint {
  tone: 'bad' | 'warn' | 'ok' | 'info';
  text: string;
}

const money = (n: number | null | undefined) =>
  `$${(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : 0);

/** NextGen dates are "MM/DD/YY". */
function parseCisDate(s: string | null | undefined): Date | null {
  const m = String(s ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
  return new Date(y, Number(m[1]) - 1, Number(m[2]));
}
const cisDate = (d: Date) =>
  `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${String(d.getFullYear()).slice(-2)}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Co-op rule (demo): an extension may run up to 10 days past the cut-off (or due) date. */
const EXTENSION_GRACE_DAYS = 10;

const STEP_LABEL: Record<string, string> = {
  identified: 'Identified the member',
  lookup_miss: 'Lookup missed',
  outage_check: 'Checked for an outage',
  outage_known: 'Confirmed the known outage',
  outage_reported: 'Reported an outage',
  subscribed: 'Signed up for restoration updates',
  billing: 'Read the bill',
  payment_link: 'Texted a payment link',
  payment: 'Payment taken',
  payment_declined: 'Payment declined',
  keypad_unavailable: 'Keypad payment unavailable',
  extension: 'Payment extension',
  escalated: 'Transferred to an agent',
  wrapped: 'Wrapped up',
  agent_payment_link: 'Agent texted a payment link',
  agent_payment: 'Agent took a payment',
  agent_extension: 'Agent set a payment extension',
  agent_note: 'Agent added a note',
};

export function registerAgentDeskRoutes(f: FastifyInstance, d: AgentDeskDeps): void {
  const { members, nextgen, outages, calls, sms, payments } = d;
  const tz = env.BUSINESS_TIMEZONE;
  // The Storm Console's demo-caller override lives in routes.ts; it persists to
  // settings.json, so read it from there (same defaults as routes.ts).
  const settingsStore = new JsonStore<{ demoAni: string; demoMemberSep: string }>(join(d.dataDir, 'settings.json'));
  const settings = () => ({ demoAni: '2142823566', demoMemberSep: '00212040001', ...(settingsStore.load() ?? {}) });

  /** The Desktop knows the caller even when the flow's call-context arrived without an ANI:
   *  stamp the call row so the dashboard and contact history name the member (2026-10-29). */
  async function resolve(q: { guid?: string; ani?: string; sep?: string }): Promise<{ m?: Member; row?: CallRow }> {
    const out = await lookup(q);
    const { m, row } = out;
    if (m && row && !row.memberSep) {
      const ani = last10(q.ani);
      calls.patch(row, { memberSep: m.MemberSep, memberName: displayName(m), ...(ani.length === 10 && !row.ani ? { ani } : {}) });
    }
    return out;
  }

  async function lookup(q: { guid?: string; ani?: string; sep?: string }): Promise<{ m?: Member; row?: CallRow }> {
    const row = q.guid ? calls.get(q.guid) : undefined;
    if (row?.memberSep) return { m: members.bySep(row.memberSep), row };
    if (q.sep) {
      const m = members.bySep(q.sep);
      if (m) return { m, row };
    }
    const ani = last10(q.ani || row?.ani);
    if (ani.length === 10) {
      const s = settings();
      if (ani === last10(s.demoAni)) return { m: members.bySep(s.demoMemberSep), row };
      const infos = await nextgen.accountsInfo(1, ani).catch(() => []);
      if (infos[0]) return { m: members.bySep(String(infos[0].MemberSep)), row };
    }
    return { row };
  }

  function extensionRule(fin: Financial | null, m: Member) {
    const latest = (m.Extensions ?? []).at(-1);
    if (latest) return { allowed: false, payBy: latest.payBy, reason: `Extension already on file to ${latest.payBy} (confirmation ${latest.confirmation}).` };
    if (!fin) return { allowed: false, payBy: '', reason: 'Billing system unavailable.' };
    if (!(fin.AmountDue > 0)) return { allowed: false, payBy: '', reason: 'Nothing is due.' };
    if (!fin.AllowArrangementFlag) return { allowed: false, payBy: '', reason: 'Not eligible under co-op rules.' };
    const base = parseCisDate(fin.CutOffDate) ?? parseCisDate(fin.DueDate) ?? new Date();
    return { allowed: true, payBy: cisDate(addDays(base, EXTENSION_GRACE_DAYS)), reason: `Allowed up to ${EXTENSION_GRACE_DAYS} days past the ${fin.CutOffDate ? 'cut-off' : 'due'} date.` };
  }

  async function snapshot(m: Member, row: CallRow | undefined) {
    const fin = await nextgen.financial(m.MemberSep).catch(() => null);
    const o = outages.forMember(m);
    const usage = {
      last30Kwh: m.KwhLast30,
      priorMonthKwh: m.KwhPriorMonth,
      sameMonthLastYearKwh: m.KwhSameMonthLastYear,
      vsPriorMonthPct: pct(m.KwhLast30, m.KwhPriorMonth),
      vsLastYearPct: pct(m.KwhLast30, m.KwhSameMonthLastYear),
      /** Oldest → newest, 13 bills: the first is the same month last year, the last is now. */
      months: billHistory(m, 0).reverse().map((h) => ({ month: h.month, kwh: h.kwh })),
    };
    const ext = extensionRule(fin, m);
    const pays = payments.all().filter((p) => p.memberSep === m.MemberSep).slice(0, 5).map(paymentDto);
    const billing = fin
      ? {
          currentBalance: fin.CurrentBalance,
          amountDue: fin.AmountDue,
          pastDue: fin.PastDueAmount,
          dueDate: fin.DueDate,
          cutOffDate: fin.CutOffDate,
          onCutOffList: fin.OnCutOffList,
          pendingDisconnect: fin.PendingDisconnectType,
          lastPayment: fin.LastPayment,
          lastPaymentDate: fin.PaymentDate,
          billDate: fin.BillDate,
          cardOnFile: fin.CardProfileExists ? { last4: fin.Last4CcDigits ?? '', brand: m.CardBrand ?? 'Card' } : null,
          bankDraft: fin.ChkProfileExists,
          budgetAmount: (fin.BudgetOrLevelizedBillAmount ?? 0) > 0 ? fin.BudgetOrLevelizedBillAmount : null,
          paperless: m.Paperless,
          accountStatus: fin.AccountStatus,
        }
      : null;
    const call = row
      ? {
          guid: row.guid,
          channel: row.channel,
          startedAt: row.startedAt,
          endedAt: row.endedAt ?? null,
          stormMode: row.stormMode,
          journey: row.journey
            .filter((j, i, all) => !(i > 0 && all[i - 1]!.step === j.step && all[i - 1]!.detail === j.detail)) // the flow can seed twice
            .map((j) => ({ ...j, label: STEP_LABEL[j.step] ?? j.step })),
          summary: row.summary ?? null,
          escalation: row.escalation ?? null,
          outcome: row.outcome ?? null,
          sentiment: row.sentiment ?? null,
          aiHandled: row.journey.some((j) => !j.step.startsWith('agent_') && j.step !== 'identified') || Boolean(row.summary || row.escalation),
        }
      : null;
    return {
      found: true,
      member: {
        memberSep: m.MemberSep,
        name: displayName(m),
        firstName: m.FirstName,
        address: displayAddress(m),
        zip: m.Zip,
        cellPhone: m.CellPhone,
        homePhone: m.Telephone,
        email: m.EmailAddr,
        rate: m.Rate,
        meter: m.Meter,
        location: m.Location,
        substation: m.SubStation,
        circuit: m.Circuit,
        lifeSupport: m.PrioritySvc > 0,
        status: m.AcctStatus === 'A' ? 'Active' : m.AcctStatus,
      },
      billing,
      usage,
      outage: o ? { id: o.id, area: o.area, customers: o.customers, cause: o.cause, crew: o.crew, etr: o.etr, etrText: spokenEtr(o.etr, tz), startedAt: o.startedAt, source: o.source } : null,
      call,
      payments: pays,
      notes: [...(m.Notes ?? [])].reverse().slice(0, 5),
      extensions: m.Extensions ?? [],
      talkingPoints: talkingPoints(m, billing, usage, o ? { id: o.id, area: o.area, etrText: spokenEtr(o.etr, tz), crew: o.crew, cause: o.cause } : null, call, ext, pays),
      actions: {
        paymentLink: { enabled: Boolean(billing), amount: billing ? round2(billing.pastDue > 0 ? billing.pastDue : billing.amountDue) : 0, phone: textablePhone(m, row) },
        cardOnFile: { enabled: Boolean(billing?.cardOnFile), label: billing?.cardOnFile ? `${billing.cardOnFile.brand} ending ${billing.cardOnFile.last4}` : '' },
        extension: ext,
        note: { enabled: true },
      },
      billingScreen: `billing.html?sep=${m.MemberSep}`,
    };
  }

  // ---- reads ------------------------------------------------------------------------

  f.get('/api/agent-desk', async (req, reply) => {
    const q = req.query as { guid?: string; ani?: string; sep?: string };
    if (!q.guid && !q.ani && !q.sep) return reply.code(400).send({ found: false, error: 'guid, ani or sep required' });
    const { m, row } = await resolve(q);
    if (row && q.guid && !row.endedAt) calls.patch(row, { agentSeenAt: new Date().toISOString() });
    if (!m) return reply.code(404).send({ found: false, error: 'No member matches this caller', call: row ? { guid: row.guid, ani: row.ani } : null });
    return snapshot(m, row ?? calls.all().find((r) => r.memberSep === m.MemberSep && !q.guid));
  });

  f.get('/api/agent-desk/account', async (req, reply) => {
    const q = req.query as { sep?: string };
    const m = q.sep ? members.bySep(q.sep) : undefined;
    if (!m) return reply.code(404).send({ found: false, error: 'Account not found' });
    const snap = await snapshot(m, undefined);
    const memberCalls = calls.all().filter((r) => r.memberSep === m.MemberSep).slice(0, 10);
    return {
      ...snap,
      notes: [...(m.Notes ?? [])].reverse(),
      payments: payments.all().filter((p) => p.memberSep === m.MemberSep).map(paymentDto),
      history: billHistory(m, payments.all().filter((p) => p.memberSep === m.MemberSep && p.status === 'approved').reduce((n, p) => n + p.amount, 0)),
      contacts: memberCalls.map((r) => ({
        guid: r.guid,
        at: r.startedAt,
        channel: r.channel,
        handledBy: r.escalation ? 'Virtual assistant → agent' : r.journey.some((j) => j.step.startsWith('agent_')) ? 'Agent' : 'Virtual assistant',
        outcome: r.escalation ? `Transferred: ${r.escalation.reason}` : r.outcome ?? r.journey.at(-1)?.detail ?? '',
        outageId: r.outageId ?? null,
      })),
      tickets: outages
        .all()
        .filter((o) => o.location === m.Location || (!o.location && o.substation === m.SubStation && (o.circuit === null || o.circuit === m.Circuit)))
        .map((o) => ({ id: o.id, area: o.area, status: o.status, cause: o.cause, crew: o.crew, startedAt: o.startedAt, restoredAt: o.restoredAt ?? null, etrText: spokenEtr(o.etr, tz), source: o.source, customers: o.customers })),
    };
  });

  // ---- actions ----------------------------------------------------------------------

  type ActionBody = { guid?: string; sep?: string; ani?: string; agent?: string; amount?: number | string; phone?: string; payBy?: string; text?: string };

  async function actionTarget(b: ActionBody) {
    const { m, row } = await resolve({ guid: b.guid, ani: b.ani, sep: b.sep });
    return { m, row };
  }
  const byAgent = (b: ActionBody) => (b.agent ? String(b.agent).slice(0, 60) : 'Agent');

  f.post('/api/agent-desk/payment-link', async (req, reply) => {
    const b = (req.body ?? {}) as ActionBody;
    const { m, row } = await actionTarget(b);
    if (!m) return reply.code(404).send({ error: 'Member not found' });
    const amount = round2(Number(b.amount));
    if (!(amount > 0) || amount > 10000) return reply.code(400).send({ error: 'Enter an amount between $0.01 and $10,000.' });
    const phone = last10(b.phone) || textablePhone(m, row);
    if (phone.length !== 10) return reply.code(400).send({ error: 'Enter the 10-digit mobile number for the text.' });
    // Same path as Savannah's send_payment_link (routes.ts): session + text with pay.html.
    const s = payments.create({ guid: row?.guid ?? `agent-${Date.now()}`, memberSep: m.MemberSep, memberName: displayName(m), amount, method: 'link', phone, initiatedBy: 'agent' });
    await sms.send(phone, `Horry Electric: here is your secure payment link for ${money(amount)} on account ending ${m.MemberSep.slice(-4)}: ${baseUrl()}/pay.html?s=${s.id}`, 'payment_link');
    if (row) {
      calls.patch(row, { paymentId: s.id });
      calls.step(row, 'agent_payment_link', `${byAgent(b)} texted a ${money(amount)} link to ${phone}`, 'payment');
    }
    void nextgen.addNote(m.MemberSep, `${byAgent(b)}: secure payment link for ${money(amount)} texted to ${phone}.`, 'AN').catch(() => undefined);
    console.log(`HORRY DESK ${row?.guid ?? '-'}: payment link ${money(amount)} → ${phone} (${byAgent(b)})`);
    return { ok: true, payment: paymentDto(s), message: `Secure payment link for ${money(amount)} texted to ${fmtPhone(phone)}.` };
  });

  f.post('/api/agent-desk/card-on-file', async (req, reply) => {
    const b = (req.body ?? {}) as ActionBody;
    const { m, row } = await actionTarget(b);
    if (!m) return reply.code(404).send({ error: 'Member not found' });
    const amount = round2(Number(b.amount));
    if (!(amount > 0) || amount > 10000) return reply.code(400).send({ error: 'Enter an amount between $0.01 and $10,000.' });
    const fin = await nextgen.financial(m.MemberSep);
    if (!fin?.CardProfileExists) return reply.code(400).send({ error: 'No card on file. Text a secure payment link instead.' });
    const s = payments.create({ guid: row?.guid ?? `agent-${Date.now()}`, memberSep: m.MemberSep, memberName: displayName(m), amount, method: 'card_on_file', phone: last10(row?.ani), initiatedBy: 'agent' });
    try {
      await payments.payWithProfile(s);
    } catch (err) {
      return reply.code(502).send({ error: `Payment gateway: ${(err as Error).message}` });
    }
    if (row) {
      calls.patch(row, { paymentId: s.id });
      calls.step(row, s.status === 'approved' ? 'agent_payment' : 'payment_declined', `${byAgent(b)}: ${money(amount)} card on file ${s.status}${s.confirmation ? `, confirmation ${s.confirmation}` : ''}`, 'payment');
    }
    if (s.status !== 'approved') return { ok: false, payment: paymentDto(s), message: 'The card on file was declined. Offer the secure text link for a different card.' };
    return { ok: true, payment: paymentDto(s), message: `${money(amount)} approved on ${s.cardType} ending ${s.last4} — confirmation ${s.confirmation}.` };
  });

  f.post('/api/agent-desk/extension', async (req, reply) => {
    const b = (req.body ?? {}) as ActionBody;
    const { m, row } = await actionTarget(b);
    if (!m) return reply.code(404).send({ error: 'Member not found' });
    const fin = await nextgen.financial(m.MemberSep);
    const rule = extensionRule(fin, m);
    if (!rule.allowed || !fin) return reply.code(400).send({ error: `Extension not available: ${rule.reason}` });
    const payBy = String(b.payBy || rule.payBy);
    const want = parseCisDate(payBy);
    const max = parseCisDate(rule.payBy);
    if (!want || !max) return reply.code(400).send({ error: 'Pay-by date must be MM/DD/YY.' });
    if (want > max) return reply.code(400).send({ error: `Latest allowed pay-by date is ${rule.payBy}.` });
    const conf = await nextgen.requestExtension(m.MemberSep, payBy, fin.AmountDue);
    if (!conf) return reply.code(400).send({ error: 'The billing system declined the extension.' });
    void nextgen.addNote(m.MemberSep, `${byAgent(b)}: payment extension to ${payBy} for ${money(fin.AmountDue)}, confirmation ${conf}.`, 'AN').catch(() => undefined);
    if (row) calls.step(row, 'agent_extension', `${byAgent(b)}: extension to ${payBy}, confirmation ${conf}`, 'payment_extension');
    console.log(`HORRY DESK ${row?.guid ?? '-'}: extension ${m.MemberSep} → ${payBy} conf ${conf}`);
    return { ok: true, confirmation: conf, payBy, message: `Extension to ${payBy} confirmed — confirmation ${conf}. Service stays on while it is in place.` };
  });

  f.post('/api/agent-desk/note', async (req, reply) => {
    const b = (req.body ?? {}) as ActionBody;
    const { m, row } = await actionTarget(b);
    if (!m) return reply.code(404).send({ error: 'Member not found' });
    const text = String(b.text ?? '').trim().slice(0, 500);
    if (!text) return reply.code(400).send({ error: 'Type the note first.' });
    await nextgen.addNote(m.MemberSep, `${byAgent(b)}: ${text}`, 'AN');
    if (row) calls.step(row, 'agent_note', `${byAgent(b)}: ${text.slice(0, 120)}`);
    return { ok: true, message: 'Note added to the member account.' };
  });
}

// ---- helpers --------------------------------------------------------------------------

/** The caller's number, unless it is the account's landline and a cell is on file. */
function textablePhone(m: Member, row: CallRow | undefined): string {
  const ani = last10(row?.ani);
  if (ani && !(ani === last10(m.Telephone) && last10(m.CellPhone))) return ani;
  return last10(m.CellPhone) || ani;
}

function fmtPhone(p: string): string {
  return /^\d{10}$/.test(p) ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p;
}

function paymentDto(p: PaymentSession) {
  return {
    id: p.id,
    amount: p.amount,
    method: p.method,
    status: p.status,
    createdAt: p.createdAt,
    completedAt: p.completedAt ?? null,
    last4: p.last4 ?? null,
    cardType: p.cardType ?? null,
    confirmation: p.confirmation ?? null,
    phone: p.phone,
    initiatedBy: p.initiatedBy,
  };
}

type BillingDto = {
  amountDue: number;
  pastDue: number;
  dueDate: string;
  cutOffDate: string | null;
  onCutOffList: boolean;
  lastPayment: number;
  lastPaymentDate: string;
  cardOnFile: { last4: string; brand: string } | null;
  bankDraft: boolean;
  budgetAmount: number | null;
} | null;

function talkingPoints(
  m: Member,
  b: BillingDto,
  u: { last30Kwh: number; sameMonthLastYearKwh: number; priorMonthKwh: number; vsLastYearPct: number; vsPriorMonthPct: number },
  o: { id: string; area: string; etrText: string; crew: string; cause: string } | null,
  call: { journey: { step: string; detail: string }[]; escalation: { reason: string; department: string } | null } | null,
  ext: { allowed: boolean; payBy: string; reason: string },
  pays: ReturnType<typeof paymentDto>[]
): TalkingPoint[] {
  const tp: TalkingPoint[] = [];
  const did = new Set(call?.journey.map((j) => j.step) ?? []);
  if (call?.escalation) tp.push({ tone: 'warn', text: `Savannah transferred this call: ${call.escalation.reason.replace(/_/g, ' ')}. Identity is already confirmed — no need to re-verify.` });
  else if (did.has('identified')) tp.push({ tone: 'info', text: `Caller identified as ${displayName(m)} from caller ID.` });
  if (m.PrioritySvc > 0) tp.push({ tone: 'bad', text: 'Life-support member: priority restoration, and no disconnect without the medical-certificate review.' });
  if (o) {
    tp.push({
      tone: 'warn',
      text: did.has('outage_known') || did.has('outage_reported')
        ? `In outage ${o.id} (${o.area.split(',')[0]}). Savannah already gave the estimate — ${o.etrText}.`
        : `In outage ${o.id}: ${o.cause}, ${o.crew}. Estimate ${o.etrText}.`,
    });
    if (!did.has('subscribed')) tp.push({ tone: 'info', text: 'Offer a text when power is restored.' });
  }
  if (b) {
    if (b.pastDue > 0) {
      tp.push({ tone: 'bad', text: `Past due ${money(b.pastDue)}${b.cutOffDate ? ` — cut-off ${b.cutOffDate}` : ''}.${ext.allowed ? ` Extension allowed until ${ext.payBy}.` : ` ${ext.reason}`}` });
    } else if (b.amountDue > 0) {
      tp.push({ tone: 'ok', text: `Current: ${money(b.amountDue)} due ${b.dueDate}${b.bankDraft ? ' — drafts automatically from the bank on the due date' : ''}.` });
    } else {
      tp.push({ tone: 'ok', text: 'Account is paid up — nothing due.' });
    }
    if (u.vsLastYearPct >= 15) {
      tp.push({
        tone: 'warn',
        text: `High bill: usage up ${u.vsLastYearPct}% vs the same month last year (${u.last30Kwh.toLocaleString()} vs ${u.sameMonthLastYearKwh.toLocaleString()} kWh) — likely heating/cooling with the weather; offer an energy check-up${b.budgetAmount ? '' : ' and budget billing to even out the bills'}.`,
      });
    } else if (u.vsPriorMonthPct >= 15) {
      tp.push({ tone: 'info', text: `Usage up ${u.vsPriorMonthPct}% vs last month, in line with last year (${u.vsLastYearPct >= 0 ? '+' : ''}${u.vsLastYearPct}%) — seasonal.` });
    }
    if (b.cardOnFile && b.amountDue > 0 && !b.bankDraft) tp.push({ tone: 'info', text: `${b.cardOnFile.brand} ending ${b.cardOnFile.last4} on file — can pay now with their OK.` });
    if (b.budgetAmount) tp.push({ tone: 'info', text: `On budget billing at ${money(b.budgetAmount)}/month.` });
  }
  const pending = pays.find((p) => p.status === 'pending');
  const approved = pays.find((p) => p.status === 'approved' && Date.now() - Date.parse(p.completedAt ?? p.createdAt) < 24 * 3600_000);
  if (approved) tp.push({ tone: 'ok', text: `Paid ${money(approved.amount)} today — confirmation ${approved.confirmation}.` });
  else if (pending) tp.push({ tone: 'info', text: `Payment link for ${money(pending.amount)} sent — waiting for the member to pay.` });
  return tp;
}

/** Deterministic 13-month history (billing screen + the Member tab usage chart), anchored on the account's real
 *  current figures (latest bill = current charges; same month last year = seeded kWh). */
function billHistory(m: Member, paidSinceBill: number) {
  const RATE = 0.118;
  const FACILITY = 32;
  const anchor = parseCisDate(m.BillDate) ?? new Date();
  const out: { billDate: string; month: string; kwh: number; amount: number; paid: number; paidOn: string | null; status: string }[] = [];
  let seed = Number(m.MemberSep.slice(-6)) || 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 13; i++) {
    const billDate = new Date(anchor.getFullYear(), anchor.getMonth() - i, anchor.getDate());
    const month = billDate.toLocaleString('en-US', { month: 'short' }) + ' ' + String(billDate.getFullYear()).slice(2);
    let kwh: number;
    if (i === 0) kwh = m.KwhLast30;
    else if (i === 1) kwh = m.KwhPriorMonth;
    else if (i === 12) kwh = m.KwhSameMonthLastYear; // same month last year
    else {
      // Seasonal curve between last year's and this year's level (peaks Jan and Jul/Aug).
      const mon = billDate.getMonth();
      const season = 1 + 0.28 * Math.cos(((mon - 0.5) / 12) * 4 * Math.PI);
      kwh = Math.round(((m.KwhSameMonthLastYear + m.KwhPriorMonth) / 2) * season * (0.94 + 0.12 * rnd()));
    }
    // Latest bill = what is due now (net of any past due) plus what was paid on it during the demo.
    const amount = i === 0 ? round2(Math.max(0, m.AmountDue - m.PastDueAmount) + paidSinceBill) || round2(kwh * RATE + FACILITY) : round2(kwh * RATE + FACILITY);
    let paid = amount;
    let paidOn: string | null = cisDate(addDays(billDate, 17 + Math.floor(rnd() * 5)));
    let status = 'Paid';
    if (i === 0) {
      paid = round2(paidSinceBill);
      paidOn = paidSinceBill > 0 ? cisDate(new Date()) : null;
      status = m.AmountDue > 0 ? `Due ${m.DueDate}` : 'Paid';
    } else if (i === 1) {
      if (m.PastDueAmount > 0) {
        // Unpaid prior bill: billed = what they paid + what is still past due.
        out.push({ billDate: cisDate(billDate), month, kwh, amount: round2(m.PastDueAmount + m.LastPayment), paid: round2(m.LastPayment), paidOn: m.LastPayment > 0 ? m.PaymentDate : null, status: `Past due ${money(m.PastDueAmount)}` });
        continue;
      }
      status = m.PastDueAmount > 0 ? `Past due ${money(m.PastDueAmount)}` : 'Paid';
    }
    out.push({ billDate: cisDate(billDate), month, kwh, amount, paid, paidOn, status });
  }
  return out;
}
