# TODO — Horry Electric demo

Demo **Wed 2026-11-04 10:00 AM ET**. Discovery call this week (Wed 10/28 or Thu 10/29 —
Nick confirming).

## STATE (handoff)

2026-10-27 evening — **service + agent built, not deployed.**

- Repo `GitHub KC/horryDemo` → `kristencWFC/horryDemo` (Kristen created it; local commits
  NOT pushed). The empty `GitHub KC/horry-electric` folder is a leftover (locked by an
  editor) — delete it.
- Service builds clean; local end-to-end smoke passed (call-context → initiation →
  outage status → SMS signup → billing with usage vs last year → payment link → token
  sale → balance drops; lookup by address → extension → outage report → escalate;
  ETR change + restore → texts; OUT reply → nested ticket; card on file → approved).
- ElevenLabs agent `horryDemo` configured (12 tools, Savannah, Crete/Infinity voice,
  Horry initiation + post-call webhooks). **No SIP number yet** (1150 refused).
- freeSWITCH repo commit `87bb1f6` adds the `horryelectric` solution (not pushed).

## Decisions

1. ✅ kcdev2 **:8165**, `/horry/`, systemd `horry-demo`, `/opt/horryDemo`.
2. ✅ Dedicated PCI-Mode Twilio account — yes (Kristen). Stripe dropped: payments go via the
   Meridian Payment Gateway (mock). Pay Connector choice depends on Meridian's token answer.
3. ✅ Storm Mode = **WxCC global variable**, flipped from the supervisor desktop widget
   (middleware writes it via Config API + Service App).
4. ✅ Queues `Q_Horry_Outage` / `Q_Horry_Billing`; agent `horryDemo`; Savannah + Jessica voice.
   ❗ **SIP number**: ElevenLabs says "1150 already exists" (not in our workspace). Pick
   another (e.g. 1151 / 11500) → `node scripts/provision-agent.mjs --sip-number <n> agent_5701m5zn0g2jegma4z7p0wpc255m`.
5. ⏳ (pending) — Kristen.
6. ✅ NextGen CIS = Meridian's IVR/RPS API; Horry runs Meridian UPN. Mock mirrors it.
7. Scope cut (HLD §5) — assumed agreed.
8. Discovery-call questions: OMS vendor (Futura?); NextGen API enabled on their UPN +
   NISC support post-merger; which card tokens Meridian's gateway accepts; outage line
   843-369-2212 vs main; what "email ticketing" means to them; NISC CallCapture IVR in use?

## Kristen's next steps (in order)

- [ ] Push `horryDemo` + `freeSWITCH` (87bb1f6)
- [ ] Pick the SIP number (above); tell Claude or run the one-liner
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

## Phase 6 — docs

- [ ] DEMO-STEPS.md run-of-show; kc-wiki topology claim for :8165
