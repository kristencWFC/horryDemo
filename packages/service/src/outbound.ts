// Outbound calls by Savannah through the Twilio number attached to her (WFC AI Agent's
// Twilio integration). Unset env = simulated: the row still moves through the states so the
// page can be demoed without a live number.
//
//   ELEVENLABS_AGENT_ID          Savannah
//   ELEVENLABS_PHONE_NUMBER_ID   from scripts/attach-outbound-number.mjs (imports the Twilio number)
//   OUTBOUND_CALLER_NUMBER       the number members see, e.g. 2075315136
import { env } from './env.js';

export const outboundConfigured = (): boolean =>
  Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID && env.ELEVENLABS_PHONE_NUMBER_ID);

export async function placeOutboundCall(
  to10: string,
  dynamicVariables: Record<string, string>
): Promise<{ ok: boolean; simulated?: boolean; conversationId?: string; callSid?: string; error?: string }> {
  if (!outboundConfigured()) return { ok: true, simulated: true };
  const res = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: env.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: env.ELEVENLABS_PHONE_NUMBER_ID,
      to_number: `+1${to10}`,
      conversation_initiation_client_data: { dynamic_variables: dynamicVariables },
    }),
  });
  const j = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string; conversation_id?: string; callSid?: string; detail?: unknown };
  if (!res.ok || j.success === false) return { ok: false, error: j.message ?? JSON.stringify(j.detail ?? j).slice(0, 200) };
  return { ok: true, conversationId: j.conversation_id, callSid: j.callSid };
}
