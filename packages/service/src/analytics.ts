// Call review analytics (discovery item 5: "AI that tags calls from the conversation
// instead of one manual code"; Kristen 2026-10-28: per-call view + overall topics +
// AI containment). Every call is read as ONE story: Savannah's leg (journey, tags,
// summary, sentiment from the ElevenLabs post-call webhook) plus, when she handed off,
// the live agent's leg (Cisco AI Assistant wrap-up summary — agent-summaries.ts).
//
// Topics are derived, not hand-picked: tool steps and the escalation reason first,
// then keywords in both summaries. A seeded SAMPLE storm day (deterministic, clearly
// flagged sample) fills the dashboard so it reads like a real storm before any live
// calls exist; live calls are overlaid and marked live.
import type { AgentLeg, CallRow } from './calls.js';

export const TOPICS = [
  'Wire down / safety',
  'Outage report',
  'Outage status',
  'Bill payment',
  'Payment extension',
  'High bill',
  'Billing question',
  'Start / stop service',
  'Other',
] as const;
export type Topic = (typeof TOPICS)[number];

export interface CallView {
  id: string;
  sample: boolean;
  startedAt: string;
  member: string;
  town: string;
  channel: 'voice' | 'chat';
  primaryTopic: Topic;
  topics: Topic[];
  contained: boolean; // Savannah finished it, no person needed
  sentiment: 'positive' | 'neutral' | 'negative';
  durationSec: number;
  aiSummary: string;
  restorationSignup: boolean;
  payment: boolean;
  journey: { at: string; step: string; detail: string }[];
  escalation?: { department: string; urgency: string; reason: string; summary: string };
  agentLeg?: AgentLeg;
  transcript?: { role: 'agent' | 'user'; text: string }[];
}

// ---- classification --------------------------------------------------------------

export function topicsFor(tags: string[], reason: string, text: string): Topic[] {
  const t = new Set<Topic>();
  const low = text.toLowerCase();
  if (reason === 'wires_down' || /wire[s]? down|line down|sparking|downed line/.test(low)) t.add('Wire down / safety');
  if (tags.includes('outage_reported')) t.add('Outage report');
  if (tags.includes('outage_known') || tags.includes('restoration_signup') || /restor|estimate|when will/.test(low)) t.add('Outage status');
  if (tags.includes('payment')) t.add('Bill payment');
  if (tags.includes('payment_extension') || /extension|arrangement/.test(low)) t.add('Payment extension');
  if (/high bill|higher than|usage/.test(low)) t.add('High bill');
  if (tags.includes('billing_inquiry') && !t.has('High bill')) t.add('Billing question');
  if (/start service|stop service|moving|new service|transfer service/.test(low)) t.add('Start / stop service');
  if (!t.size) t.add('Other');
  return TOPICS.filter((x) => t.has(x)); // priority order: the first is the primary topic
}

function fromRow(r: CallRow): CallView {
  const text = [r.summary, r.escalation?.summary, r.agentLeg?.summary.reason, r.agentLeg?.summary.actions].filter(Boolean).join(' ');
  const topics = topicsFor(r.tags, r.escalation?.reason ?? '', text);
  const end = r.endedAt ? Date.parse(r.endedAt) : Date.now();
  return {
    id: r.guid,
    sample: false,
    startedAt: r.startedAt,
    member: r.memberName ?? 'Unknown caller',
    town: '',
    channel: r.channel,
    primaryTopic: topics[0] ?? 'Other',
    topics,
    contained: !r.escalation,
    sentiment: r.sentiment ?? 'neutral',
    durationSec: r.durationSec ?? Math.max(0, Math.round((end - Date.parse(r.startedAt)) / 1000)),
    aiSummary: r.summary ?? r.outcome ?? (r.endedAt ? '' : 'Call in progress'),
    restorationSignup: r.tags.includes('restoration_signup'),
    payment: r.tags.includes('payment'),
    journey: r.journey,
    ...(r.escalation ? { escalation: r.escalation } : {}),
    ...(r.agentLeg ? { agentLeg: r.agentLeg } : {}),
    ...(r.transcript ? { transcript: r.transcript } : {}),
  };
}

// ---- sample storm day --------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['James', 'Mary', 'Robert', 'Patricia', 'Willie', 'Linda', 'Charles', 'Barbara', 'Thomas', 'Shirley', 'Larry', 'Brenda', 'Jerry', 'Carolyn', 'Wayne', 'Gloria', 'Tony', 'Tammy', 'Dale', 'Angela', 'Keith', 'Teresa', 'Marcus', 'Denise'];
const LAST = ['Johnson', 'Hardee', 'Graham', 'Lewis', 'McCray', 'Skipper', 'Floyd', 'Jordan', 'Cox', 'Hucks', 'Strickland', 'Grainger', 'Prince', 'Bellamy', 'Vereen', 'Causey', 'Todd', 'Hughes', 'Gore', 'Faircloth'];
const TOWNS = ['Socastee', 'Conway', 'Aynor', 'Loris', 'Longs', 'Myrtle Beach', 'Carolina Forest', 'Galivants Ferry', 'Green Sea'];

// Storm-day mix: share of calls, and how often Savannah finishes the call herself.
const MIX: { topic: Topic; share: number; contain: number }[] = [
  { topic: 'Outage status', share: 0.34, contain: 0.92 },
  { topic: 'Outage report', share: 0.22, contain: 0.84 },
  { topic: 'Wire down / safety', share: 0.05, contain: 0 },
  { topic: 'Bill payment', share: 0.12, contain: 0.78 },
  { topic: 'Payment extension', share: 0.07, contain: 0.82 },
  { topic: 'Billing question', share: 0.08, contain: 0.55 },
  { topic: 'High bill', share: 0.05, contain: 0.3 },
  { topic: 'Start / stop service', share: 0.03, contain: 0.2 },
  { topic: 'Other', share: 0.04, contain: 0.35 },
];
// Calls per hour, 6 AM to 10 PM: a storm line comes through mid-afternoon.
const HOURLY = [4, 6, 8, 9, 10, 11, 12, 14, 18, 34, 38, 31, 24, 17, 12, 8, 5];

const AI_TEXT: Record<Topic, string> = {
  'Outage status': 'Confirmed the service address. The outage was already reported (tree on the line); gave the estimated restoration time and signed the member up for a restoration text.',
  'Outage report': 'Member reported power out at the whole house with neighbors also out. Created a new outage report and signed the member up for a restoration text.',
  'Wire down / safety': 'Member reported a line down near the road. Told them to stay at least 35 feet away and sent the call to the outage team as an emergency.',
  'Bill payment': 'Read the balance and due date from the billing system. Member paid with the card on file; gave the confirmation number.',
  'Payment extension': 'Member asked for more time to pay. Set up a payment extension in the billing system and read back the new date.',
  'High bill': 'Member said this bill is higher than usual. Compared usage with last year: a colder month and more kWh.',
  'Billing question': 'Answered a question about the bill amount, due date and late fee.',
  'Start / stop service': 'Member is moving and wants service at a new address. Collected both addresses and noted the account.',
  Other: 'Member asked a general question about co-op membership. Savannah answered it from the co-op FAQ.',
};

const AGENT_LEG: Record<Topic, { code: string; reason: string; actions: string; followUp: string }> = {
  'Outage status': { code: 'Outage - Status', reason: 'Member wanted more detail on the restoration estimate.', actions: 'Checked the outage map and confirmed crews are on site.', followUp: 'None. Restoration text already set up.' },
  'Outage report': { code: 'Outage - Report', reason: 'Member reported an outage that needed more detail (partial power).', actions: 'Logged a single-location ticket for a service-line check.', followUp: 'Crew to check the service drop.' },
  'Wire down / safety': { code: 'Outage - Wire Down', reason: 'Downed line reported near the road.', actions: 'Created an emergency ticket and dispatched a crew. Repeated the safety instructions.', followUp: 'Crew dispatched. Member will call 911 if anything sparks.' },
  'Bill payment': { code: 'Billing - Payment', reason: 'Card on file was declined.', actions: 'Sent the member to secure pay with a new card. Payment approved.', followUp: 'None.' },
  'Payment extension': { code: 'Billing - Payment Arrangement', reason: 'Member needed a longer arrangement than self-service allows.', actions: 'Set a two-part arrangement and noted the account.', followUp: 'Second payment due in two weeks.' },
  'High bill': { code: 'Billing - High Bill Review', reason: 'Member disputed a high bill.', actions: 'Reviewed usage history and explained weather impact. Offered a free energy audit.', followUp: 'Energy Services to call about the audit.' },
  'Billing question': { code: 'Billing - Inquiry', reason: 'Member asked about a late fee.', actions: 'Explained the fee and waived it once as a courtesy.', followUp: 'None.' },
  'Start / stop service': { code: 'Service - Transfer', reason: 'Member is moving to a new address.', actions: 'Scheduled service to stop at the old address and start at the new one.', followUp: 'Deposit letter to be mailed.' },
  Other: { code: 'General - Inquiry', reason: 'General question about co-op membership.', actions: 'Answered and sent a link to the capital credits page.', followUp: 'None.' },
};

let sampleCache: { day: string; views: CallView[] } | null = null;

/** ~250 calls on the day before today, the same every time for a given date. */
export function sampleStormDay(now = new Date()): CallView[] {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const key = day.toDateString();
  if (sampleCache?.day === key) return sampleCache.views;
  const r = rng(20261104);
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)] as T;
  const views: CallView[] = [];
  HOURLY.forEach((n, i) => {
    for (let k = 0; k < n; k++) {
      let x = r();
      const m = MIX.find((t) => (x -= t.share) < 0) ?? MIX[0]!;
      const contained = r() < m.contain;
      const start = new Date(day);
      start.setHours(6 + i, Math.floor(r() * 60), Math.floor(r() * 60));
      const s = r();
      const sentiment: CallView['sentiment'] = contained
        ? s < 0.38 ? 'positive' : s < 0.9 ? 'neutral' : 'negative'
        : s < 0.18 ? 'positive' : s < 0.62 ? 'neutral' : 'negative';
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      const town = m.topic.startsWith('Outage') || m.topic === 'Wire down / safety' ? pick(['Socastee', 'Socastee', 'Carolina Forest', 'Aynor', 'Conway']) : pick(TOWNS);
      const ai = Math.round(70 + r() * 150);
      const agentSec = contained ? 0 : Math.round(120 + r() * 360);
      const end = new Date(start.getTime() + (ai + agentSec) * 1000);
      const topics: Topic[] = [m.topic];
      if (m.topic === 'Outage report' && r() < 0.3) topics.push('Outage status');
      const leg = AGENT_LEG[m.topic];
      const id = `sample-${String(views.length + 1).padStart(3, '0')}`;
      views.push({
        id,
        sample: true,
        startedAt: start.toISOString(),
        member: name,
        town,
        channel: r() < 0.08 ? 'chat' : 'voice',
        primaryTopic: m.topic,
        topics,
        contained,
        sentiment,
        durationSec: ai + agentSec,
        aiSummary: contained ? AI_TEXT[m.topic] : `${AI_TEXT[m.topic].split('.')[0]}. ${leg.reason} Sent to a live agent.`,
        restorationSignup: m.topic.startsWith('Outage') && contained && r() < 0.75,
        payment: m.topic === 'Bill payment' && contained,
        journey: [
          { at: start.toISOString(), step: 'identified', detail: `${name}, ${town} (from caller ID)` },
          { at: new Date(start.getTime() + ai * 500).toISOString(), step: m.topic.toLowerCase().replace(/[^a-z]+/g, '_'), detail: AI_TEXT[m.topic].split('.')[0] ?? '' },
          ...(contained
            ? [{ at: new Date(start.getTime() + ai * 1000).toISOString(), step: 'wrapped', detail: 'Resolved by Savannah' }]
            : [{ at: new Date(start.getTime() + ai * 1000).toISOString(), step: 'escalated', detail: leg.reason }]),
        ],
        ...(contained
          ? {}
          : {
              escalation: {
                department: m.topic.startsWith('Outage') || m.topic === 'Wire down / safety' ? 'outage' : m.topic === 'Start / stop service' || m.topic === 'Other' ? 'member_services' : 'billing',
                urgency: m.topic === 'Wire down / safety' ? 'emergency' : 'normal',
                reason: m.topic === 'Wire down / safety' ? 'wires_down' : 'asked_for_person',
                summary: leg.reason,
              },
              agentLeg: {
                agentName: pick(['Tonya B.', 'Mike R.', 'Ashley C.', 'Derrick H.', 'Kim S.', 'Billing team: Rhonda P.', 'Engineering: Scott L.']),
                team: m.topic.startsWith('Outage') || m.topic === 'Wire down / safety' ? pick(['Member Services', 'Member Services', 'Engineering', 'Billing & Collections']) : 'Member Services',
                endedAt: end.toISOString(),
                wrapUpCode: leg.code,
                summary: { reason: leg.reason, actions: leg.actions, status: 'Resolved', followUp: leg.followUp },
                source: 'simulated',
              },
            }),
      });
    }
  });
  sampleCache = { day: key, views };
  return views;
}

// ---- aggregation -------------------------------------------------------------------

export interface Overview {
  generatedAt: string;
  sample: boolean;
  kpis: {
    calls: number;
    contained: number;
    toAgent: number;
    containmentRate: number; // 0..1
    negativePct: number; // 0..1
    restorationSignups: number;
    payments: number;
    avgAiSec: number;
    live: number;
  };
  topics: { topic: Topic; contained: number; toAgent: number }[];
  byHour: { hour: number; contained: number; toAgent: number }[];
  sentiment: { positive: number; neutral: number; negative: number };
  wrapUps: { code: string; count: number }[];
  calls: Omit<CallView, 'journey' | 'transcript'>[];
}

export function viewsFor(rows: CallRow[], includeSample: boolean): CallView[] {
  const live = rows.filter((r) => !r.guid.startsWith('adhoc-') || r.journey.length > 0).map(fromRow);
  return [...live, ...(includeSample ? sampleStormDay() : [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function overview(rows: CallRow[], includeSample: boolean): Overview {
  const views = viewsFor(rows, includeSample);
  const contained = views.filter((v) => v.contained).length;
  const topics = TOPICS.map((topic) => ({
    topic,
    contained: views.filter((v) => v.primaryTopic === topic && v.contained).length,
    toAgent: views.filter((v) => v.primaryTopic === topic && !v.contained).length,
  }))
    .filter((t) => t.contained + t.toAgent > 0)
    .sort((a, b) => b.contained + b.toAgent - (a.contained + a.toAgent));
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, contained: 0, toAgent: 0 }));
  for (const v of views) {
    const h = byHour[new Date(v.startedAt).getHours()]!;
    if (v.contained) h.contained++;
    else h.toAgent++;
  }
  const first = byHour.findIndex((h) => h.contained + h.toAgent > 0);
  const last = 23 - [...byHour].reverse().findIndex((h) => h.contained + h.toAgent > 0);
  const codes = new Map<string, number>();
  for (const v of views) if (v.agentLeg) codes.set(v.agentLeg.wrapUpCode, (codes.get(v.agentLeg.wrapUpCode) ?? 0) + 1);
  const n = views.length || 1;
  return {
    generatedAt: new Date().toISOString(),
    sample: includeSample,
    kpis: {
      calls: views.length,
      contained,
      toAgent: views.length - contained,
      containmentRate: contained / n,
      negativePct: views.filter((v) => v.sentiment === 'negative').length / n,
      restorationSignups: views.filter((v) => v.restorationSignup).length,
      payments: views.filter((v) => v.payment).length,
      avgAiSec: Math.round(views.reduce((a, v) => a + (v.contained ? v.durationSec : Math.min(v.durationSec, 240)), 0) / n),
      live: views.filter((v) => !v.sample).length,
    },
    topics,
    byHour: first < 0 ? [] : byHour.slice(first, last + 1),
    sentiment: {
      positive: views.filter((v) => v.sentiment === 'positive').length,
      neutral: views.filter((v) => v.sentiment === 'neutral').length,
      negative: views.filter((v) => v.sentiment === 'negative').length,
    },
    wrapUps: [...codes].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
    calls: views.map(({ journey: _j, transcript: _t, ...rest }) => rest),
  };
}

export function callDetail(rows: CallRow[], id: string): CallView | undefined {
  if (id.startsWith('sample-')) return sampleStormDay().find((v) => v.id === id);
  const r = rows.find((x) => x.guid === id);
  return r ? fromRow(r) : undefined;
}
