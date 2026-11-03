// The live-agent leg of an escalated call. Cisco AI Assistant writes a wrap-up summary
// when the agent's call ends (reason, actions, status, follow-up); Cisco says AI-generated
// summaries are retrievable by API for up to 24 h after the call (release note, Oct 2026).
// The public reference doesn't show the endpoint yet, so:
//
//   • WXCC_SUMMARY_URL set (e.g. https://api.wxcc-us1.cisco.com/.../{interactionId}) →
//     poll it for escalated calls (Service App token), every 2 min, for up to 24 h.
//     [CONFIRM] the real path + response shape on developer.webex.com, then adjust parse().
//   • POST api/calls/:guid/agent-leg → anything can push it (e.g. an agent-desktop widget
//     reading the summary from the Desktop SDK at wrap-up, or a manual demo beat).
//   • Neither → a SIMULATED leg ~45 s after an escalated call ends, built from what
//     Savannah handed over, so the dashboard tells the whole story in the demo.
// The interaction id is the call row's GUID (X-Call-GUID = the WxCC interaction id).
import { env } from './env.js';
import type { AgentLeg, CallRow, CallStore } from './calls.js';
import { webexAccessToken } from './webex.js';

const WRAP_CODES: Record<string, string> = {
  wires_down: 'Outage - Wire Down',
  payment_declined: 'Billing - Payment',
  account_not_found: 'Account - Lookup',
};

function simulated(r: CallRow): AgentLeg {
  const esc = r.escalation;
  if (!esc) {
    // Straight to an agent, or an agent → Savannah payment hand-off: code from what happened.
    const handoff = r.journey.some((j) => j.step === 'agent_handoff');
    const paid = r.tags.includes('payment');
    const code = handoff || paid ? 'Billing - Payment' : r.tags.includes('payment_extension') ? 'Billing - Payment Arrangement' : r.tags.includes('outage_reported') ? 'Outage - Report' : r.tags.includes('billing_inquiry') ? 'Billing - Inquiry' : 'Billing - Inquiry';
    return {
      agentName: 'Live agent',
      team: 'Billing & Collections',
      endedAt: new Date().toISOString(),
      wrapUpCode: code,
      summary: {
        reason: handoff ? 'Member called to pay the past-due balance.' : paid ? 'Member made a payment.' : 'Member called about the account balance and due date.',
        actions: handoff ? (paid ? 'Handed the payment to Savannah; payment approved and confirmation given. Member back with the agent.' : 'Handed the payment to Savannah.') : paid ? 'Took the payment and read back the confirmation.' : 'Reviewed the account with the member and answered the question.',
        status: 'Resolved',
        followUp: 'None.',
      },
      source: 'simulated',
    };
  }
  const dept = esc.department;
  const code = WRAP_CODES[esc.reason] ?? (dept === 'outage' ? 'Outage - Report' : dept === 'billing' ? 'Billing - Inquiry' : 'General - Inquiry');
  const actions =
    esc.reason === 'wires_down'
      ? 'Created an emergency ticket and dispatched a crew. Repeated the safety instructions.'
      : dept === 'outage'
        ? 'Confirmed the outage details Savannah collected and updated the ticket.'
        : dept === 'billing'
          ? 'Reviewed the account with the member and resolved the billing question.'
          : 'Answered the question and noted the account.';
  return {
    agentName: 'Live agent',
    team: dept === 'outage' ? 'Outage queue' : dept === 'billing' ? 'Billing & Collections' : 'Member Services',
    endedAt: new Date().toISOString(),
    wrapUpCode: code,
    summary: {
      reason: esc.summary || esc.reason.replace(/_/g, ' '),
      actions,
      status: 'Resolved',
      followUp: esc.reason === 'wires_down' ? 'Crew dispatched.' : 'None.',
    },
    source: 'simulated',
  };
}

/** The call reached a live agent: Savannah escalated it, an agent answered it directly, or an agent handed a payment to Savannah. */
function reachedAgent(r: CallRow): boolean {
  return Boolean(r.escalation || r.agentSeenAt || r.journey.some((j) => j.step === 'agent_handoff'));
}

/** Over, as far as we can tell: an end time, or the agent's Member tab stopped showing it 45 s ago. */
function over(r: CallRow, now: number): number | null {
  if (r.endedAt) return Date.parse(r.endedAt);
  const seen = r.agentSeenAt ? Date.parse(r.agentSeenAt) : 0;
  if (seen && now - seen > 45_000) return seen;
  return null;
}

/** Loose parse until the response shape is confirmed: sections map, or flat fields, or text. */
function parse(j: Record<string, unknown>): AgentLeg | null {
  const sec = (j.sections ?? j.summary ?? {}) as Record<string, unknown>;
  const text = (k: string[]) => {
    for (const key of k) {
      const v = (sec as Record<string, unknown>)[key] ?? j[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  const reason = text(['reason', 'callReason', 'Reason for call', 'summaryText', 'summary']);
  if (!reason) return null;
  return {
    agentName: text(['agentName']) || 'Live agent',
    team: text(['teamName']),
    endedAt: text(['endedAt', 'createdTime']) || new Date().toISOString(),
    wrapUpCode: text(['wrapUpCode', 'wrapupCode', 'wrapUpReason']),
    summary: {
      reason,
      actions: text(['actions', 'actionsTaken', 'Key actions']),
      status: text(['status', 'resolution']),
      followUp: text(['followUp', 'nextSteps', 'Follow-up']),
    },
    source: 'cisco',
  };
}

async function fetchCisco(guid: string): Promise<AgentLeg | null> {
  const url = env.WXCC_SUMMARY_URL!.replace('{interactionId}', encodeURIComponent(guid)).replace('{orgId}', env.WEBEX_ORG_ID ?? '');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await webexAccessToken()}`, Accept: 'application/json' } });
  if (res.status === 404) return null; // not generated yet
  if (!res.ok) throw new Error(`summary HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return parse((await res.json()) as Record<string, unknown>);
}

export function wireAgentSummaries(calls: CallStore): void {
  const live = Boolean(env.WXCC_SUMMARY_URL);
  const lastTry = new Map<string, number>();
  const tick = async () => {
    const now = Date.now();
    for (const r of calls.all()) {
      if (r.agentLeg || r.channel !== 'voice' || r.direction === 'outbound' || !reachedAgent(r)) continue;
      const ended = over(r, now);
      if (ended === null || now - ended > 24 * 3600_000) continue;
      if (!live || !r.escalation) {
        // No Cisco summary for this leg (API unconfirmed, or the call never had an escalation id): a
        // plausible wrap-up code from what the call did, so every agent call shows one (Kristen 2026-11-03).
        if (now - ended > 45_000) {
          calls.patch(r, { agentLeg: simulated(r) });
          console.log(`HORRY SUMMARY ${r.guid}: simulated agent leg (${r.escalation ? 'escalation' : 'agent call'})`);
        }
        continue;
      }
      if (now - (lastTry.get(r.guid) ?? 0) < 120_000) continue;
      lastTry.set(r.guid, now);
      try {
        const leg = await fetchCisco(r.guid);
        if (leg) {
          calls.patch(r, { agentLeg: leg });
          console.log(`HORRY SUMMARY ${r.guid}: Cisco wrap-up summary stored`);
        }
      } catch (err) {
        console.log(`HORRY SUMMARY ${r.guid}: ${(err as Error).message}`);
      }
    }
  };
  setInterval(() => void tick(), 15_000).unref();
}

/** Body for POST api/calls/:guid/agent-leg. */
export function legFromBody(b: Record<string, unknown>): AgentLeg {
  const parsed = parse(b);
  if (!parsed) throw new Error('Send at least a reason (or summary text).');
  return { ...parsed, source: 'posted' };
}
