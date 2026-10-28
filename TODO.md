# TODO — Horry Electric demo

Demo **Wed 2026-11-04 10:00 AM ET**. Discovery call this week (Wed 10/28 or Thu 10/29 —
Nick confirming).

## STATE (handoff)

2026-10-28 — **service + agent built, SIP 1151 assigned, not deployed.** Demo explainer
page published (claude.ai artifact; source `docs/demo-overview.html`).

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
- [ ] Push `freeSWITCH` (87bb1f6 + the 1151 sipNumber commit) — origin kristencWFC/freeSWITCH
- [x] SIP number 1151
- [ ] Deploy per `OPERATIONS.md` (server `.env` table) + nginx snippet on the front box
- [ ] FS box: pull, add `horryelectric` block to server `config.json`, restart ivr-controller
- [x] Control Hub: `Global_StormMode` (String, false), team `KC_HorryElectric`, queue `Q_Horry_Outage` — 2026-10-28
- [x] Firewall: tcp:8165 nginx box → kc-dev-2 — 2026-10-28
- [ ] Control Hub: EP + DID, `Q_Horry_Billing`, extra department teams, Service App (config write)
- [ ] Upload `deploy/desktop-layout/KC_Horry.json` AFTER the widgets are deployed; assign to KC_HorryElectric
- [ ] Designer: `KC_Horry_Electric` per `docs/wxcc-flow-notes.md`
- [ ] Twilio: SMS number inbound webhook → `/horry/webhooks/twilio/sms`; PCI-Mode account for Pay

## Phase 4 — payments

- [x] Card on file (`saleWithProfile`), secure link (`pay.html` → token sale)
- [ ] **Keypad pay for the demo: freeSWITCH collects digits** (pause Savannah, play_and_get_digits,
      no logging, POST Meridian ivr/sale, resume Savannah with the result). Mock gateway must accept
      CardAccountNumber for TEST cards on this path only. Twilio Pay = production slide.
- [ ] Agent-initiated secure pay + return to the same agent (flow notes "phase 4")

## Phase 5 — widgets, chat, dashboard (next build session)

- [x] Supervisor widget (Storm Mode button + outage queue staffing) — 2026-10-28
- [ ] Desktop widgets: member card (NextGen screen pop), "what the AI did" journey +
      transcript, billing assistant (Claude tool loop over the same tools), supervisor
      **Storm Mode button** (→ `POST api/mode`); layout `KC_Horry.json` (widgets first)
- [ ] Web chat on a mock horryelectric.com page (home-services `chat.ts` pattern)
- [x] **Call review dashboard** `/horry/dashboard.html` (2026-10-28, Kristen: item 5) — containment,
      topics from the conversation (AI leg + Cisco wrap-up summary), by hour, sentiment, wrap-up codes,
      per-call drill-in with both legs. Sample storm day (yesterday, deterministic) + live overlay.
      Live-agent leg: `agent-summaries.ts` — WXCC_SUMMARY_URL poll (Cisco: AI summaries retrievable
      by API for 24 h) [CONFIRM endpoint on developer.webex.com], or POST api/calls/:guid/agent-leg,
      else simulated 45 s after an escalated call ends.
- [ ] Agent widget: capture the AI Assistant wrap-up summary from the Desktop SDK and POST it
      (the live path if the REST endpoint isn't available)
- [ ] Real voice restoration callbacks (ElevenLabs outbound) — simulated today
- [ ] Agent data-collection fields (sentiment, call_reason) for post-call analysis
- [ ] Email inbox beat (optional), storm roster page (optional)
- [x] **Outage queue staffing** (discovery item 3; Kristen 2026-10-28: add the extra staff's
      TEAMS to the outage queue) — in `<horry-supervisor>` with the Storm Mode button; `staffing.ts`
      edits Q_Horry_Outage's distribution group via Config API (sim teams when unset). VERIFY the
      queue PUT on the first live test. Preview `/supervisor.html`; layout snippet docs/desktop-layout.md
- [ ] **Billing screen pop** (Kristen 2026-10-28): widget shows key NISC data (balance, due,
      cut-off, payment history, usage, outage) + a FAKE billing-system account page the call opens
      (generic look — not NISC branding)
- [ ] **Email pick board** (Kristen 2026-10-28 idea for "email ticketing"): reuse the Crete pick
      widget — emails as cards with account + topic + age, pick/assign, AI-drafted reply, storm grouping
- [ ] **Show Cisco's auto wrap-up summary** (Kristen 2026-10-28) — WxCC AI Assistant
      generates the call summary + wrap-up code when a live agent ends the call. Enable AI
      Assistant auto-summary on the Horry team/queues and show it after the escalated call
      (pairs with our "what the AI did" widget: ours = the AI leg, Cisco's = the agent leg).

## Phase 6 — docs

- [ ] DEMO-STEPS.md run-of-show; kc-wiki topology claim for :8165
