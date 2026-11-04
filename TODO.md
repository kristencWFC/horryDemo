# TODO — Horry Electric demo

Demo **Wed 2026-11-04 10:00 AM ET**. Discovery call this week (Wed 10/28 or Thu 10/29 —
Nick confirming).

## STATE (handoff)

2026-11-04 (after the demo) — **Quality management** (Horry's one request: see a call going badly live, listen/join; afterwards review every call with summary + sentiment, filter and drill in). Built: `src/live-qa.ts` (sessions per call; Deepgram multichannel on a stereo `uuid_audio_stream` of the member leg of agent-first calls; Claude scorer `QA_MODEL` default claude-opus-5-5 at low effort, word rules without a key; alert once below `QA_ALERT_SCORE` + optional text `QA_ALERT_SMS_TO`; listen/whisper/join = controller originates to `QA_MONITOR_DIAL` (`sofia/gateway/cube/+1{number}` or a SIP phone `user/1000`) with `&eavesdrop(A)`, modes via `uuid_recv_dtmf` 0/2/3; stream paused + monitor dropped during the Savannah hand-off, 11+ digit runs masked), `src/qa-routes.ts` (api/qa/live, sessions, monitor, ack, API-fed sessions/turns, WS api/qa/stream via `ws`), `src/deepgram.ts`; AI Operations gets a **Live calls** card (meter, needs-attention + Acknowledge, Listen / Whisper to agent / Join / Stop, "Listen or join from" phone → settings.supervisorPhone); Customer Review: sentiment filter (buttons, bar bands, Negative tile, Flagged while live tile), Needs attention list, drill-in "How the member felt" (reason, timeline) + member/agent transcript, CSV columns; sample day carries a reason per call; Member tab sends the agent name so rows carry `agentName`. 8 vitest cases (`test/live-qa.test.ts`). New deps: ws, @anthropic-ai/sdk. Overview page v32 use case 6 + step-through scenario; HLD §2.10. **Kristen:** `.env` DEEPGRAM_API_KEY + ANTHROPIC_API_KEY (both in wfcPlatform's .env on the VM), optional QA_ALERT_SMS_TO, confirm CUBE can dial a cell from the controller (else QA_MONITOR_DIAL=user/1000 + softphone); push, `npm ci`, deploy, F5; then a live test on 972-903-8486.

2026-11-03 (later) — **New card by voice** (Kristen): Savannah asks "credit card on file, ACH e-check on file, or a new credit card?" and takes a new card by voice (number, expiration, security code, ZIP; repeats only the last four) → tool `pay_with_new_card` (`payments.payWithNewCard`: Luhn + expiry, 4000…0002 declines; nothing stored but last4). The secure link is now only on request or from the agent button. Hand-off panel shows "Payment completed · amount · card · confirmation" and persists until the member is back (agent-desk snapshot keys on the Desktop ANI, not the member phone). check_payment_status waits up to 15 s instead of Savannah narrating. Agent re-provisioned (18 tools).

2026-11-03 — **Use case 1 rebuilt: agent-first calls through the WFC AI Controller** (approved by Kristen 11/03; design page docs/payment-handoff-design.html, artifact DGoHXGencotbUhuqEcHKC7 v2). Why: the entry-point transfer dropped the call live, wrap-up → Queue To Agent is not acceptable, and a WxCC conference can't keep the agent from hearing the payment. Numbers (Kristen 11/03): members dial **972-903-8486** (EP_KC_Horry_Payment → its DNIS branch bridges 1122 `HorryAgentFirst`); the controller re-enters on the demo line **972-430-9658** via new CUBE dial-peers 1145/1146 (copies of 1141/1142) → main flow queues as normal; nothing shared with Live Translate. Built: `src/esl.ts` (event-socket client from live-translate) + `src/agent-first.ts` (park → originate re-entry `sofia/gateway/cube/+19724309658` as the member → `uuid_bridge`; loop guard refuses a second 1122 leg while the first connects; hand-off = `uuid_transfer` A to dialplan ext `horry_savannah` (bridge to SIP 1151 with the GUID), B parks and hears `public/audio/savannah-hold.wav` + onholdmusic; A parks again → re-bridge; Cancel = ext `horry_return`), `deploy/freeswitch/dialplan-horry-agent-first.xml`, `GET api/agent-first/by-ani` for the shared re-entry flow, hand-off record wired to the controller's returned/ended events, Member tab messages for the controller path, 8 vitest cases with a fake ESL (`packages/service/test/agent-first.test.ts`). Kristen: dialplan install + `.env` (`FS_ESL_ENABLED`, `FS_ESL_PASSWORD`) + the flow edit in docs/wxcc-flow-notes.md §A, then joint test. **First live test 11/03 ~09:05 ET:** loop-back, Member tab pop, hold announcement and Savannah's payment greeting all worked; after she finished the member heard silence and never came back — her SIP leg did not drop / A never parked, so the service now recalls the member itself (wrap-up + 7 s, post-call webhook, CHANNEL_UNBRIDGE/her leg's hangup → ext horry_return). Note: freeSWITCH's /var/log/freeswitch/freeswitch.log stopped 2026-09-18, so the service traces every event on its legs (journalctl -g AGENT-FIRST). Desktop must be reloaded after a widget deploy. Flow edits: docs/wxcc-flow-notes.md §A (8486 branch) only; §B is optional. Superseded: EP_KC_Horry_Payment / 9729038486 branch, Queue To Agent, the Desktop SDK transfer attempts (code still present for calls that don't come through the controller). Member tab: the separate Billing card is gone (it repeated the account strip); On file / Budget plan / Extension now sit at the right of the strip; Amount due says "· past due".

2026-11-02 (late) — Member tab: outage banner + card only while Savannah is on (DTO aiOn); all action buttons navy (button.primary = --h-navy); Calls page adopts the task via the Desktop SDK (nav pages get literal $STORE bindings).

2026-11-02 (late) — **Two payment systems** (Kristen): cards = Meridian (SEDC), e-checks = Milsoft. Savannah always asks "credit card on file, e-check on file, or a new card?" (get_billing how_to_pay; new tool pay_with_echeck_on_file = recorded draft, no Milsoft sandbox); same question on hand-offs and reminder calls; overview page v19 §5.

2026-11-02 — **Three demo use cases** (Kristen): 1 agent hands a payment to Savannah and gets the call back — BUILT 11/02 evening, inside WxCC: Member tab / Calls page button → POST api/agent-desk/handoff (src/handoff.ts) → Transfer → Entry point EP_KC_Horry_Payment (972-903-8486) → flow GET api/handoff/by-ani → bridge 1151 → payment-only script → wrap_up → Queue To Agent by email (build sheet in docs/wxcc-flow-notes.md). Kristen: finish the DNIS branch + Queue To Agent; re-upload KC_Horry.json (new Calls nav page). Live test pending, 2 storm (built: one Savannah switch; AI Operations is now one toggle + Outage team staffing, no "queue" wording), 3 payment reminders from a CSV by voice or text — BUILT 11/02 evening: supervisor nav page Payment reminders (<horry-reminders>, preview reminders.html, sample reminders-sample.csv), POST api/reminders → src/reminders.ts batches; voice = ElevenLabs Twilio outbound (src/outbound.ts; needs ELEVENLABS_PHONE_NUMBER_ID + OUTBOUND_CALLER_NUMBER from scripts/attach-outbound-number.mjs, else simulated), text = pay link; outcomes from the post-call webhook; Customer Review shows them as outbound call / text with topic Payment reminder. Live call test pending. Member tab: talking points removed, life-support/bank-draft badges removed, big red outage badge, due date red when past due, "What Savannah did" hidden on agent-only calls. Customer Review must show all three when built.

2026-10-29 (afternoon) — Call Review renamed **Customer Review** (layout nav too): channel filter + phone vs web chat table. Web Chats: Savannah summary on top, scrolling transcript, bigger reply box + quick replies. AI Operations: switches + summary line, Reset button (Reset now really restores balances). Savannah: spoken house numbers, safety question only on outage calls, outage greeting only in Storm Mode. (11/02: AI Operations mode cards side by side with tinted headers — green on, light red off; summary banner the same; Outage queue staffing card goes green with the extra teams highlighted when storm staffing is live. Later 10/29: no outage greeting at all; for a known caller she asks "Am I speaking with Linda?", checks the address, then "I see there is an outage in your area. Is this the reason for your call?" in either mode.)

2026-10-29 (later) — Call Review: date range (presets + from/to, Eastern), CSV download, print/PDF; agent-only calls listed as "Agent only" and kept out of Savannah's KPIs; sample day + by-hour in Eastern regardless of server TZ. AI Operations: green on / red off buttons + ON/OFF badges. Member tab: 13-month usage chart. Flow bug (call-context arrived with an empty ani) — fixed in Designer by Kristen 2026-11-02 (`{{NewPhoneContact.ANI}}`).

2026-10-29 — **AI agent for all calls** (Kristen): supervisor page renamed AI Operations; new switch above Storm Mode. Global_StormMode now = "send to Savannah" (storm OR aiAll), so no flow / Control Hub change; Savannah uses the everyday greeting + a busy-day playbook line when only aiAll is on. Deployed and KC_Horry.json re-uploaded 2026-11-02.

2026-10-29 — demo site restyled to the co-op's real home page (`site.html`, logo + hero cropped from docs/ screenshot; chat bubble in co-op blue); card-on-file wording tightened + agent patched.

2026-10-28 night — **live on kc-dev-2 and taking calls; overnight build added the agent
member card + billing screen pop, web chat and the email pick board (commit d6b6a78, not
deployed yet).**

- Live: service `/horry/` (systemd `horry-demo`), FS `horryelectric` → Savannah on 1151,
  Service App (Storm Mode + staffing write WxCC), demo line (972) 430-9658 → `EP_KC_Horry` →
  flow `KC_Horry_Electric` (Kristen built it; after the bridge it reads `GET api/intake/{GUID}`).
  Storm Mode → Savannah confirmed working on a live call.
- Demo logins: supervisor on `KC_HorryElectric`; billing agent on `KC_Horry_Billing`
  (staffs `Q_Horry_Billing`). Run-of-show + tests A–D: team page §3 (`docs/demo-overview.html`).
- Savannah: escalate → she finishes, calls end_call, controller hands back (FS grace 12 s,
  freeSWITCH c2e320e). Keypad pay not offered (not built).
- New pages: `site.html` (demo co-op site + chat bubble), `billing.html?sep=` (mock CIS
  screen), previews `agent.html`, `email.html`, `supervisor.html`.
- Layout `KC_Horry.json` regenerated: Member panel tab (agent personas), chat badge,
  Web Chats + Email nav pages, AI Operations (dashboard icon; was Storm Operations), Call Review.

2026-10-27 evening — service + agent built.

- Repo `GitHub KC/horryDemo` → `kristencWFC/horryDemo` (Kristen created it; local commits
  NOT pushed). The empty `GitHub KC/horry-electric` folder is a leftover (locked by an
  editor) — delete it.
- Service builds clean; local end-to-end smoke passed (call-context → initiation →
  outage status → SMS signup → billing with usage vs last year → payment link → token
  sale → balance drops; lookup by address → extension → outage report → escalate;
  ETR change + restore → texts; OUT reply → nested ticket; card on file → approved).
- ElevenLabs agent `horryDemo` configured (12 tools, Savannah, Crete/Infinity voice,
  Horry initiation + post-call webhooks). SIP number **1151** assigned 2026-10-28.
- freeSWITCH repo commit `87bb1f6` adds the `horryelectric` solution (not pushed).

## Decisions

1. ✅ kcdev2 **:8165**, `/horry/`, systemd `horry-demo`, `/opt/horryDemo`.
2. ✅ Dedicated PCI-Mode Twilio account — yes (Kristen). Stripe dropped: payments go via the
   Meridian Payment Gateway (mock). Pay Connector choice depends on Meridian's token answer.
3. ✅ Storm Mode = **WxCC global variable**, flipped from the supervisor desktop widget
   (middleware writes it via Config API + Service App).
4. ✅ Queues `Q_Horry_Outage` / `Q_Horry_Billing`; agent `horryDemo`; Savannah + Jessica voice.
   SIP number **1151** (1150 was taken outside our workspace — ElevenLabs SIP numbers are
   globally unique). Created + assigned 2026-10-28, inbound verified.
   Names in WxCC (EP, queues, variable) are free — the service never references them.
   Storm variable: **String** `true`/`false` (Boolean also works — the PUT writes the same
   text). Service App: a NEW one for Horry (needs config write; Crete's app only reads the
   Search API, and sharing one refresh token between two services breaks on rotation).
5. ⏳ (pending) — Kristen.
6. ✅ NextGen CIS = Meridian's IVR/RPS API; Horry runs Meridian UPN. Mock mirrors it.
7. Scope cut (HLD §5) — assumed agreed.
8. ✅ Keypad card capture (Kristen 2026-10-28): **demo = our freeSWITCH collects the keypad digits
   (Savannah paused, digits never reach ElevenLabs) and posts straight to Meridian ivr/sale; production
   option presented = Twilio Pay** (keeps WFC out of PCI scope). Card number by VOICE is ruled out — the
   spoken digits would land in ElevenLabs STT/LLM/transcripts and the recordings.
   Web chat escalation lands in OUR desktop widget, like Infinity (Kristen 2026-10-28).
   Global_StormMode created in Control Hub (String, default false) — put its id in
   WXCC_STORM_VARIABLE_ID.
9. Discovery-call questions: OMS vendor (Futura?); NextGen API enabled on their UPN +
   NISC support post-merger; which card tokens Meridian's gateway accepts; outage line
   843-369-2212 vs main; what "email ticketing" means to them; NISC CallCapture IVR in use?

## Kristen's next steps (in order)

- [x] Push `horryDemo` (2026-10-28)
- [x] Push `freeSWITCH` (87bb1f6 + db02a1b, the 1151 sipNumber commit) — kc-dev-2 pulls workflowconcepts/freeSWITCH
- [x] SIP number 1151
- [x] Deploy on kc-dev-2 (`/opt/horryDemo`, systemd `horry-demo`, ce402a9) + nginx `/horry/` — public `/horry/health` OK 2026-10-28
- [x] FS box: pulled db02a1b, `horryelectric` block (cloned from `homeservices`, sipNumber 1151) in server `config.json`, ivr-controller restarted active — 2026-10-28
- [x] Server `.env`: Service App creds + `WXCC_STORM_VARIABLE_ID` + `WXCC_OUTAGE_QUEUE_ID` → `/health` shows `wxcc:true`, `staffing:true` — 2026-10-28
- [x] Control Hub: `Global_StormMode` (String, false), team `KC_HorryElectric`, queue `Q_Horry_Outage` — 2026-10-28
- [x] Firewall: tcp:8165 nginx box → kc-dev-2 — 2026-10-28
- [x] Control Hub: EP + DID (972) 430-9658, Service App — 2026-10-28
- [ ] Control Hub: `Q_Horry_Billing` staffed by `KC_Horry_Billing`; extra `KC_Horry_*` teams; layout `KC_Horry` on both teams
- [x] Designer: `KC_Horry_Electric` per `docs/wxcc-flow-notes.md` — 2026-10-28
- [ ] Push horryDemo + freeSWITCH; kc-dev-2: pull both, build, restart `horry-demo` + `ivr-controller`
- [x] THEN upload the regenerated `KC_Horry.json` (widgets first — lockstep rule) — 2026-11-02
- [ ] Optional: `EMAIL_AGENTS=` real agent names in server `.env` for the email assign list
- [x] **Texting live** 2026-10-29: `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_SMS_FROM` in server .env. US carriers filter unregistered 10-digit numbers: use a number already on an approved A2P 10DLC campaign or a verified toll-free number. Demo text recipient = AI Operations → Demo caller → Send demo texts to (built 2026-10-29)
- [ ] Twilio: SMS number inbound webhook → `/horry/webhooks/twilio/sms`; PCI-Mode account for Pay

## Phase 4 — payments

- [x] Card on file (`saleWithProfile`), secure link (`pay.html` → token sale). 2026-10-29: Savannah reads the real brand + last four ("Visa ending 4 2 4 2"), says "one moment", reads the confirmation. Demo: call as Linda (Visa 4242) or David (Mastercard 1881)
- [ ] (deferred 2026-10-28: changes the shared FS controller every AI demo runs through and can't
      be tested without live calls — talk track for Nov 4; Savannah no longer offers keypad)
      **Keypad pay for the demo: freeSWITCH collects digits** (pause Savannah, play_and_get_digits,
      no logging, POST Meridian ivr/sale, resume Savannah with the result). Mock gateway must accept
      CardAccountNumber for TEST cards on this path only. Twilio Pay = production slide.
- [ ] Agent-initiated secure pay + return to the same agent (flow notes "phase 4")

## Phase 5 — widgets, chat, dashboard (next build session)

- [x] Supervisor widget (Storm Mode button + outage queue staffing) — 2026-10-28
- [x] Desktop widgets — 2026-10-28 night: `<horry-member>` (NISC account, what Savannah did,
      rule-based talking points, billing assistant: pay link / card on file / extension / note),
      `agent-desk.ts`; mock CIS screen `billing.html?sep=`
- [x] Web chat — 2026-10-28 night: `site.html` + `chat-bubble.js`, `chat.ts` (live text
      conversation with Savannah when ELEVENLABS env set, scripted fallback over our own tools),
      `<horry-chat>` page + `<horry-chat-badge>`. Chats saved to data/chats.json, ended chats listed 7 days for review (2026-10-29).
- [x] **Call review dashboard** `/horry/dashboard.html` (2026-10-28, Kristen: item 5) — containment,
      topics from the conversation (AI leg + Cisco wrap-up summary), by hour, sentiment, wrap-up codes,
      per-call drill-in with both legs. Sample storm day (yesterday, deterministic) + live overlay.
      Live-agent leg: `agent-summaries.ts` — WXCC_SUMMARY_URL poll (Cisco: AI summaries retrievable
      by API for 24 h) [CONFIRM endpoint on developer.webex.com], or POST api/calls/:guid/agent-leg,
      else simulated 45 s after an escalated call ends.
- [ ] Agent widget: capture the AI Assistant wrap-up summary from the Desktop SDK and POST it
      (the live path if the REST endpoint isn't available)
- [ ] Real voice restoration callbacks (ElevenLabs outbound) — simulated today
- [ ] LAST (Kristen 2026-10-29): inbound text replies (Twilio inbound) — hard to add, may not be needed
- [ ] Agent data-collection fields (sentiment, call_reason) for post-call analysis
- [ ] Email inbox beat (optional), storm roster page (optional)
- [x] **Outage queue staffing** (discovery item 3; Kristen 2026-10-28: add the extra staff's
      TEAMS to the outage queue) — in `<horry-supervisor>` with the Storm Mode button; `staffing.ts`
      edits Q_Horry_Outage's distribution group via Config API (sim teams when unset). VERIFY the
      queue PUT on the first live test. Preview `/supervisor.html`; layout snippet docs/desktop-layout.md
- [x] **Billing screen pop** — 2026-10-28 night (see Desktop widgets)
- [x] **Email pick board** — 2026-10-28 night: `email.ts` + `emails.seed.json` (12 emails),
      `<horry-email>` page: pick/assign/release, template drafts from the member's data, send
      (simulated, account note logged), Storm Mode outage-group bulk reply. Drafts for tree
      trimming / transfer / medical promise actions nothing performs — read before sending.
- [x] **Show Cisco's auto wrap-up summary** — Kristen 2026-10-29: it already shows on the live agent's Desktop; dashboard copy stays simulated until the API is confirmed. (was: Kristen 2026-10-28) — WxCC AI Assistant
      generates the call summary + wrap-up code when a live agent ends the call. Enable AI
      Assistant auto-summary on the Horry team/queues and show it after the escalated call
      (pairs with our "what the AI did" widget: ours = the AI leg, Cisco's = the agent leg).

## Phase 6 — docs

- [ ] DEMO-STEPS.md run-of-show; kc-wiki topology claim for :8165
2026-11-04 — Demo personas renamed gender-neutral so any presenter can play them (Kristen): Casey Hardee, Morgan Jordan, Jamie Skipper, Riley Nguyen, Avery Bellamy, Taylor Causey (seeds, emails, sample CSV, docs, call-flow page); member pronouns in the docs → they/them; Customer Review sample names neutral too. Savannah unchanged.
