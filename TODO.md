# TODO — Horry Electric demo

Demo **Wed 2026-11-04 10:00 AM ET**. Discovery call this week (Wed 10/28 or Thu 10/29 —
Nick confirming).

## STATE (handoff)

2026-10-27: repo created, design drafted (`docs/HLD.md`), research saved
(`docs/research/`). **Nothing built.** Waiting on Kristen's answers to the decisions below.

## Decisions (Kristen)

1. **Infra** — kcdev2 **:8165** (next free per kc-wiki topology), prefix `/horry/`, systemd
   `horry-demo`, `/opt/horry-electric`. Confirm against live nginx.
2. **Secure payments** — OK to provision a **dedicated Twilio account/project with PCI
   Mode** (irreversible, account-wide) + Stripe test account? Or simulate payments for Nov 4?
3. **Storm Mode switch** — middleware flag read by the flow (recommended) vs a WxCC
   global variable.
4. **WxCC** — new DID + EP `EP_KC_Horry`, flow `KC_Horry_Electric`, queues
   `Q_Horry_Outage` + `Q_Horry_Billing`, team for the demo. Designer build by Kristen.
5. **ElevenLabs** — new agent "Horry Electric" (persona name/voice?), next free SIP number
   (1126–1130 appear taken — confirm), freeSWITCH registry `horryelectric`.
6. **"NextGen CIS"** — no public NISC/Meridian product by that name and no prior WFC repo
   work found. Which client did we integrate with it for? If we have its API docs, the mock
   CIS should mirror its shapes.
7. **Scope cut** (HLD §5) — agree Must/Should/Could.
8. **Discovery-call questions** — OMS vendor (Futura?), outage line 843-369-2212 vs main
   line, email ticketing meaning, payment processor today (InvoiceCloud?), NISC CallCapture
   IVR in use with the Mitel?

## Phase 1 — scaffold (after decisions)

- [ ] npm workspaces (shared / service / widgets), env.ts, JSON store, deploy/ unit + nginx
- [ ] Mock CIS + seeded personas (one on Kristen's cell)
- [ ] ModeStore + supervisor page + `GET api/mode`

## Phase 2 — voice AI

- [ ] call-context, conversation-initiation, tools (get_member, get_outage_status,
      report_outage, subscribe_restoration, get_balance, start_secure_payment, escalate)
- [ ] ElevenLabs agent setup doc + provisioning script
- [ ] freeSWITCH registry + config block (in freeSWITCH repo — needs Kristen's OK)
- [ ] wxcc-flow-notes.md build sheet

## Phase 3 — outage + notify

- [ ] OutageStore + outages page (ETR, mark restored), NotifyEngine (SMS, AI callback),
      nested-outage reply handling

## Phase 4 — payments

- [ ] Twilio Pay webhooks + Stripe connector; freeSWITCH out-and-back; pay simulator
- [ ] Agent-initiated secure pay + return-to-agent flow notes

## Phase 5 — widgets, chat, dashboard

- [ ] member card, AI summary/journey, billing assistant, supervisor toggle; layout JSON
- [ ] web chat site page
- [ ] dashboard (aiops baseline + live overlay, tags, sentiment, drill-in)

## Phase 6 — docs

- [ ] DEMO-STEPS.md, OPERATIONS.md, kc-wiki topology claim for :8165
