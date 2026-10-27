// Relay the intake result to the freeSWITCH IVR controller so it can attach
// X-IVR-* headers to the SIP BYE (which the WxCC flow branches on).
// Contract (freeSWITCH src/webhook.js): POST /agent-tool/submit,
// header x-tool-auth: <agentTool.authSecret>, body {call_guid, data:{k:v}} —
// snake_case keys become X-IVR-Pascal-Dashed headers. creteDemo → home-services port.
import { env } from './env.js';

export function fsRelayConfigured(): boolean {
  return Boolean(env.FS_AGENT_TOOL_URL && env.FS_AGENT_TOOL_SECRET);
}

export async function relayResultToFreeswitch(
  callGuid: string,
  data: Record<string, string>
): Promise<boolean> {
  if (!fsRelayConfigured()) {
    console.log(`HORRY FS relay (fake mode, FS_AGENT_TOOL_* unset) ${callGuid}: ${JSON.stringify(data)}`);
    return true;
  }
  try {
    const res = await fetch(env.FS_AGENT_TOOL_URL!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tool-auth': env.FS_AGENT_TOOL_SECRET! },
      body: JSON.stringify({ call_guid: callGuid, data }),
    });
    if (!res.ok) console.log(`HORRY FS relay failed HTTP ${res.status} for ${callGuid}`);
    return res.ok;
  } catch (err) {
    console.log(`HORRY ${callGuid} FS relay error: ${(err as Error).message}`);
    return false;
  }
}
