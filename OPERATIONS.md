# OPERATIONS — horryDemo

## Local

```
npm ci
npm run build
npm start                      # :8165, reads ./.env; empty .env = fully simulated
```

Open http://localhost:8165/ (Storm Console). Pay page: `pay.html?s=<id>` (the link
`send_payment_link` texts). Runtime data: `packages/service/data/*.json` (gitignored;
delete to reset, or the console's **Reset demo data**).

## kcdev2 (Kristen runs these — Claude never touches servers)

Allocation: **:8165**, nginx `/horry/`, systemd `horry-demo`, `/opt/horryDemo`,
User=kristenc. Confirm 8165 is free first (`ss -ltnp | grep 8165` on kc-dev-2).

First deploy:

```
# kc-dev-2
sudo git clone https://github.com/kristencWFC/horryDemo.git /opt/horryDemo
sudo chown -R kristenc: /opt/horryDemo
cd /opt/horryDemo && npm ci && npm run build
# create /opt/horryDemo/.env — table below
sudo cp deploy/horry-demo.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now horry-demo
curl -s localhost:8165/health
# front box (10.128.0.14): add deploy/nginx-horry.conf.snippet to the kcdev2 site
sudo nginx -t && sudo systemctl reload nginx
# GCP: add tcp:8165 to the firewall rule that lets the nginx box reach kc-dev-2
#   (allow-list is ports-only; without it nginx 502s — kc-wiki kcdev2-nginx-and-firewall)
curl -s https://kcdev2.workflowconcepts.com/horry/health
```

Updates: `cd /opt/horryDemo && git pull --ff-only && npm ci && npm run build && sudo systemctl restart horry-demo`

**Agent-first calls (use case 1, 2026-11-03)** — the service drives freeSWITCH over its event
socket on the same VM (`src/agent-first.ts`). One-time setup on kc-dev-2:

```
# 1. dialplan: paste deploy/freeswitch/dialplan-horry-agent-first.xml into
#    /etc/freeswitch/dialplan/public/ivr_menu.xml ABOVE the ivr_handler (socket) extension,
#    next to the LiveTranslate intercept, then
sudo fs_cli -x reloadxml
# 2. .env: FS_ESL_ENABLED=true and FS_ESL_PASSWORD=<event_socket.conf.xml password>; restart
sudo systemctl restart horry-demo
curl -s localhost:8165/health | grep -o '"agentFirst":{[^}]*}'     # "connected":true
# 3. the agent must be able to hear the hold announcement:
sudo -u freeswitch test -r /opt/horryDemo/packages/service/public/audio/savannah-hold.wav && echo ok
```

Then the flow edit in `docs/wxcc-flow-notes.md` §A (`KC_Horry_Electric`, the `9729038486` DNIS
branch → Bridge 1122 `HorryAgentFirst`, failure → Queue). The re-entry lands on the demo line
972-430-9658 (CUBE dial-peers 1145/1146) and queues like any call. Logs:
`journalctl -u horry-demo -f -g "AGENT-FIRST\|ESL"`.

freeSWITCH (`horryelectric` solution, committed in the freeSWITCH repo 87bb1f6): pull on
the FS box, add the `horryelectric` block to the SERVER `config.json` (sipNumber once
chosen; webhookSecret = the box's agentTool secret pattern), restart `ivr-controller`.

## Server `.env`

| Key | Value |
| --- | --- |
| `PORT` | 8165 |
| `PUBLIC_BASE_URL` | https://kcdev2.workflowconcepts.com/horry |
| `ELEVENLABS_API_KEY` | workspace key (same as home-services) |
| `ELEVENLABS_AGENT_ID` | agent_5701m5zn0g2jegma4z7p0wpc255m |
| `ELEVENLABS_WEBHOOK_SECRET` | from local `.env` (post-call webhook 525b8fcf…) |
| `TOOL_SHARED_SECRET` | from local `.env` (also baked into the agent's tools) |
| `FS_AGENT_TOOL_URL` / `FS_AGENT_TOOL_SECRET` | same as home-services (FS `/agent-tool/submit`) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_SMS_FROM` | SMS number for restoration texts + payment links (point its inbound webhook at `/horry/webhooks/twilio/sms`) |
| `FS_ESL_ENABLED` / `FS_ESL_PASSWORD` | `true` + the freeSWITCH `event_socket` password: agent-first calls (use case 1) — the service answers the member on 1122, re-enters WxCC as them, and moves them to Savannah on the hand-off button. Defaults: `FS_ESL_HOST=127.0.0.1`, `FS_ESL_PORT=8021`, `FS_REENTRY_DIAL=sofia/gateway/cube/+19724309658` (the demo line, CUBE dial-peers 1145/1146; members dial 972-903-8486 for use case 1), `FS_HOLD_MUSIC=/usr/share/freeswitch/sounds/ivr/onholdmusic.wav`, `FS_HOLD_ANNOUNCE` = the repo's `public/audio/savannah-hold.wav` (regenerate with `node scripts/make-hold-announcement.mjs "wording"`). Unset = the hand-off button only records the hand-off |
| `WXCC_PAYMENT_EP_ID` (optional, superseded) | Entry point id of `EP_KC_Horry_Payment` for the Member tab's automatic transfer (Desktop `blindTransferV2`). Unset = looked up by name through the config API at the first hand-off; if the Service App can't list entry points, paste the id from Control Hub (entry point URL) |
| `ELEVENLABS_PHONE_NUMBER_ID` / `OUTBOUND_CALLER_NUMBER` | Payment reminder calls (use case 3): the Twilio number attached to Savannah. Once, locally, from a clean shell: `node scripts/attach-outbound-number.mjs +12075315136` prints both lines; put them in the local AND server `.env`. Unset = reminder calls are simulated (texts still go out) |
| `SMS_OVERRIDE_NUMBER` | optional — every text goes to the presenter. The AI Operations page's **Send demo texts to** field (api/settings `demoSmsTo`) does the same at runtime and wins over this |
| `WEBEX_ORG_ID`, `WXCC_STORM_VARIABLE_ID`, `WEBEX_CLIENT_ID`, `WEBEX_CLIENT_SECRET`, `WEBEX_REFRESH_TOKEN` | Storm Mode global variable writer (dedicated Service App) |
| `WXCC_SUMMARY_URL` | Cisco AI Assistant summary endpoint template with `{interactionId}` — [CONFIRM] path. Unset = simulated live-agent summaries |
| `WXCC_OUTAGE_QUEUE_ID` | id of `Q_Horry_Outage` — the supervisor widget adds/removes teams on it (same Service App). Unset = simulated teams |
| `WXCC_STAFFING_TEAM_PREFIX` | default `KC_Horry` — the picker offers only teams named with this prefix (plus any already on the queue); the server rejects others. The demo org is shared |
| `NEXTGEN_BASE_URL` / `NEXTGEN_USERNAME` / `NEXTGEN_PASSWORD` | leave unset (mock) for the demo |
| `EMAIL_AGENTS` | optional, comma-separated agent names for the email board's assign list (default: fictional names + any agent who opened the board in the last 10 min) |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` | also switch web chat to a live text conversation with Savannah (Node ≥ 22); unset = scripted chat over the same tools |

Widgets: `npm run build` builds `packages/widgets/dist/horry-widgets.js`, served at
`/horry/widgets/horry-widgets.js` (`horry-supervisor`, `horry-member`, `horry-chat`,
`horry-chat-badge`, `horry-email`). Layout: `node scripts/make-layout.mjs` →
`deploy/desktop-layout/KC_Horry.json` (deploy widgets BEFORE uploading the layout).

| Page | URL (under `https://kcdev2.workflowconcepts.com/horry/`) |
| --- | --- |
| Storm Console (demo caller, outages, texts, reset) | `/` |
| Customer Review (calls + web chats; date range, channel, CSV `api/analytics/export.csv?from=&to=&channel=`, print/PDF) | `dashboard.html` |
| Web Chats widget preview | `chats.html` |
| Demo co-op website + web chat bubble | `site.html` |
| Presenter call-flow step-through (client-facing; also works opened from disk) | `call-flow.html` |
| Mock billing-system screen | `billing.html?sep=<account>` |
| Widget previews (no Desktop needed) | `supervisor.html`, `agent.html?ani=&id=&sep=`, `email.html?agent=` |

Chats (kept 7 days after they end, listed under Ended on Web Chats), emails, calls, notes and settings
persist in `data/`; a chat still with Savannah at a restart is ended (her session is gone). "Reset demo data" re-seeds outages, calls, balances and the inbox.

## Smoke

`/health` shows which adapters are live. AI Operations → turn Savannah on (the Storm Console flip sets the same variable) → `WxCC: synced`
(or `not_configured`). Call the DID → Savannah greets by name → console shows the journey.
