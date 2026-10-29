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
| `SMS_OVERRIDE_NUMBER` | optional — every text goes to the presenter |
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
| Call review dashboard | `dashboard.html` |
| Demo co-op website + web chat bubble | `site.html` |
| Mock billing-system screen | `billing.html?sep=<account>` |
| Widget previews (no Desktop needed) | `supervisor.html`, `agent.html?ani=&id=&sep=`, `email.html?agent=` |

Chat sessions live in memory (a restart drops open chats); emails, calls, notes, settings
persist in `data/`. "Reset demo data" re-seeds outages, calls, balances and the inbox.

## Smoke

`/health` shows which adapters are live. Storm Console → flip Storm Mode (or AI Operations → AI agent for all calls; both set the same variable) → `WxCC: synced`
(or `not_configured`). Call the DID → Savannah greets by name → console shows the journey.
