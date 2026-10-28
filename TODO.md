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
8. ❓ Keypad card capture (Kristen 2026-10-28): Twilio Pay vs our freeSWITCH collecting digits
   (ElevenLabs paused) and posting straight to Meridian ivr/sale. Awaiting Kristen.
9. Discovery-call questions: OMS vendor (Futura?); NextGen API enabled on their UPN +
   NISC support post-merger; which card tokens Meridian's gateway accepts; outage line
   843-369-2212 vs main; what "email ticketing" means to them; NISC CallCapture IVR in use?

## Kristen's next steps (in order)

- [x] Push `horryDemo` (2026-10-28)
- [ ] Push `freeSWITCH` (87bb1f6 + the 1151 sipNumber commit) — origin kristencWFC/freeSWITCH
- [x] SIP number 1151
- [ ] Deploy per `OPERATIONS.md` (server `.env` table) + nginx snippet on the front box
- [ ] FS box: pull, add `horryelectric` block to server `config.json`, restart ivr-controller
- [ ] Control Hub: `Global_StormMode` variable, EP + DID, queues; Service App (config write)
- [ ] Designer: `KC_Horry_Electric` per `docs/wxcc-flow-notes.md`
- [ ] Twilio: SMS number inbound webhook → `/horry/webhooks/twilio/sms`; PCI-Mode account for Pay

## Phase 4 — payments

- [x] Card on file (`saleWithProfile`), secure link (`pay.html` → token sale)
- [ ] Twilio Pay keypad out-and-back (FS → Twilio `<Pay>` → back with X-Pay-* headers)
- [ ] Agent-initiated secure pay + return to the same agent (flow notes "phase 4")

## Phase 5 — widgets, chat, dashboard (next build session)

- [ ] Desktop widgets: member card (NextGen screen pop), "what the AI did" journey +
      transcript, billing assistant (Claude tool loop over the same tools), supervisor
      **Storm Mode button** (→ `POST api/mode`); layout `KC_Horry.json` (widgets first)
- [ ] Web chat on a mock horryelectric.com page (home-services `chat.ts` pattern)
- [ ] Storm-day dashboard (aiops baseline + live overlay; tags, sentiment, drill-in)
- [ ] Real voice restoration callbacks (ElevenLabs outbound) — simulated today
- [ ] Agent data-collection fields (sentiment, call_reason) for post-call analysis
- [ ] Email inbox beat (optional), storm roster page (optional)
- [ ] **Storm roster** (gap vs discovery item 3 — they plan to add up to 50 staff to an outage
      queue): pre-built storm team, softphone login, supervisor adds people to Q_Horry_Outage. To decide.
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
