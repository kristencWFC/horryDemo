// HTTP surface: WxCC flow lookups, the ElevenLabs agent's webhooks + tools, payments,
// outage control, Storm Mode, and the ops console's read APIs. Paths are relative-safe
// behind the nginx /horry/ prefix (pages call `api/...`, never `/api/...`).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env, baseUrl, last10, twilioConfigured, wxccConfigured, staffingConfigured } from './env.js';
import { JsonStore } from './store.js';
import type { MemberStore, Member } from './members.js';
import { displayName, displayAddress, spokenAddress } from './members.js';
import type { NextGenClient, Financial } from './nextgen.js';
import type { OutageStore, Outage } from './outages.js';
import { spokenEtr } from './outages.js';
import type { CallStore, CallRow } from './calls.js';
import type { Sms } from './sms.js';
import { twilioSignatureOk } from './sms.js';
import type { Payments } from './payments.js';
import type { ModeStore } from './mode.js';
import type { StaffingStore } from './staffing.js';
import { overview, callDetail, callsCsv } from './analytics.js';
import { legFromBody } from './agent-summaries.js';
import { relayResultToFreeswitch, fsRelayConfigured } from './freeswitch.js';

export interface Deps {
  dataDir: string;
  members: MemberStore;
  nextgen: NextGenClient;
  outages: OutageStore;
  calls: CallStore;
  sms: Sms;
  payments: Payments;
  mode: ModeStore;
  staffing: StaffingStore;
}

interface Settings {
  demoAni: string; // the presenter's phone
  demoMemberSep: string; // which member that phone "is" right now
  demoSmsTo: string; // every demo text goes here (empty = the member's own number)
}

const ASSISTANT = 'Savannah';
const money = (n: number | null | undefined) => `$${(n ?? 0).toFixed(2)}`;
const digits = (s: string) => s.replace(/\D/g, '').split('').join(' ');
// "VISA" → "Visa", "MASTERCARD" → "Mastercard" (Savannah reads it aloud).
const cardBrand = (b: string | null) => (b ? b.charAt(0) + b.slice(1).toLowerCase() : 'card');

export function registerRoutes(f: FastifyInstance, d: Deps): void {
  const { members, nextgen, outages, calls, sms, payments, mode } = d;
  const tz = env.BUSINESS_TIMEZONE;
  const settingsStore = new JsonStore<Settings>(join(d.dataDir, 'settings.json'));
  const settings: Settings = { demoAni: '2142823566', demoMemberSep: '00212040001', demoSmsTo: '', ...(settingsStore.load() ?? {}) };
  sms.demoTo = settings.demoSmsTo;

  const toolAuth = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (env.TOOL_SHARED_SECRET && req.headers['x-tool-secret'] !== env.TOOL_SHARED_SECRET) {
      void reply.code(401).send({ error: 'bad tool secret' });
      return false;
    }
    return true;
  };

  // ---- member resolution (NextGen first, the demo-phone override on top) -------------

  async function memberByAni(ani: string): Promise<Member | undefined> {
    const p = last10(ani);
    if (p && p === last10(settings.demoAni)) return members.bySep(settings.demoMemberSep);
    const infos = await nextgen.accountsInfo(1, p).catch(() => []);
    return infos[0] ? members.bySep(String(infos[0].MemberSep)) : undefined;
  }

  /** Where restoration texts go unless the caller gives another number. */
  const textNumber = (m: Member | undefined): string => last10(settings.demoSmsTo) || last10(m?.CellPhone ?? '');

  const rowMember = (row: CallRow): Member | undefined => (row.memberSep ? members.bySep(row.memberSep) : undefined);

  function outageFacts(o: Outage | undefined) {
    return {
      outage_known: o ? 'true' : 'false',
      outage_area: o?.area ?? '',
      outage_customers: o ? String(o.customers) : '0',
      outage_cause: o?.cause ?? '',
      outage_crew: o?.crew ?? '',
      outage_etr: o ? spokenEtr(o.etr, tz) : '',
      outage_id: o?.id ?? '',
    };
  }

  function playbook(storm: boolean, m: Member | undefined, o: Outage | undefined): string {
    const lines: string[] = [];
    if (storm) {
      lines.push(
        'STORM MODE IS ON: a major outage event is in progress and most callers are calling about outages.',
        'Lead with the outage. Keep calls short and calm — many members are waiting. Do not bring up bills or payments unless the caller does.'
      );
    } else {
      lines.push('Normal operations: callers may be calling about billing, payments, service requests or an outage.');
      if (mode.get().aiAll) lines.push('You are answering every call today to help the team with a busy day. Ask what they are calling about and handle what you can (outages, balances, payments, extensions). Connect them with a person (escalate) whenever they ask or you cannot help.');
    }
    if (m && o) {
      lines.push(storm
        ? `There IS a known outage at this member's location (${o.area}); confirm it is what they are calling about.`
        : `There is a known outage at this member's location (${o.area}). Do not bring it up; if they mention power or an outage, it is already known, so go straight to the facts.`);
    }
    // The cell we text: the demo text number (AI Operations) or the member's cell on file.
    const cell = textNumber(m);
    if (m && cell) lines.push(`Cell number on file for texts: ending ${cell.slice(-4).split('').join(' ')}. Offer it instead of asking for a number.`);
    if (m && m.OnCutOffList && !storm) {
      lines.push(`This account is past due ${money(m.PastDueAmount)} and on the cut-off list for ${m.CutOffDate}. If they call about billing, explain gently and offer a payment or an extension.`);
    }
    return lines.join('\n');
  }

  function firstMessage(storm: boolean, m: Member | undefined, o: Outage | undefined): string {
    const open = `Thank you for calling Horry Electric Cooperative. This is ${ASSISTANT}, the co-op's virtual assistant.`;
    // Outage-first greeting only in Storm Mode; with AI for all calls it's a normal day (Kristen 2026-10-29).
    if (storm && m && o) return `${open} Hi ${m.FirstName} — are you calling about the power outage in the ${o.area.split(',')[0]} area?`;
    if (m) return `${open} Am I speaking with ${m.FirstName}?`;
    if (storm) return `${open} If you're calling to report an outage, I can help with that right away. What's going on?`;
    return `${open} How can I help you today?`;
  }

  async function dynamicVars(row: CallRow | undefined, m: Member | undefined) {
    const st = mode.get();
    const o = m ? outages.forMember(m) : undefined;
    const fin = m ? await nextgen.financial(m.MemberSep).catch(() => null) : null;
    return {
      assistant_name: ASSISTANT,
      first_message: firstMessage(st.storm, m, o),
      call_playbook: playbook(st.storm, m, o),
      // Paraphrased, never read verbatim: a saved 'please hold' line once made her tell a caller to hold mid-answer.
      broadcast_message: st.broadcast
        ? `Supervisor's note for today (work it in once, briefly and in your own words, only if it adds something the caller has not already heard; skip it if you are already telling them about their outage; never tell anyone to hold): ${st.broadcast}`
        : '',
      member_found: m ? 'true' : 'false',
      member_name: m ? displayName(m) : 'unknown',
      first_name: m?.FirstName ?? 'there',
      service_address: m ? spokenAddress(m) : 'unknown',
      account_number: m ? m.MemberSep : '',
      ...outageFacts(o),
      life_support: m && m.PrioritySvc > 0 ? 'true' : 'false',
      balance_due: fin ? money(fin.AmountDue) : '',
      due_date: fin?.DueDate ?? '',
      past_due: fin ? money(fin.PastDueAmount) : '$0.00',
      cutoff_date: fin?.CutOffDate ?? 'none',
      storm_mode: st.storm ? 'true' : 'false',
      current_date: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz }),
      // sip_call_guid is NOT returned: on SIP bridges ElevenLabs fills it from the
      // X-Call-GUID header (home-services contract). `row` is only used for logging.
    };
  }

  // ---- health / settings / mode -----------------------------------------------------

  f.get('/health', async () => ({
    ok: true,
    service: 'horry-demo',
    nextgen: nextgen.isMock ? 'mock' : 'live',
    twilio: twilioConfigured(),
    wxcc: wxccConfigured(),
    staffing: staffingConfigured(),
    fsRelay: fsRelayConfigured(),
    storm: mode.get().storm,
    aiAll: mode.get().aiAll,
  }));

  f.get('/api/settings', async () => settings);
  f.patch('/api/settings', async (req) => {
    const b = (req.body ?? {}) as Partial<Settings>;
    if (b.demoAni !== undefined) settings.demoAni = last10(b.demoAni);
    if (b.demoMemberSep !== undefined) settings.demoMemberSep = b.demoMemberSep;
    if (b.demoSmsTo !== undefined) settings.demoSmsTo = sms.demoTo = last10(b.demoSmsTo);
    settingsStore.save(settings);
    return settings;
  });

  // Flow fallback + our pages. Flat strings: WxCC HTTP output mapping prefers scalars.
  f.get('/api/mode', async () => {
    const m = mode.get();
    return { storm: m.storm ? 'true' : 'false', aiAll: m.aiAll ? 'true' : 'false', aiRouting: mode.aiRouting() ? 'true' : 'false', broadcast: m.broadcast, updatedAt: m.updatedAt, updatedBy: m.updatedBy, wxcc: m.wxcc, wxccError: m.wxccError ?? '', history: m.history };
  });
  f.post('/api/mode', async (req) => {
    const b = (req.body ?? {}) as { storm?: boolean | string; aiAll?: boolean | string; by?: string; broadcast?: string };
    const flag = (v: boolean | string | undefined) => (v === undefined ? undefined : v === true || v === 'true');
    const m = await mode.set({ storm: flag(b.storm), aiAll: flag(b.aiAll) }, b.by ?? 'supervisor', b.broadcast);
    return { ...m, aiRouting: mode.aiRouting() };
  });
  // Call review dashboard (public/dashboard.html): AI leg + live-agent leg per call.
  const rangeOf = (q: { from?: string; to?: string; channel?: string }) => {
    const ok = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined);
    const channel = q.channel === 'voice' || q.channel === 'chat' ? (q.channel as 'voice' | 'chat') : undefined;
    return { from: ok(q.from), to: ok(q.to), tz, channel };
  };
  f.get('/api/analytics', async (req) => {
    const q = req.query as { sample?: string; from?: string; to?: string; channel?: string };
    return overview(calls.all(), String(q.sample ?? '1') !== '0', rangeOf(q));
  });
  f.get('/api/analytics/export.csv', async (req, reply) => {
    const q = req.query as { sample?: string; from?: string; to?: string; channel?: string };
    const r = rangeOf(q);
    const name = `horry-customer-review-${r.from ?? 'all'}${r.to && r.to !== r.from ? `-to-${r.to}` : ''}.csv`;
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}"`);
    return callsCsv(calls.all(), String(q.sample ?? '1') !== '0', r);
  });
  f.get('/api/analytics/calls/:id', async (req, reply) => {
    const v = callDetail(calls.all(), (req.params as { id: string }).id);
    return v ?? reply.code(404).send({ error: 'No such call' });
  });
  f.post('/api/calls/:guid/agent-leg', async (req, reply) => {
    const row = calls.get((req.params as { guid: string }).guid);
    if (!row) return reply.code(404).send({ error: 'No such call' });
    try {
      calls.patch(row, { agentLeg: legFromBody((req.body ?? {}) as Record<string, unknown>) });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Storm staffing (supervisor widget): which teams take outage-queue calls.
  f.get('/api/staffing', async () => d.staffing.get());
  f.post('/api/staffing', async (req, reply) => {
    const b = (req.body ?? {}) as { teamIds?: unknown; by?: string };
    const ids = Array.isArray(b.teamIds) ? b.teamIds.map(String) : [];
    try {
      return await d.staffing.set(ids, b.by ?? 'supervisor');
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  f.post('/api/staffing/reset', async (req, reply) => {
    try {
      return await d.staffing.reset(String(((req.body ?? {}) as { by?: string }).by ?? 'supervisor'));
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
  f.post('/api/mode/broadcast', async (req) => mode.setBroadcast(String(((req.body ?? {}) as { text?: string }).text ?? '')));

  // ---- WxCC flow: pre-bridge lookup --------------------------------------------------

  f.get('/api/call-context', async (req) => {
    const { ani = '', dnis = '', id = '' } = req.query as Record<string, string>;
    const m = await memberByAni(ani);
    const st = mode.get();
    const row = calls.seed({ guid: id || `noguid-${Date.now()}`, ani: last10(ani), dnis: last10(dnis), channel: 'voice', stormMode: st.storm, memberSep: m?.MemberSep, memberName: m ? displayName(m) : undefined });
    if (m) calls.step(row, 'identified', `${displayName(m)} — ${displayAddress(m)} (from caller ID)`);
    const o = m ? outages.forMember(m) : undefined;
    console.log(`HORRY VOICE ${row.guid}: call-context ani ${last10(ani)} → ${m ? displayName(m) : 'no member'}${o ? ` (in ${o.id})` : ''} storm=${st.storm}`);
    return {
      found: m ? 'true' : 'false',
      member_name: m ? displayName(m) : '',
      account_number: m?.MemberSep ?? '',
      storm_mode: st.storm ? 'true' : 'false',
      outage_known: o ? 'true' : 'false',
      life_support: m && m.PrioritySvc > 0 ? 'true' : 'false',
    };
  });

  // ---- ElevenLabs webhooks -----------------------------------------------------------

  f.post('/webhooks/elevenlabs/conversation-initiation', async (req, reply) => {
    if (!toolAuth(req, reply)) return;
    const b = (req.body ?? {}) as { caller_id?: string; called_number?: string };
    const ani = String(b.caller_id ?? '');
    const row = calls.findRecentByAni(ani);
    const m = (row && rowMember(row)) ?? (await memberByAni(ani));
    const vars = await dynamicVars(row, m);
    console.log(`HORRY VOICE ${row?.guid ?? 'ANI ' + last10(ani)}: initiation → ${m ? displayName(m) : 'unknown caller'} outage=${vars.outage_known} storm=${vars.storm_mode}`);
    return { type: 'conversation_initiation_client_data', dynamic_variables: vars };
  });

  f.post('/webhooks/elevenlabs/post-call', async (req, reply) => {
    const raw = (req as { rawBody?: string }).rawBody ?? '';
    if (env.ELEVENLABS_WEBHOOK_SECRET && !elevenLabsSignatureOk(raw, req.headers['elevenlabs-signature'] as string | undefined)) {
      return reply.code(401).send({ error: 'bad signature' });
    }
    const p = (req.body ?? {}) as { type?: string; data?: PostCallData };
    if (p.type !== 'post_call_transcription' || !p.data) return { ok: true, ignored: p.type };
    const dv = p.data.conversation_initiation_client_data?.dynamic_variables ?? {};
    const guid = String(dv.sip_call_guid ?? '');
    const row = (guid && calls.get(guid)) || calls.findRecentByAni(String(dv.system__caller_id ?? '')) || calls.resolve(guid, String(dv.system__caller_id ?? ''), mode.get().storm);
    const transcript = (p.data.transcript ?? [])
      .filter((t) => t.message)
      .map((t) => ({ role: t.role === 'agent' ? ('agent' as const) : ('user' as const), text: String(t.message) }));
    calls.patch(row, {
      conversationId: p.data.conversation_id,
      durationSec: p.data.metadata?.call_duration_secs,
      summary: p.data.analysis?.transcript_summary ?? row.summary,
      sentiment: sentimentOf(p.data, transcript),
      transcript,
      // A chat's AI conversation ends at hand-off while the agent is still chatting; chat.ts sets
      // endedAt when the chat closes.
      endedAt: row.endedAt ?? (row.channel === 'chat' ? undefined : new Date().toISOString()),
    });
    console.log(`HORRY VOICE ${row.guid}: post-call ${p.data.conversation_id} ${transcript.length} turns, sentiment ${row.sentiment}`);
    return { ok: true };
  });

  // ---- agent tools -------------------------------------------------------------------

  type ToolBody = { call_guid?: string; caller_id?: string; [k: string]: unknown };
  const tool = (name: string, fn: (row: CallRow, b: ToolBody) => Promise<Record<string, unknown>>) => {
    f.post(`/api/tools/${name}`, async (req, reply) => {
      if (!toolAuth(req, reply)) return;
      const b = (req.body ?? {}) as ToolBody;
      const row = calls.resolve(String(b.call_guid ?? ''), String(b.caller_id ?? ''), mode.get().storm);
      // Caller ID already tells us who this is (incl. the demo phone): bind it so no tool ever
      // sends Savannah back to ask for an account number (Kristen 2026-10-29).
      if (!row.memberSep && (row.ani || b.caller_id)) {
        const m = await memberByAni(row.ani || String(b.caller_id)).catch(() => undefined);
        if (m) calls.patch(row, { memberSep: m.MemberSep, memberName: displayName(m) });
      }
      try {
        const out = await fn(row, b);
        console.log(`HORRY TOOL ${row.guid} ${name} ${JSON.stringify(b).slice(0, 160)} → ${JSON.stringify(out).slice(0, 200)}`);
        return out;
      } catch (err) {
        console.log(`HORRY TOOL ${row.guid} ${name} ERROR ${(err as Error).message}`);
        return { ok: false, error: 'system_unavailable', next_step: 'Apologize that the member system is not responding and offer to connect them with a representative.' };
      }
    });
  };
  const needMember = { ok: false, error: 'member_not_identified', next_step: 'You do not know who this is yet. Ask for the service address (not the account number) and call lookup_member.' };

  tool('lookup-member', async (row, b) => {
    let m: Member | undefined;
    if (b.account_number) m = members.bySep(String(b.account_number));
    else if (b.phone_number) {
      const hit = (await nextgen.accountsInfo(1, String(b.phone_number)))[0];
      m = hit ? members.bySep(String(hit.MemberSep)) : undefined;
    } else if (b.service_address) {
      const hit = (await nextgen.accountsInfo(2, String(b.service_address)))[0];
      m = hit ? members.bySep(String(hit.MemberSep)) : undefined;
    }
    if (!m) {
      const misses = row.journey.filter((j) => j.step === 'lookup_miss').length + 1;
      calls.step(row, 'lookup_miss', JSON.stringify({ phone: b.phone_number, address: b.service_address, account: b.account_number }));
      return {
        found: false,
        next_step: misses >= 2
          ? 'Two lookups failed. Offer to connect them with member services (escalate department member_services, reason account_not_found).'
          : 'No match. Ask for a different detail: the service address, or the phone number on the account. Ask for the account number only if they offer it.',
      };
    }
    calls.patch(row, { memberSep: m.MemberSep, memberName: displayName(m) });
    calls.step(row, 'identified', `${displayName(m)} — ${displayAddress(m)} (lookup)`);
    return { found: true, member_name: displayName(m), first_name: m.FirstName, service_address: displayAddress(m), say_address_as: spokenAddress(m), next_step: `Confirm the service address with the caller (say it as: ${spokenAddress(m)}), then continue.` };
  });

  tool('get-outage-status', async (row) => {
    const m = rowMember(row);
    if (!m) return needMember;
    const o = outages.forMember(m);
    if (!o) {
      calls.step(row, 'outage_check', 'no known outage at this location');
      return { known: false, next_step: 'No outage is on record at their location. Ask the triage questions (whole house or part, neighbours out, anything seen or heard — and any hazards), then call report_outage.' };
    }
    calls.patch(row, { outageId: o.id });
    calls.step(row, 'outage_known', `${o.id}: ${o.area}, ~${o.customers} members, ETR ${spokenEtr(o.etr, tz)}`, 'outage_known');
    return {
      known: true,
      area: o.area,
      members_affected: o.customers,
      cause: o.cause,
      crew_status: o.crew,
      estimated_restoration: spokenEtr(o.etr, tz),
      next_step: 'Tell them it is known (area, members affected, cause/crew, estimate — estimates can change). Then offer a text or a call when power is restored.',
    };
  });

  tool('report-outage', async (row, b) => {
    const m = rowMember(row);
    if (!m) return needMember;
    const hazard = String(b.hazard ?? 'none');
    const o = outages.report(m, { hazard, wholeHouse: String(b.whole_house ?? ''), neighbors: String(b.neighbors_out ?? ''), text: String(b.details ?? '') });
    calls.patch(row, { outageId: o.id });
    calls.step(row, 'outage_reported', `${o.id} (${o.source}) hazard=${hazard} whole_house=${b.whole_house} neighbors=${b.neighbors_out}${b.details ? ` — ${b.details}` : ''}`, 'outage_reported');
    void nextgen.addNote(m.MemberSep, `AI outage report ${o.id}: hazard=${hazard}, whole house=${b.whole_house}, neighbours=${b.neighbors_out}. ${b.details ?? ''}`, 'O').catch(() => undefined);
    const ref = o.id.replace(/\D/g, '').slice(-4);
    const clustered = o.reports > 1 && !o.location;
    if (hazard !== 'none') {
      return { reference: digits(ref), hazard_reported: true, next_step: 'HAZARD: give the stay-away safety instruction, then say your one hold sentence and call escalate (department outage, urgency emergency).' };
    }
    return {
      reference: digits(ref),
      several_reports_in_area: clustered,
      partial_outage: String(b.whole_house) === 'partial',
      next_step: `Read back reference ${digits(ref)}.${clustered ? " Mention we're seeing several reports from their area and a crew has been dispatched." : ''}${String(b.whole_house) === 'partial' ? ' Partial outage: suggest checking the main breaker; the co-op will still check the service.' : ''} Then offer a text or call when power is restored.`,
    };
  });

  tool('subscribe-restoration', async (row, b) => {
    const m = rowMember(row);
    if (!m) return needMember;
    const o = (row.outageId && outages.get(row.outageId)?.status === 'active' ? outages.get(row.outageId) : undefined) ?? outages.forMember(m);
    if (!o) return { ok: false, next_step: 'There is no open outage for this location yet — report it first with report_outage, then subscribe.' };
    const channel = String(b.channel) === 'voice' ? 'voice' : 'sms';
    const phone = last10(String(b.phone_number ?? '')) || textNumber(m) || last10(row.ani);
    const sub = outages.subscribe({ outageId: o.id, memberSep: m.MemberSep, memberName: displayName(m), address: displayAddress(m), phone, channel, createdBy: 'ai' });
    calls.step(row, 'subscribed', `${channel} to ${phone} for ${o.id}`, 'restoration_signup');
    if (channel === 'sms') {
      void sms.send(phone, `Horry Electric: you're signed up for restoration updates for ${displayAddress(m)} (ref ${o.id}). Current estimate: ${spokenEtr(o.etr, tz)}. Reply STOP to opt out.`, 'signup_confirm');
    }
    return { ok: true, subscription: sub.id, channel, phone: digits(phone), next_step: `Confirm: they will get a ${channel === 'sms' ? 'text' : 'call'} at ${digits(phone)} when power is restored, and a text if the estimate changes. Ask if there is anything else.` };
  });

  tool('get-billing', async (row) => {
    const m = rowMember(row);
    if (!m) return needMember;
    const fin = await nextgen.financial(m.MemberSep);
    if (!fin) return { ok: false, next_step: 'Billing details are unavailable right now; offer a representative.' };
    const now = new Date();
    const sum = (days: { TotalEnergy: string }[]) => days.reduce((n, x) => n + Number(x.TotalEnergy), 0);
    const [cur, ly] = await Promise.all([
      nextgen.usage(m.MemberSep, new Date(now.getTime() - 30 * 86400_000), now),
      nextgen.usage(m.MemberSep, new Date(now.getTime() - 395 * 86400_000), new Date(now.getTime() - 365 * 86400_000)),
    ]);
    const kwh = sum(cur);
    const kwhLy = sum(ly);
    calls.step(row, 'billing', `due ${money(fin.AmountDue)} by ${fin.DueDate}, past due ${money(fin.PastDueAmount)}`, 'billing_inquiry');
    return billingSummary(fin, m, kwh, kwhLy);
  });

  tool('request-payment-extension', async (row, b) => {
    const m = rowMember(row);
    if (!m) return needMember;
    const fin = await nextgen.financial(m.MemberSep);
    if (!fin?.AllowArrangementFlag) return { approved: false, next_step: 'An extension is not available on this account. Offer a payment, or a representative to discuss options.' };
    const conf = await nextgen.requestExtension(m.MemberSep, String(b.pay_by_date), fin.AmountDue);
    if (!conf) return { approved: false, next_step: 'The extension was declined by the co-op rules. Offer a representative.' };
    calls.step(row, 'extension', `extension to ${b.pay_by_date}, confirmation ${conf}`, 'payment_extension');
    return { approved: true, confirmation: digits(conf), pay_by: String(b.pay_by_date), next_step: `Confirm the extension to ${b.pay_by_date} and read confirmation ${digits(conf)} digit by digit. Service will not be disconnected while the extension is in place.` };
  });

  tool('send-payment-link', async (row, b) => {
    const m = rowMember(row);
    if (!m) return needMember;
    const amount = Math.round(Number(b.amount) * 100) / 100;
    if (!(amount > 0)) return { ok: false, next_step: 'Ask for the amount they want to pay.' };
    const phone = last10(String(b.phone_number ?? '')) || last10(row.ani) || last10(m.CellPhone);
    const s = payments.create({ guid: row.guid, memberSep: m.MemberSep, memberName: displayName(m), amount, method: 'link', phone, initiatedBy: 'ai' });
    calls.patch(row, { paymentId: s.id });
    await sms.send(phone, `Horry Electric: here is your secure payment link for ${money(amount)} on account ending ${m.MemberSep.slice(-4)}: ${baseUrl()}/pay.html?s=${s.id}`, 'payment_link');
    calls.step(row, 'payment_link', `${money(amount)} link texted to ${phone}`, 'payment');
    return { ok: true, amount, phone: digits(phone), next_step: `Tell them the link is on its way to ${digits(phone)}; they can pay now while you stay on the line. Then call check_payment_status.` };
  });

  tool('pay-with-card-on-file', async (row, b) => {
    const m = rowMember(row);
    if (!m) return needMember;
    const amount = Math.round(Number(b.amount) * 100) / 100;
    if (!(amount > 0)) return { ok: false, next_step: 'Ask for the amount they want to pay.' };
    const fin = await nextgen.financial(m.MemberSep);
    if (!fin?.CardProfileExists) return { ok: false, card_on_file: false, next_step: 'There is no card on file. Offer the secure text link (send_payment_link) instead.' };
    const s = payments.create({ guid: row.guid, memberSep: m.MemberSep, memberName: displayName(m), amount, method: 'card_on_file', phone: last10(row.ani), initiatedBy: 'ai' });
    calls.patch(row, { paymentId: s.id });
    await payments.payWithProfile(s);
    if (s.status !== 'approved') {
      calls.step(row, 'payment_declined', `${money(amount)} card on file declined`);
      return { status: 'declined', next_step: 'The card on file was declined. Offer the secure text link to use a different card.' };
    }
    calls.step(row, 'payment', `${money(amount)} approved — card on file ${s.cardType} ending ${s.last4}, confirmation ${s.confirmation}`, 'payment');
    return { status: 'approved', amount, card: `${cardBrand(s.cardType ?? null)} ending ${digits(s.last4 ?? '')}`, confirmation: digits(s.confirmation ?? ''), next_step: `Confirm the ${money(amount)} payment on the ${cardBrand(s.cardType ?? null)} ending ${digits(s.last4 ?? '')} and read confirmation ${digits(s.confirmation ?? '')}.` };
  });

  tool('start-keypad-payment', async (row, b) => {
    calls.step(row, 'keypad_unavailable', `keypad payment requested (${money(Number(b.amount))}) — Twilio Pay not configured`);
    return { available: false, next_step: 'Keypad payments are not available on this line right now. Offer to text a secure payment link instead (send_payment_link).' };
  });

  tool('check-payment-status', async (row) => {
    const s = (row.paymentId && payments.get(row.paymentId)) || payments.latestFor(row.guid);
    if (!s) return { status: 'none', next_step: 'No payment has been started. Offer a secure payment link.' };
    if (s.status === 'approved') {
      if (!row.journey.some((j) => j.step === 'payment')) calls.step(row, 'payment', `${money(s.amount)} approved — ${s.cardType} ending ${s.last4}, confirmation ${s.confirmation}`, 'payment');
      return { status: 'approved', amount: s.amount, card: `${s.cardType} ending ${digits(s.last4 ?? '')}`, confirmation: digits(s.confirmation ?? ''), next_step: `Confirm the ${money(s.amount)} payment on the ${s.cardType} ending ${digits(s.last4 ?? '')} and read confirmation ${digits(s.confirmation ?? '')}.` };
    }
    if (s.status === 'declined') return { status: 'declined', attempts: s.attempts, next_step: s.attempts >= 2 ? 'Declined twice: offer a representative (escalate department billing, reason payment_declined).' : 'The card was declined. They can try another card from the same link.' };
    return { status: s.status, next_step: s.status === 'expired' ? 'The link expired. Offer to send a new one.' : 'Still waiting — chat briefly (do they see the text?) and check again in a few seconds.' };
  });

  tool('escalate', async (row, b) => {
    const m = rowMember(row);
    const esc = { department: String(b.department ?? 'member_services'), urgency: String(b.urgency ?? 'normal'), reason: String(b.reason ?? 'other'), summary: String(b.summary ?? ''), at: new Date().toISOString() };
    calls.patch(row, { escalation: esc });
    calls.step(row, 'escalated', `${esc.department} / ${esc.urgency}: ${esc.reason}`, esc.department === 'outage' ? 'outage_escalation' : 'escalation');
    const data: Record<string, string> = {
      escalate: 'true',
      department: esc.department,
      urgency: esc.urgency,
      reason: esc.reason,
      summary: esc.summary.slice(0, 240),
      caller_name: m ? displayName(m) : '',
      account_number: m?.MemberSep ?? '',
      service_address: m ? displayAddress(m) : '',
      outage_id: row.outageId ?? '',
    };
    // Web chat: chat.ts sees row.escalation and queues the chat for an agent. There is no phone
    // leg to relay, and end_call would end the chat itself.
    if (row.channel === 'chat') return { ok: true, next_step: 'A member of our team is joining this chat. Say nothing further and do not call end_call.' };
    const ok = await relayResultToFreeswitch(row.guid, data);
    // end_call lets her finish the sentence still playing, then drops the AI leg so the
    // controller hands the call back at once (no dead air until its grace cap).
    return { ok, next_step: 'Say nothing further. Call end_call now — the caller is being connected.' };
  });

  tool('wrap-up', async (row, b) => {
    const tags = String(b.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    calls.patch(row, { outcome: String(b.outcome ?? ''), tags: [...new Set([...row.tags, ...tags])] });
    calls.step(row, 'wrapped', String(b.outcome ?? ''));
    if (row.channel !== 'chat') await relayResultToFreeswitch(row.guid, { escalate: 'false', outcome: String(b.outcome ?? '').slice(0, 240) });
    return { ok: true, next_step: 'Say a one-sentence goodbye, then call end_call.' };
  });

  // ---- payments (pay page) -----------------------------------------------------------

  f.get('/api/pay/:id', async (req, reply) => {
    const s = payments.get((req.params as { id: string }).id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    return { id: s.id, memberName: s.memberName, account: `•••${s.memberSep.slice(-4)}`, amount: s.amount, status: s.status, last4: s.last4, confirmation: s.confirmation };
  });
  // The page sends ONLY a token + last four + brand (it never posts the card number).
  f.post('/api/pay/:id/complete', async (req, reply) => {
    const b = (req.body ?? {}) as { token?: string; last4?: string; brand?: string };
    if (!b.token || !/^\d{4}$/.test(String(b.last4 ?? ''))) return reply.code(400).send({ error: 'token and last4 required' });
    try {
      const s = await payments.complete((req.params as { id: string }).id, b.token, String(b.last4), String(b.brand ?? 'VISA'));
      return { status: s.status, confirmation: s.confirmation, last4: s.last4 };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  f.get('/api/payments', async () => ({ payments: payments.all() }));

  // ---- outages / subscriptions / sms -------------------------------------------------

  f.get('/api/outages', async () => ({
    outages: outages.all().map((o) => ({ ...o, etrText: spokenEtr(o.etr, tz), subscribers: outages.subsFor(o.id).length })),
  }));
  f.post('/api/outages/:id/etr', async (req, reply) => {
    const b = (req.body ?? {}) as { etr?: string; addMinutes?: number };
    const o = outages.get((req.params as { id: string }).id);
    if (!o) return reply.code(404).send({ error: 'not found' });
    const base = o.etr ? Date.parse(o.etr) : Date.now();
    const etr = b.etr ?? (b.addMinutes ? new Date(Math.max(base, Date.now()) + b.addMinutes * 60_000).toISOString() : null);
    return outages.setEtr(o.id, etr);
  });
  f.post('/api/outages/:id/restore', async (req, reply) => {
    const o = outages.restore((req.params as { id: string }).id);
    return o ?? reply.code(404).send({ error: 'not found' });
  });
  f.get('/api/subscriptions', async () => ({ subscriptions: outages.subscriptions() }));
  f.get('/api/sms', async () => ({ messages: sms.outbox(), live: twilioConfigured() }));

  // Inbound texts: OUT (still out / new outage), STATUS, STOP. TwiML reply.
  f.post('/webhooks/twilio/sms', async (req, reply) => {
    const params = (req.body ?? {}) as Record<string, string>;
    if (!twilioSignatureOk(`${baseUrl()}/webhooks/twilio/sms`, params, req.headers['x-twilio-signature'] as string | undefined)) {
      return reply.code(403).send('bad signature');
    }
    const from = last10(params.From);
    const text = String(params.Body ?? '').trim();
    sms.recordInbound(from, text);
    const answer = await handleInboundText(from, text);
    reply.header('content-type', 'text/xml');
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${answer ? `<Message>${escapeXml(answer)}</Message>` : ''}</Response>`;
  });

  async function handleInboundText(from: string, text: string): Promise<string> {
    const word = text.toUpperCase().split(/\s+/)[0] ?? '';
    const m = await memberByAni(from);
    if (word === 'STOP') return '';
    if (!m) return 'Horry Electric: we could not find an account for this number. To report an outage call 843-369-2212.';
    if (word === 'OUT' || word === 'NO') {
      const sub = outages.lastNotifiedFor(from);
      const nested = Boolean(sub && outages.get(sub.outageId)?.status === 'restored');
      if (sub && nested) outages.updateSub(sub.id, { status: 'still_out', reply: text });
      const o = outages.report(m, { hazard: 'none', wholeHouse: 'yes', neighbors: 'unknown', text: `SMS: ${text}` }, nested);
      if (nested) outages.subscribe({ outageId: o.id, memberSep: m.MemberSep, memberName: displayName(m), address: displayAddress(m), phone: from, channel: 'sms', createdBy: 'sms' });
      return nested
        ? `Horry Electric: thanks ${m.FirstName} — we've opened a new ticket (${o.id}) for ${displayAddress(m)} and a crew will check your service. We'll text you when it's fixed.`
        : `Horry Electric: outage reported for ${displayAddress(m)} (${o.id}). Estimate: ${spokenEtr(o.etr, tz)}. We'll text you updates.`;
    }
    if (word === 'STATUS') {
      const o = outages.forMember(m);
      return o ? `Horry Electric: ${o.area} — ${o.customers} members out, ${o.crew}. Estimate: ${spokenEtr(o.etr, tz)}.` : `Horry Electric: no outage on record for ${displayAddress(m)}. Reply OUT to report one.`;
    }
    const sub = outages.lastNotifiedFor(from);
    if (sub && /^(YES|Y|ON|BACK)/.test(word)) {
      outages.updateSub(sub.id, { status: 'confirmed_on', reply: text });
      return 'Horry Electric: great — thanks for letting us know!';
    }
    return 'Horry Electric: reply OUT to report an outage, STATUS for outage status, or call 843-369-2212.';
  }

  // ---- members / calls (widgets + console) -------------------------------------------

  f.get('/api/members', async () => ({
    members: members.all().map((m) => ({ memberSep: m.MemberSep, name: displayName(m), address: displayAddress(m), phone: m.CellPhone, inOutage: Boolean(outages.forMember(m)), pastDue: m.PastDueAmount })),
  }));

  // Screen-pop card: ?ani= or ?sep= (also returns the latest AI call row for that caller).
  f.get('/api/member', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const m = q.sep ? members.bySep(q.sep) : q.ani ? await memberByAni(q.ani) : undefined;
    if (!m) return reply.code(404).send({ found: false });
    const fin = await nextgen.financial(m.MemberSep);
    const o = outages.forMember(m);
    const call = q.guid ? calls.get(q.guid) : calls.all().find((r) => r.memberSep === m.MemberSep);
    return {
      found: true,
      member: { memberSep: m.MemberSep, name: displayName(m), address: displayAddress(m), phone: m.CellPhone, email: m.EmailAddr, rate: m.Rate, meter: m.Meter, lifeSupport: m.PrioritySvc > 0 },
      billing: fin,
      outage: o ? { ...o, etrText: spokenEtr(o.etr, tz) } : null,
      lastCall: call ?? null,
      payments: payments.all().filter((p) => p.memberSep === m.MemberSep).slice(0, 5),
    };
  });

  f.get('/api/calls', async () => ({ calls: calls.all().slice(0, 100) }));
  f.get('/api/calls/:guid', async (req, reply) => calls.get((req.params as { guid: string }).guid) ?? reply.code(404).send({ error: 'not found' }));

  // WxCC flow, after the bridge: the AI's outcome as flat strings for one HTTP node (Crete's
  // /api/intake pattern) — no parsing of BYE headers in Designer. Unknown guid = not escalated.
  f.get('/api/intake/:guid', async (req) => {
    const row = calls.get((req.params as { guid: string }).guid);
    const m = row ? rowMember(row) : undefined;
    const esc = row?.escalation;
    return {
      escalate: esc ? 'true' : 'false',
      department: esc?.department ?? '',
      urgency: esc?.urgency ?? '',
      reason: esc?.reason ?? '',
      summary: (esc?.summary ?? row?.summary ?? '').slice(0, 240),
      member_name: row?.memberName ?? '',
      account_number: row?.memberSep ?? '',
      service_address: m ? displayAddress(m) : '',
      outage_id: row?.outageId ?? '',
    };
  });

  f.post('/api/reset', async () => {
    outages.reset();
    calls.reset();
    members.reset();
    return { ok: true, note: 'outages re-seeded, calls cleared, member balances restored' };
  });
}

// ---- helpers --------------------------------------------------------------------------

interface PostCallData {
  conversation_id?: string;
  transcript?: { role?: string; message?: string | null }[];
  metadata?: { call_duration_secs?: number };
  analysis?: { transcript_summary?: string; data_collection_results?: Record<string, { value?: unknown }> };
  conversation_initiation_client_data?: { dynamic_variables?: Record<string, unknown> };
}

function billingSummary(fin: Financial, m: Member, kwh: number, kwhLy: number) {
  const pct = kwhLy ? Math.round(((kwh - kwhLy) / kwhLy) * 100) : 0;
  return {
    amount_due: fin.AmountDue,
    due_date: fin.DueDate,
    past_due: fin.PastDueAmount,
    cutoff_date: fin.CutOffDate ?? 'none',
    on_cutoff_list: fin.OnCutOffList,
    last_payment: `${money(fin.LastPayment)} on ${fin.PaymentDate}`,
    extension_allowed: fin.AllowArrangementFlag,
    bank_draft: fin.ChkProfileExists,
    rest_easy_levelized: (fin.BudgetOrLevelizedBillAmount ?? 0) > 0 ? money(fin.BudgetOrLevelizedBillAmount) : 'no',
    card_on_file: fin.CardProfileExists ? `${cardBrand(m.CardBrand)} ending ${digits(fin.Last4CcDigits ?? '')}` : 'none',
    usage_last_30_days_kwh: kwh,
    usage_same_period_last_year_kwh: kwhLy,
    usage_change_vs_last_year: `${pct >= 0 ? 'up' : 'down'} ${Math.abs(pct)} percent`,
    next_step: fin.PastDueAmount > 0
      ? `Past due ${money(fin.PastDueAmount)}${fin.CutOffDate ? `; cut-off date ${fin.CutOffDate}` : ''}. Explain gently; offer a payment (secure link) or, if extension_allowed, an extension.`
      : `Give the amount due and due date in one sentence${fin.ChkProfileExists ? ' (it is set to draft automatically)' : ''}. Offer a payment only if they want to pay.`,
    member_first_name: m.FirstName,
  };
}

function sentimentOf(d: PostCallData, transcript: { role: string; text: string }[]): 'positive' | 'neutral' | 'negative' {
  const dc = d.analysis?.data_collection_results ?? {};
  const v = String(dc.sentiment?.value ?? '').toLowerCase();
  if (v === 'positive' || v === 'neutral' || v === 'negative') return v;
  const user = transcript.filter((t) => t.role === 'user').map((t) => t.text.toLowerCase()).join(' ');
  const neg = (user.match(/\b(ridiculous|angry|again|unacceptable|frustrat|terrible|still out|hours|no one)\b/g) ?? []).length;
  const pos = (user.match(/\b(thank|great|perfect|appreciate|awesome|wonderful)\b/g) ?? []).length;
  return neg > pos ? 'negative' : pos > 0 ? 'positive' : 'neutral';
}

/** ElevenLabs post-call HMAC: header `t=<ts>,v0=<hex hmac-sha256(secret, "<ts>.<body>")>`. */
function elevenLabsSignatureOk(raw: string, header: string | undefined): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  if (!parts.t || !parts.v0) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 30 * 60) return false;
  const expected = createHmac('sha256', env.ELEVENLABS_WEBHOOK_SECRET!).update(`${parts.t}.${raw}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v0);
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}
