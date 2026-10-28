#!/usr/bin/env node
// Provision / configure the "horryDemo" ElevenLabs agent (Savannah, Horry Electric) from agent/system-prompt.txt
// + agent/tools.json. Never run by the service — a one-off Kristen runs with her key
// (from the laptop, or on kc-dev-2 where /opt/horryDemo/.env holds it). Adapted from
// cable-bahamas-demo/scripts/provision-agent.mjs.
//
//   node scripts/provision-agent.mjs --configure [agent_id] [--voice <voice_id>] [--branch <agtbrch_id>] [--dry-run]
//         → the normal path: take the base agent Kristen created in the UI and apply
//           "the settings we usually use" (see docs/elevenlabs-agent-setup.md):
//           SIP-proven TTS/ASR/turn settings copied from the home-services template,
//           claude-haiku-4-5 @ 0.3, {{first_message}}, our prompt + {{call_playbook}},
//           the 11 webhook tools, end_call kept / transfer_to_number removed, dynamic
//           variable placeholders, conversation-initiation webhook. agent_id defaults
//           to ELEVENLABS_AGENT_ID. The agent's current voice and name are kept unless
//           --voice / --name. RE-RUNNABLE: tools already on the agent are updated in
//           place (matched by name), not duplicated.
//   node scripts/provision-agent.mjs --voices "<search>" [--accent <x>] [--gender female|male] [--json]
//         → search the public Voice Library (name/description/labels), print voice ids
//   node scripts/provision-agent.mjs --my-voices          → voices already in the workspace
//   node scripts/provision-agent.mjs --add-voice <public_owner_id> <voice_id> "<name>"
//         → copy a library voice into the workspace so an agent can use it
//   node scripts/provision-agent.mjs --dump <agent_id>    → print an agent + its tools
//   node scripts/provision-agent.mjs --create [--dry-run] → create tools + a NEW agent from the template
//   node scripts/provision-agent.mjs --patch <agent_id>   → re-push prompt / tools only (audio untouched)
//   node scripts/provision-agent.mjs --sip-number 1151 <agent_id> → SIP trunk number + assign
//
// Env (.env at the repo root): ELEVENLABS_API_KEY (workspace key), PUBLIC_BASE_URL,
// TOOL_SHARED_SECRET, ELEVENLABS_AGENT_ID, ELEVENLABS_BRANCH_ID (optional),
// ELEVENLABS_TEMPLATE_AGENT_ID (default: the home-services agent — same workspace,
// proven SIP audio settings), ELEVENLABS_LLM (optional override).
//
// Versioning: every agent is versioned now (the dashboard URL carries a branchId). A
// PATCH creates a new version on the branch; with a single Main branch the new version
// serves live traffic immediately. Pass --branch (or ELEVENLABS_BRANCH_ID) to target a
// specific branch; omit it to update the agent's working branch.
//
// The ElevenLabs Agents API evolves; this script copies a working agent's
// conversation_config and only swaps the fields we own. If a call is rejected, run
// --dump on the template and compare with `--configure --dry-run` — the field names
// to fix will be obvious.
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const API = 'https://api.elevenlabs.io';
const key = process.env.ELEVENLABS_API_KEY;
const baseUrl = (process.env.PUBLIC_BASE_URL || 'https://kcdev2.workflowconcepts.com/horry').replace(/\/$/, '');
const toolSecret = process.env.TOOL_SHARED_SECRET || '';
const templateId = process.env.ELEVENLABS_TEMPLATE_AGENT_ID || 'agent_9701m0e0rnsdfzkssej9qc87cx0b';
const AGENT_NAME = 'horryDemo';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const after = (f, n = 1) => (args.includes(f) ? args[args.indexOf(f) + n] : undefined);
const optArg = (f, n = 1) => {
  const v = after(f, n);
  return v && !v.startsWith('--') ? v : undefined;
};
const dryRun = flag('--dry-run');

if (!key && !dryRun) {
  console.error('ELEVENLABS_API_KEY is not set. Put the workspace key in horryDemo/.env (same workspace key as home-services / creteDemo).');
  process.exit(1);
}

async function el(method, path, body) {
  if (dryRun && method !== 'GET') {
    console.log(`DRY-RUN ${method} ${path}\n${JSON.stringify(body, null, 2)}\n`);
    return { dry: true, id: 'dry_' + Math.random().toString(36).slice(2, 8) };
  }
  if (dryRun && !key) {
    console.log(`DRY-RUN (no key) ${method} ${path} → {}`);
    return {};
  }
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 800)}`);
  return text ? JSON.parse(text) : {};
}

function warnIfNoSecret() {
  if (!toolSecret) {
    console.warn('WARNING: TOOL_SHARED_SECRET is unset — tools and the initiation webhook are being written WITHOUT the X-Tool-Secret header. Set it in .env (server AND wherever this runs), restart horry-demo, and re-run --configure (tools are updated in place).');
  }
}

function loadTools() {
  const spec = JSON.parse(readFileSync(join(here, '..', 'agent', 'tools.json'), 'utf8'));
  return spec.tools.map((t) => {
    const properties = {};
    const required = [];
    // Auto-filled correlation id: bound to the sip_call_guid dynamic variable so the LLM never
    // types it. NO description here — the API allows only ONE of description /
    // dynamic_variable / constant_value / is_system_provided / is_omitted per parameter
    // (422 "Can only set one of …" on 2026-08-26; the live home-services tool has the same
    // bare shape).
    for (const [k, v] of Object.entries(spec.common.auto_params)) {
      properties[k] = { type: 'string', dynamic_variable: v.dynamic_variable };
    }
    for (const [k, v] of Object.entries(t.params)) {
      properties[k] = { type: v.type, description: v.description };
      if (v.required) required.push(k);
    }
    return {
      type: 'webhook',
      name: t.name,
      description: t.description,
      response_timeout_secs: 20,
      api_schema: {
        url: `${baseUrl}/api/tools/${t.name.replace(/_/g, '-')}`,
        method: spec.common.method,
        request_headers: toolSecret ? { [spec.common.header]: toolSecret } : {},
        request_body_schema: { type: 'object', properties, required },
      },
    };
  });
}

function loadPrompt() {
  return readFileSync(join(here, '..', 'agent', 'system-prompt.txt'), 'utf8').trim();
}

/** Every {{placeholder}} the prompt or the playbooks reference, with harmless defaults. */
const DYNAMIC_VARIABLE_PLACEHOLDERS = {
  assistant_name: 'Savannah',
  first_message: "Thank you for calling Horry Electric Cooperative. This is Savannah, the co-op's virtual assistant. How can I help you today?",
  call_playbook: '',
  broadcast_message: '',
  member_found: 'false',
  member_name: 'unknown',
  first_name: 'there',
  service_address: 'unknown',
  account_number: '',
  outage_known: 'false',
  outage_area: '',
  outage_customers: '0',
  outage_cause: '',
  outage_etr: '',
  life_support: 'false',
  balance_due: '',
  due_date: '',
  past_due: '0',
  cutoff_date: '',
  storm_mode: 'false',
  current_date: '',
  sip_call_guid: '',
};

function branchQuery() {
  const b = optArg('--branch') || process.env.ELEVENLABS_BRANCH_ID;
  return b ? `?branch_id=${encodeURIComponent(b)}` : '';
}

async function dump(agentId) {
  const agent = await el('GET', `/v1/convai/agents/${agentId}`);
  console.log(JSON.stringify(agent, null, 2));
  const toolIds = agent?.conversation_config?.agent?.prompt?.tool_ids ?? [];
  for (const id of toolIds) {
    const tool = await el('GET', `/v1/convai/tools/${id}`);
    console.log(`\n--- tool ${id} ---\n${JSON.stringify(tool, null, 2)}`);
  }
}

/**
 * Create or update the 11 webhook tools. Tools already attached to the agent are matched
 * by name and PATCHed in place, so re-running --configure / --patch never piles up
 * duplicates in the workspace. Returns the tool ids to put on the agent, in spec order.
 */
async function upsertTools(existingIds = []) {
  warnIfNoSecret();
  const byName = new Map();
  for (const id of existingIds) {
    try {
      const t = await el('GET', `/v1/convai/tools/${id}`);
      const name = t?.tool_config?.name;
      if (name && !byName.has(name)) byName.set(name, id);
    } catch (err) {
      console.warn(`  (tool ${id} unreadable — ${err.message.slice(0, 100)})`);
    }
  }
  const ids = [];
  for (const tool_config of loadTools()) {
    const existing = byName.get(tool_config.name);
    if (existing) {
      await el('PATCH', `/v1/convai/tools/${existing}`, { tool_config });
      console.log(`tool ${tool_config.name} → ${existing} (updated)`);
      ids.push(existing);
    } else {
      const r = await el('POST', '/v1/convai/tools', { tool_config });
      console.log(`tool ${tool_config.name} → ${r.id} (created)`);
      ids.push(r.id);
    }
  }
  const stale = existingIds.filter((id) => !ids.includes(id));
  if (stale.length) console.log(`tools that were on the agent but are not in agent/tools.json — detached, delete in the UI if unwanted: ${stale.join(', ')}`);
  return ids;
}

/** The fields we own: prompt, first message, LLM, tools, dynamic variables, initiation webhook. */
function buildAgentBody(base, toolIds, { keepName = false } = {}) {
  const cc = structuredClone(base?.conversation_config ?? {});
  cc.agent = cc.agent ?? {};
  cc.agent.first_message = '{{first_message}}';
  cc.agent.language = cc.agent.language ?? 'en';
  cc.agent.dynamic_variables = { dynamic_variable_placeholders: DYNAMIC_VARIABLE_PLACEHOLDERS };
  cc.agent.prompt = {
    ...(cc.agent.prompt ?? {}),
    prompt: loadPrompt(),
    llm: process.env.ELEVENLABS_LLM || 'claude-haiku-4-5',
    temperature: 0.3,
    tool_ids: toolIds,
    // Keep end_call, drop transfer_to_number: escalation is OUR tool (the flow queues the caller).
    // The system tool's description steers the LLM: on 2026-08-26 contained calls sat open
    // after the goodbye with the bland "End the call after log_outcome." — be directive.
    built_in_tools: {
      ...(cc.agent.prompt?.built_in_tools ?? {}),
      end_call: {
        ...(cc.agent.prompt?.built_in_tools?.end_call ?? { name: 'end_call', type: 'system', params: { system_tool_type: 'end_call' } }),
        description: 'Hang up the call. You MUST call this to end a call — saying goodbye does not. Call it immediately after log_outcome and your one-sentence goodbye, whenever the caller has no further needs, says goodbye, or the line goes quiet after your goodbye.',
      },
      transfer_to_number: null,
    },
  };
  delete cc.agent.prompt.tools; // send tool_ids, never the expanded tools array (home-services lesson)
  const ps = structuredClone(base?.platform_settings ?? {});
  ps.workspace_overrides = {
    ...(ps.workspace_overrides ?? {}),
    conversation_initiation_client_data_webhook: {
      url: `${baseUrl}/webhooks/elevenlabs/conversation-initiation`,
      request_headers: toolSecret ? { 'X-Tool-Secret': toolSecret } : {},
    },
  };
  // REQUIRED for phone / SIP calls: without this flag ElevenLabs never calls the initiation
  // webhook, {{first_message}} stays unfilled and the call sits silent with "Missing required
  // dynamic variables in first message: {'first_message'}". A UI-created base agent defaults
  // it to false (bit crete earlier and Aliv on 2026-08-26).
  ps.overrides = { ...(ps.overrides ?? {}), enable_conversation_initiation_client_data_from_webhook: true };
  const name = optArg('--name') || (keepName && base?.name) || AGENT_NAME;
  return { name, conversation_config: cc, platform_settings: ps };
}

/**
 * "The settings we usually use" — the SIP-proven audio + turn config from the template
 * (TTS eleven_turbo_v2 @ pcm_16000, ASR scribe_realtime @ pcm_16000 …), applied onto the
 * target's conversation_config. The target's own voice is kept unless one is given.
 */
function applyTemplateAudio(body, template, voiceId) {
  const t = template?.conversation_config ?? {};
  const cc = body.conversation_config;
  const currentVoice = voiceId || cc.tts?.voice_id || t.tts?.voice_id;
  // Keep the target's own pronunciation dictionaries (set by --pronounce) — the template's
  // tts block would otherwise wipe them on every re-run.
  const locators = cc.tts?.pronunciation_dictionary_locators ?? [];
  if (t.tts) cc.tts = { ...(cc.tts ?? {}), ...structuredClone(t.tts), voice_id: currentVoice, pronunciation_dictionary_locators: locators };
  else if (voiceId) cc.tts = { ...(cc.tts ?? {}), voice_id: voiceId };
  if (t.asr) cc.asr = structuredClone(t.asr);
  if (t.turn) cc.turn = structuredClone(t.turn);
  if (t.vad) cc.vad = structuredClone(t.vad);
  if (t.conversation?.max_duration_seconds) {
    cc.conversation = { ...(cc.conversation ?? {}), max_duration_seconds: t.conversation.max_duration_seconds };
  }
  return body;
}

function describe(label, agent) {
  const cc = agent?.conversation_config ?? {};
  console.log(
    `${label}: ${agent?.name ?? '(none)'} — TTS ${cc.tts?.model_id ?? '?'} @ ${cc.tts?.agent_output_audio_format ?? '?'} voice ${cc.tts?.voice_id ?? '?'} / ASR ${cc.asr?.provider ?? '?'} ${cc.asr?.user_input_audio_format ?? ''} / LLM ${cc.agent?.prompt?.llm ?? '?'} / tools ${(cc.agent?.prompt?.tool_ids ?? []).length} / first message ${JSON.stringify((cc.agent?.first_message ?? '').slice(0, 40))}`,
  );
}

async function create() {
  const template = dryRun && !key ? {} : await el('GET', `/v1/convai/agents/${templateId}`);
  describe('template', template);
  const toolIds = await upsertTools([]);
  const body = buildAgentBody(template, toolIds);
  const r = await el('POST', '/v1/convai/agents/create', body);
  console.log(`\nAGENT CREATED: ${r.agent_id ?? r.id}\n`);
  console.log('Next: set the post-call webhook (workspace → webhooks) and copy its secret to ELEVENLABS_WEBHOOK_SECRET; then --sip-number 1151 <agent_id>.');
}

async function configure(agentId) {
  if (!agentId) throw new Error('--configure needs an agent id (argument or ELEVENLABS_AGENT_ID in .env)');
  const voiceId = optArg('--voice');
  const [template, target] = await Promise.all([
    el('GET', `/v1/convai/agents/${templateId}`),
    el('GET', `/v1/convai/agents/${agentId}`),
  ]);
  describe('template', template);
  describe('target  ', target);
  const toolIds = await upsertTools(target?.conversation_config?.agent?.prompt?.tool_ids ?? []);
  const body = applyTemplateAudio(buildAgentBody(target, toolIds, { keepName: true }), template, voiceId);
  const q = branchQuery();
  await el('PATCH', `/v1/convai/agents/${agentId}${q}`, body);
  console.log(`\nCONFIGURED ${agentId}${q ? ` on branch ${q.slice(11)}` : ''}`);
  if (!dryRun) describe('now     ', await el('GET', `/v1/convai/agents/${agentId}`));
  console.log([
    '',
    'Next: 1) post-call webhook → --create-post-call-webhook --write-env (secret → ELEVENLABS_WEBHOOK_SECRET);',
    '      2) pronunciation: --pronounce "Horry=Ore-ee" if the voice says it wrong;',
    '           3) post-call webhook → PUBLIC_BASE_URL/webhooks/elevenlabs/post-call, secret → ELEVENLABS_WEBHOOK_SECRET;',
    '           4) --sip-number 1151 <agent_id>, then verify supports_inbound in the UI.',
  ].join('\n'));
}

async function patch(agentId) {
  const existing = await el('GET', `/v1/convai/agents/${agentId}`);
  const toolIds = await upsertTools(existing?.conversation_config?.agent?.prompt?.tool_ids ?? []);
  const body = buildAgentBody(existing, toolIds, { keepName: true });
  await el('PATCH', `/v1/convai/agents/${agentId}${branchQuery()}`, body);
  console.log(`patched ${agentId} (prompt, first message, LLM, tools, dynamic variables, initiation webhook; audio untouched)`);
}

async function sipNumber(number, agentId) {
  const r = await el('POST', '/v1/convai/phone-numbers', {
    provider: 'sip_trunk',
    phone_number: number,
    label: `horryDemo — freeSWITCH ${number}`,
    // Without inbound_trunk_config the INVITE from freeSWITCH is rejected
    // (kc-wiki freeswitch-production-requirements; home-services §5a caveat).
    // Lockdown standard (nextier 1130): allowlist kc-dev-2 only; media_encryption "allowed"
    // is what flipped home-services 1127 to supports_inbound (2026-08-20).
    inbound_trunk_config: { allowed_addresses: [process.env.SIP_ALLOWED_ADDRESS || '34.41.17.98/32'], media_encryption: 'allowed' },
  });
  const id = r.phone_number_id ?? r.id;
  console.log(`sip number ${number} → ${id}`);
  if (agentId && id) {
    await el('PATCH', `/v1/convai/phone-numbers/${id}`, { agent_id: agentId });
    console.log(`assigned to ${agentId}. VERIFY in the UI that supports_inbound is true (compare crete's "1126").`);
  }
}

// ---------- post-call webhook ----------
// Post-call webhooks are workspace objects (create one in the UI: Settings → Webhooks, URL
// {{PUBLIC_BASE_URL}}/webhooks/elevenlabs/post-call, HMAC auth — copy the secret shown ONCE
// into .env as ELEVENLABS_WEBHOOK_SECRET). Without a per-agent override the workspace
// default fires instead (here: crete's endpoint), and the transcript never reaches us.
async function listWebhooks() {
  const r = await el('GET', '/v1/workspace/webhooks');
  console.log('Workspace webhooks:\n');
  for (const w of r.webhooks ?? []) console.log(`${w.webhook_id}  ${(w.name || '').padEnd(28)} ${w.webhook_url}${w.is_disabled ? '  (disabled)' : ''}`);
  console.log(`\nAssign one to the agent: node scripts/provision-agent.mjs --post-call-webhook <webhook_id> [agent_id]`);
}

/**
 * Create the post-call webhook for this deployment and attach it to the agent in one go.
 * POST /v1/workspace/webhooks returns the HMAC secret ONCE (`webhook_secret`) — it is
 * printed here and nowhere else: put it in the server .env as ELEVENLABS_WEBHOOK_SECRET
 * and restart horry-demo. Run this on the server so the secret stays in that terminal.
 */
async function createPostCallWebhook(agentId, name = 'horry-postcall') {
  if (!agentId) throw new Error('agent id missing (argument or ELEVENLABS_AGENT_ID)');
  const url = `${baseUrl}/webhooks/elevenlabs/post-call`;
  // ROTATE: the secret is shown only at creation, so a previous webhook for our URL is
  // useless once its secret is lost (and a second one with the same name may be refused).
  // Remove any existing webhook on our URL, then create a fresh one.
  const previous = ((await el('GET', '/v1/workspace/webhooks')).webhooks ?? []).filter((w) => w.webhook_url === url);
  for (const w of previous) {
    await el('DELETE', `/v1/workspace/webhooks/${w.webhook_id}`);
    console.log(`removed previous webhook ${w.webhook_id} (${w.name || 'unnamed'}) — its secret is unrecoverable anyway`);
  }
  const settings = { name, webhook_url: url, auth_type: 'hmac' };
  let r;
  try {
    r = await el('POST', '/v1/workspace/webhooks', { settings });
  } catch (err) {
    if (!/HTTP 4\d\d/.test(err.message)) throw err;
    console.warn(`(settings-wrapped body rejected — ${err.message.slice(0, 120)} — retrying flat)`);
    r = await el('POST', '/v1/workspace/webhooks', settings);
  }
  const id = r.webhook_id ?? r.id;
  const secret = r.webhook_secret;
  console.log(`\nwebhook created: ${id}  →  ${url}`);
  if (secret && flag('--write-env')) {
    // Write the secret straight into this repo's .env (the file the service reads) so
    // nothing has to be copied from a terminal. The service picks it up on restart.
    const envPath = join(here, '..', '.env');
    let env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    const nl = env.includes('\r\n') ? '\r\n' : '\n';
    const line = `ELEVENLABS_WEBHOOK_SECRET=${secret}`;
    const re = /^#?\s*ELEVENLABS_WEBHOOK_SECRET=.*$/m;
    env = re.test(env) ? env.replace(re, () => line) : env.replace(/\s*$/, nl) + line + nl;
    writeFileSync(envPath, env);
    console.log(`  ELEVENLABS_WEBHOOK_SECRET written to ${envPath}. Now: sudo systemctl restart horry-demo`);
  } else if (secret) {
    console.log(`\n  ELEVENLABS_WEBHOOK_SECRET=${secret}\n\n  ^ shown once. Add that line to the server .env, then: sudo systemctl restart horry-demo   (or re-run with --write-env)`);
  } else {
    console.log('  (no secret in the response — open the webhook in the UI: Settings → Webhooks → copy the HMAC secret)');
  }
  if (id && !dryRun) await setPostCallWebhook(id, agentId);
}

// ---------- pronunciation ----------
/**
 * --pronounce "Aliv=Alive[,Kansys=Kan-sis]": create an alias pronunciation dictionary and
 * attach it to the agent (tts.pronunciation_dictionary_locators). Alias rules are plain
 * text substitution before TTS, so they work with eleven_turbo_v2. Each word gets rules
 * for the as-written, lower-case and UPPER-case spellings; "Aliv's" is covered because the
 * match is a substring. Re-running replaces the agent's dictionary list with the new one.
 */
async function pronounce(spec, agentId) {
  if (!spec || !spec.includes('=')) throw new Error('--pronounce "Word=How it sounds[,Other=Sound]" [agent_id]');
  if (!agentId) throw new Error('agent id missing (argument or ELEVENLABS_AGENT_ID)');
  const rules = [];
  for (const pair of spec.split(',')) {
    const [word, alias] = pair.split('=').map((s) => s.trim());
    if (!word || !alias) continue;
    const variants = new Map([[word, alias], [word.toLowerCase(), alias.toLowerCase()], [word.toUpperCase(), alias.toUpperCase()]]);
    for (const [w, a] of variants) rules.push({ string_to_replace: w, type: 'alias', alias: a });
  }
  const dict = await el('POST', '/v1/pronunciation-dictionaries/add-from-rules', { name: `horry-electric-${Date.now().toString(36)}`, description: `horryDemo agent: ${spec}`, rules });
  const locator = { pronunciation_dictionary_id: dict.id ?? dict.pronunciation_dictionary_id, version_id: dict.version_id };
  console.log(`dictionary ${locator.pronunciation_dictionary_id} v ${locator.version_id} — ${rules.length} alias rules`);
  const agent = await el('GET', `/v1/convai/agents/${agentId}`);
  const tts = { ...(agent?.conversation_config?.tts ?? {}), pronunciation_dictionary_locators: [locator] };
  await el('PATCH', `/v1/convai/agents/${agentId}${branchQuery()}`, { conversation_config: { tts } });
  console.log(`attached to ${agentId}. Test line: "Thank you for calling Horry Electric Cooperative. This is Savannah."`);
}

/** The HMAC secret is shown only at creation; if it was lost, delete and re-create. */
async function deleteWebhook(webhookId) {
  if (!webhookId) throw new Error('--delete-webhook <webhook_id>');
  await el('DELETE', `/v1/workspace/webhooks/${webhookId}`);
  console.log(`deleted webhook ${webhookId}. Re-create + attach with: --create-post-call-webhook`);
}

async function setPostCallWebhook(webhookId, agentId) {
  if (!webhookId) throw new Error('--post-call-webhook <webhook_id> [agent_id]');
  if (!agentId) throw new Error('agent id missing (argument or ELEVENLABS_AGENT_ID)');
  const agent = await el('GET', `/v1/convai/agents/${agentId}`);
  const wo = structuredClone(agent?.platform_settings?.workspace_overrides ?? {});
  // Same shape crete/rxdialer run live: transcript only, JSON, no audio. Send only the
  // sub-object we change — PATCH merges.
  wo.webhooks = { ...(wo.webhooks ?? {}), post_call_webhook_id: webhookId, events: ['transcript'], transcript_format: 'json', send_audio: false };
  await el('PATCH', `/v1/convai/agents/${agentId}${branchQuery()}`, { platform_settings: { workspace_overrides: wo } });
  console.log(`post-call webhook ${webhookId} set on ${agentId}. Make sure ELEVENLABS_WEBHOOK_SECRET in the server .env is THAT webhook's secret, then: sudo systemctl restart horry-demo`);
}

// ---------- voices ----------
function voiceRow(v) {
  const labels = v.labels ?? {};
  return [
    (v.voice_id ?? '').padEnd(22),
    (v.name ?? '').slice(0, 24).padEnd(25),
    ((v.accent ?? labels.accent ?? '') + '').slice(0, 18).padEnd(19),
    ((v.gender ?? labels.gender ?? '') + '').slice(0, 7).padEnd(8),
    ((v.age ?? labels.age ?? '') + '').slice(0, 12).padEnd(13),
    ((v.use_case ?? labels.use_case ?? '') + '').slice(0, 16).padEnd(17),
    (v.description ?? labels.description ?? v.descriptive ?? '').replace(/\s+/g, ' ').slice(0, 70),
  ].join(' ');
}
const VOICE_HEAD = ['voice_id'.padEnd(22), 'name'.padEnd(25), 'accent'.padEnd(19), 'gender'.padEnd(8), 'age'.padEnd(13), 'use case'.padEnd(17), 'description'].join(' ');

async function searchVoices(search) {
  const p = new URLSearchParams({ page_size: '50', language: 'en' });
  if (search) p.set('search', search);
  if (optArg('--accent')) p.set('accent', optArg('--accent'));
  if (optArg('--gender')) p.set('gender', optArg('--gender'));
  const r = await el('GET', `/v1/shared-voices?${p}`);
  const voices = r.voices ?? [];
  console.log(`Voice Library — ${voices.length} match(es) for ${JSON.stringify(search || '')}${optArg('--accent') ? ` accent=${optArg('--accent')}` : ''}\n`);
  console.log(VOICE_HEAD + '  owner');
  for (const v of voices) console.log(voiceRow(v) + `  ${v.public_owner_id ?? ''}`);
  console.log('\nTo use one: node scripts/provision-agent.mjs --add-voice <owner> <voice_id> "Horry — <name>"   then   --configure --voice <voice_id>');
  if (flag('--json')) console.log(JSON.stringify(voices.map((v) => ({ voice_id: v.voice_id, name: v.name, accent: v.accent, preview_url: v.preview_url, public_owner_id: v.public_owner_id })), null, 2));
  else console.log('Add --json to get preview URLs.');
}

async function myVoices() {
  const r = await el('GET', '/v1/voices');
  const voices = r.voices ?? [];
  console.log(`Workspace voices — ${voices.length}\n`);
  console.log(VOICE_HEAD);
  for (const v of voices) console.log(voiceRow(v));
}

async function addVoice(owner, voiceId, name) {
  if (!owner || !voiceId) throw new Error('--add-voice <public_owner_id> <voice_id> "<name>"');
  const r = await el('POST', `/v1/voices/add/${owner}/${voiceId}`, { new_name: name || 'Horry Electric voice' });
  console.log(`added voice → ${r.voice_id ?? JSON.stringify(r)}. Now: --configure --voice ${r.voice_id ?? voiceId}`);
}

try {
  if (flag('--dump')) await dump(after('--dump'));
  else if (flag('--configure')) await configure(optArg('--configure') || process.env.ELEVENLABS_AGENT_ID);
  else if (flag('--create')) await create();
  else if (flag('--patch')) await patch(after('--patch'));
  else if (flag('--sip-number')) await sipNumber(after('--sip-number'), after('--sip-number', 2));
  else if (flag('--voices')) await searchVoices(optArg('--voices'));
  else if (flag('--my-voices')) await myVoices();
  else if (flag('--add-voice')) await addVoice(after('--add-voice'), after('--add-voice', 2), after('--add-voice', 3));
  else if (flag('--webhooks')) await listWebhooks();
  else if (flag('--post-call-webhook')) await setPostCallWebhook(after('--post-call-webhook'), optArg('--post-call-webhook', 2) || process.env.ELEVENLABS_AGENT_ID);
  else if (flag('--create-post-call-webhook')) await createPostCallWebhook(optArg('--create-post-call-webhook') || process.env.ELEVENLABS_AGENT_ID);
  else if (flag('--delete-webhook')) await deleteWebhook(after('--delete-webhook'));
  else if (flag('--pronounce')) await pronounce(after('--pronounce'), optArg('--pronounce', 2) || process.env.ELEVENLABS_AGENT_ID);
  else {
    console.log('usage: --configure [agent_id] [--voice id] [--name "…"] [--branch id] [--dry-run] | --pronounce "Horry=Ore-ee" [agent_id] | --voices "<search>" [--accent x] [--gender x] [--json] | --my-voices | --add-voice <owner> <voice_id> "<name>" | --webhooks | --create-post-call-webhook [--write-env] [agent_id] | --post-call-webhook <webhook_id> [agent_id] | --delete-webhook <webhook_id> | --dump <agent_id> | --create [--dry-run] | --patch <agent_id> | --sip-number <number> <agent_id>');
    console.log(`\nTools that would be written (${loadTools().length}):`);
    for (const t of loadTools()) console.log(` - ${t.name} → ${t.api_schema.url}`);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
