# ElevenLabs agent — "horryDemo" (Savannah)

**Status: CONFIGURED via API 2026-10-27** by `scripts/provision-agent.mjs --configure`
(then `--patch` after adding `pay_with_card_on_file`).

| | |
| --- | --- |
| Agent | `agent_5701m5zn0g2jegma4z7p0wpc255m`, branch `agtbrch_8801m5zn0g2zfgfrnebs6yc483qn` |
| Persona | **Savannah**, the co-op's virtual assistant (Crete = Casey, Infinity = Riley, Stillwater = Ava, Aliv = Bimini, NexTier = Sloan) |
| Voice | `cgSgspJ2msm6clMCkdW9` (Jessica — the Crete/Infinity voice), eleven_turbo_v2 pcm_16000; ASR scribe_realtime pcm_16000 (template: Home Services agent) |
| LLM | claude-haiku-4-5, temperature 0.3 |
| First message | `{{first_message}}` — from the conversation-initiation webhook (outage-aware when Storm Mode is on) |
| Prompt | `agent/system-prompt.txt` + `{{call_playbook}}` + `{{broadcast_message}}` |
| Tools (12) | `agent/tools.json` → `POST {PUBLIC_BASE_URL}/api/tools/<name-with-dashes>`, header `X-Tool-Secret` = `TOOL_SHARED_SECRET`; `call_guid` ← `sip_call_guid`, `caller_id` ← `system__caller_id` |
| Initiation webhook | `https://kcdev2.workflowconcepts.com/horry/webhooks/elevenlabs/conversation-initiation` (+ X-Tool-Secret); `enable_conversation_initiation_client_data_from_webhook: true` |
| Post-call webhook | workspace webhook `525b8fcf712a4bf6a168673e0d5dc9e7` → `/horry/webhooks/elevenlabs/post-call` (HMAC; secret in local `.env` as `ELEVENLABS_WEBHOOK_SECRET` — copy to the server `.env`) |
| Built-ins | end_call kept (directive description), transfer_to_number removed |
| SIP number | **NOT YET** — `1150` refused: "Phone number 1150 already exists" (not in our workspace; SIP numbers look globally unique). Pick another, then `node scripts/provision-agent.mjs --sip-number <n> agent_5701m5zn0g2jegma4z7p0wpc255m` (allowlist 34.41.17.98/32, media_encryption allowed) and set it in the freeSWITCH `horryelectric` block |

**The agent was cloned from Crete.** Its six Crete tools (classify_reason, log_intake,
send_otp, verify_otp, verify_voice, get_work_order_status —
`tool_2401ky2t83e0fyetf388yn3qh9bx`, `tool_0601ky2t83gtfkxt2thbne78pkqg`,
`tool_1001ky2t83kgfqcsxsjn9ksar5yy`, `tool_1801ky2t83zyfsnttafygggmf6z3`,
`tool_5401ky2t8427etrrhpvw73kxq7zq`, `tool_3701ky2t844qfd3t5t5eyh80j6kd`) were DETACHED
from horryDemo only. **Do not delete them — they are Crete's live tools.** The cloned
Crete initiation + post-call webhooks were replaced with Horry's.

Re-run after editing the prompt/tools: `node scripts/provision-agent.mjs --patch agent_5701m5zn0g2jegma4z7p0wpc255m --branch agtbrch_8801m5zn0g2zfgfrnebs6yc483qn`
(tools are updated in place by name).

TODO: data-collection fields for `sentiment` + `call_reason` (post-call analysis) so the
dashboard doesn't rely on the keyword fallback; pronunciation check for "Horry"
(`--pronounce "Horry=Ore-ee"` if Jessica says it wrong).
