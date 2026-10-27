# Horry Electric Cooperative Demo — High Level Design

Status: **v0.1 draft** (2026-10-27) — design only, nothing built. Customer demo
**Wed 2026-11-04, 10:00 AM ET** (Dale Johnson, IT Manager, + 8–10 across business
functions; brought by Nick Mazzarese, Cisco). Pre-demo discovery call this week (Jerry
Lyon attending). Source: Nick's 10-point discovery summary
(`docs/client/discovery-summary.md`), WFC record
`02-sales/wxcc-contact-center/2026-10-27-opportunity-intake-notes.md`.

Research behind this design: `docs/research/nisc-meridian.md`,
`docs/research/pci-payments.md`.

---

## 0. The pitch in one paragraph

Horry Electric is a ~105k-member electric co-op in Conway, SC, replacing a 26-year-old
Mitel. Their worst day is a storm: call volume explodes, 50 people from other departments
get pressed into an "outage queue", and every member asks the same three questions — *is
it reported, when is it coming back, will you tell me when it's back*. The demo shows a
supervisor flipping **one switch** that puts an AI outage agent in front of the queue: it
identifies the member from their phone number in the **NISC/Meridian CIS**, tells them if
their outage is already known (with the restoration estimate), reports it if not, catches
the dangerous calls (wires down, life support) and sends them straight to a person, and
signs them up for a **text or callback when power is restored** — which the system then
actually sends. The same AI answers billing on a blue-sky day and takes **card payments
on the keypad without the card number ever reaching the AI, the agent, or the
recording**. A live agent can hand a caller to that same secure payment step and get them
back. An exec dashboard shows storm-day AI stats, auto-tagged call reasons (replacing
their manual single-code system), sentiment, and a summary of every call.

## 1. Discovery → demo map

| # | Discovery item | Demo answer | Scene |
| --- | --- | --- | --- |
| 2 | 33–35 agents, 128 users | Sized narrative; WxCC + Webex Calling for the whole org | — |
| 3 | **Storm ops: 50 extra ACD agents, outage queue** | **Storm Mode switch** → AI outage agent first; storm roster page (bulk-add temporary agents to the outage team) | 1, 2 |
| 4 | Mitel: clunky ACD setup, bad reporting | Storm roster in seconds; dashboard + WxCC Analyzer | 2, 6 |
| 5 | **Reporting + AI auto call tagging** | Every call (AI and human) auto-tagged with reason + sentiment + summary; drill-in | 6 |
| 6 | Email ticketing, **web chat**, social | Web chat on a mock horryelectric.com (Infinity pattern); email → AI-tagged queue tasks (§2.8) | 5 |
| 7 | Desk phones + softphones | Narrative only (Webex Calling devices) | — |
| 8 | Cloud OK | Narrative | — |
| 9 | **NISC (formerly Meridian) CIS screen pop** | Mock CIS account card on every call; AI uses the same lookups | 3, 4 |
| 10 | **Recording + PCI without affecting SAQ D** | Secure keypad payment (Twilio Pay → Stripe test); card never on the WxCC/AI path, so recording needs no pause | 3, 4 |

## 2. Components

### 2.1 Storm Mode (the supervisor switch)

One flag in the middleware, flipped from a **supervisor page** and a **desktop widget
toggle** (supervisor layout). The WxCC flow's first HTTP node reads it:

```
GET {mw}/api/mode?dnis=…  →  "storm" | "normal" | "overflow"
```

- `normal` → today's routing straight to the billing / member-services queue.
- `storm` → every call to the outage line (and the main line's outage branch) bridges to
  the AI outage agent first. Only escalations reach humans.
- `overflow` (stretch) → AI only when `Q_Horry_Outage` waits exceed N — the middleware
  answers from WxCC queue stats (pattern: kc-wiki `wxcc-apis-skills-and-stats`).

The switch is logged (who, when) and shown as a banner on every page and widget. The
dashboard can also *suggest* storm mode when the reports-per-minute curve spikes ("12
outage reports in 3 minutes from Socastee — turn on Storm Mode?").

**Why a middleware flag, not a WxCC global variable:** one place to flip it from our own
pages, auditable, and the flow change is a single HTTP node + Case. A Control Hub global
variable is the production-native alternative; mention it as an option.

### 2.2 AI outage agent (ElevenLabs via freeSWITCH)

Call path = home-services / Aliv pattern, unchanged:

```
Caller → WxCC EP_KC_Horry (new DID) → flow KC_Horry_Electric
  1. GUID → GET api/mode → GET api/call-context?ani&dnis&id  (seeds the member row by ANI)
  2. storm? BridgeTransfer DN 1122, X-Solution-Name=horryelectric, X-Call-GUID
        → freeSWITCH registry horryelectric → ElevenLabs agent "Horry Electric" (new SIP number)
        → conversation-initiation webhook → member facts as dynamic variables
        → webhook tools → {mw}/api/tools/*  (X-Tool-Secret)
        → escalate → BYE X-IVR-* headers
  3. on return: X-IVR-Escalate=true → CAD (reason, urgency, summary, account, refCode)
        → Q_Horry_Outage (urgent → priority) → pick/queue → screen pop
```

**Conversation (outage playbook):**

1. **Identify** — ANI → CIS lookup before the agent speaks ("Hi, this is Ava with Horry
   Electric. I see this number on the account at 1420 Cultra Road — is that where the
   power is out?"). No match → account number, or service address + last name.
2. **Safety first, always** — "Are there any wires down, sparking, or a tree on a line?"
   Yes → *"Please stay at least 35 feet away and keep others away"* → immediate escalate,
   `urgency=emergency`, to the top of the queue (and a dispatcher alert on the board).
3. **Life support / medical necessity** — CIS flag or caller says so → priority tag +
   escalate if they ask; otherwise continue with priority on the ticket.
4. **Known outage?** — `get_outage_status(servicePoint)`:
   - Known → "Yes — we know about it. It's affecting about 1,240 members in the Socastee
     area, crews are on site, and the estimate to restore is 4:30 this afternoon."
   - Unknown → `report_outage` with the triage questions: whole house or part of it
     (partial = likely the member's side / one leg — different advice), neighbors out
     too, anything heard or seen (bang, flash → likely transformer/fuse). Reference number
     spoken back.
5. **Restoration notice** — "Would you like a text when your power is back, or a call?"
   → `subscribe_restoration(channel=sms|voice, phone)` (offer a different number than
   the ANI). Also offered: ETR-change updates.
6. **Wrap** — "Anything else?" Billing questions on a storm day: answer balance/due date
   in one line; payments are offered (§2.5) but never pushed during an outage.

**Escalation rules:** wires down / fire / emergency, caller asks for a person, upset
caller (sentiment), unidentified member after two tries, anything out of scope.

**Extra ideas worth showing (pick for the scope cut, §5):**

- **Nested-outage catch** — when an outage is restored, the restoration message asks
  "Is your power back on? Reply NO if not." A NO (text) or "no" (voice) auto-opens an
  *individual* outage ticket for that service point — the member whose transformer
  stayed out after the feeder came back. This is a real, painful utility problem.
- **Cluster detection** — reports grouped by substation/feeder on the dashboard; when N
  unknown-outage reports land on the same feeder the AI starts telling callers "we're
  seeing several reports from your area" (social proof, fewer repeat calls).
- **Proactive storm outreach** — pre-storm SMS ("Hurricane season tip: report outages
  at 843-369-2212 or text OUT") and a broadcast message the supervisor edits on the
  storm page, spoken once by the AI (the Aliv broadcast-message pattern).
- **Text-to-report** — member texts OUT to the outage number → the same `report_outage`
  tool runs over SMS (Twilio inbound, home-services SMS store). Cheapest deflection
  there is.
- **Spanish** — the agent switches language on request (ElevenLabs multilingual).
- **Storm roster** — page that bulk-assigns 50 "temporary storm agents" to the outage
  team and skill in one click (mocked, with the real WxCC bulk API named — kc-wiki
  `wxcc-bulk-config-apis`). Answers item 3/4 ("difficult ACD user setup") directly.

### 2.3 Restoration notifier (callbacks + texts)

The piece that manages the promises the AI made. A store of
`OutageEvent { id, feeder, area, servicePoints[], customersAffected, etr, status }` and
`RestorationSubscription { member, phone, channel, outageId, status }`.

- **Outage control page** (stands in for their OMS): list of active outages, edit ETR,
  "Mark restored". In production this is an OMS webhook/poll — **OMS vendor is an open
  question** (Nick asking; Futura/Meridian is plausible, unconfirmed).
- ETR change → texts every subscriber on that outage ("Updated estimate: 6:15 PM").
- Mark restored → for each subscriber: **SMS** (Twilio) or **AI outbound callback**
  (ElevenLabs outbound, outboundDialer pattern — "Hi, this is Ava from Horry Electric
  calling to let you know power has been restored at 1420 Cultra Road. Is your power
  back on?"). No → nested-outage ticket (§2.2). No answer → leave voicemail + fall back
  to SMS.
- Paced sends with a live progress bar (the home-services SMS blast pacing) — "1,240
  members notified in 40 seconds" is the beat.

### 2.4 Mock NISC / Meridian CIS

**Finding:** Horry's member portal ("MyEnergy Online", myenergy.horryelectric.com) is
Meridian Cooperative's product (Meridian = the former SEDC; billing suite UPN /
utilityPOWERnet). **Meridian merged into NISC on 2026-08-01** — hence "NISC (formerly
Meridian)". There is **no public API documentation** for either; integrations are partner
/ NDA work. We could not find "NextGen CIS" as a public NISC or Meridian product, and no
prior WFC work referencing NISC/Meridian/NextGen exists in GitHub KC or GitHub WFC Repos
— **open decision #6**.

The mock is a small adapter with the realistic field set, so swapping in the real API
later is one file:

- `lookupByPhone(ani)`, `lookupByAccount(acct)`, `lookupByAddress(addr, lastName)`
- account: `accountNumber`, `memberName`, `serviceAddress`, `accountStatus`, `rateClass`
  (RES-1), `meterNumber`, `servicePointId`, `feeder`, `substation`, `lifeSupport`
- billing: `currentBalance`, `pastDue`, `dueDate`, `lastBillAmount/Date`,
  `lastPaymentAmount/Date/Method`, `disconnectPending` + `disconnectDate`,
  `eligibleForExtension`, `bankDraft`, `equalPay` ("Rest Easy"), `paperless`, `prepaid`
- `postPayment(token, amount)`, `createExtension(date)`, `createServiceOrder(type)`
- usage: `kwhLast30`, `averageMonthlyBill` (for "why is my bill so high" — AI compares to
  last year and the weather)

Seeded personas with Conway / Socastee / Myrtle Beach / Loris / Aynor addresses, one of
them mapped to Kristen's cell (agentLiveAssist "Sally Smith" pattern).

### 2.5 Secure payments (PCI) — AI-taken and agent-handed

**Finding (honest version):** ElevenLabs holds a PCI DSS Level 1 Service Provider
certification and supports keypad (DTMF) input — **but keypad digits reach the LLM as a
user turn during the call**; `redact_input` / history redaction only clean the stored
transcript afterwards. So *the ElevenLabs agent must not collect the card*. WxCC has no
native secure voice card capture (App Hub partners do: SecureCall, C3 Payments).

**Design: the AI handles the conversation, Twilio Pay handles the card.**

```
AI: confirms account, balance, amount ("Shall I take a payment of 142 dollars 18?")
  → tool start_secure_payment(amount)  → mw mints a payment session
  → freeSWITCH moves the caller leg to a Twilio number running <Pay>  (AI leg parked)
        caller keys card → expiry → ZIP on the keypad
        Twilio → Stripe (test mode) → token / charge  → action URL gets result + last4 only
  → TwiML <Dial> back to freeSWITCH with X-Pay-Result / X-Pay-Ref headers
  → AI resumes: "Your payment of 142 dollars 18 on the Visa ending 4242 went through —
     confirmation P 7 K 2 9 1. Anything else?"   (or failure → retry once / escalate)
  → mw posts the payment to the mock CIS; widget + dashboard update live
```

**Live agent → secure payment → back to the same agent:**

1. Agent clicks **Take secure payment** in the billing widget (amount prefilled from the
   CIS card). Middleware mints a payment session tied to the interaction + agent ID.
2. Agent **blind-transfers** to the secure-pay DN/EP (the widget can trigger the
   transfer via the desktop SDK, or the agent uses the normal transfer button + a speed
   dial). Agent's leg is free — they can take notes in wrap.
3. The AI greets ("Hi Linda, I'm Ava — I'll take that 142 dollar 18 payment for you on
   your keypad, nothing you enter is heard by anyone"), runs the Twilio Pay step above.
4. Return: freeSWITCH transfers the caller back into a WxCC entry point with CAD
   `paymentRef` + `returnToAgent=<agentId>`; the flow uses **Queue to Agent** (last-agent
   routing) with fallback to the billing queue after 30s. The agent's widget showed
   live progress the whole time (WebSocket: "card entered… authorised ✓ P7K-291").

Why blind transfer and not conference: on a conference the agent's audio path would
carry the keypad tones and the recording would capture them. Out-and-back keeps the
card off the WxCC leg entirely — **so their call recording needs no pause/resume**, which
answers item 10 cleanly.

**Alternative worth naming:** Twilio *Agent Assisted Pay* driven straight from the
widget (agent stays on, sees masked progress, never hears tones) — only possible when the
call is Twilio-native, which ours isn't; production options are this or a WxCC App Hub
partner.

**Sales wording (use verbatim):** "Card details are entered on the caller's keypad and
captured by a PCI DSS Level 1 payment service, which sends them straight to the payment
processor. The AI agent, the live agent, call recordings and transcripts never receive
the card number — only a token and confirmation come back. This is designed to keep your
contact center, AI and phone system out of the cardholder-data flow, which can reduce
your PCI scope; your QSA confirms final scope and SAQ type. The demo uses a payment
processor's test mode." **Never say:** "the AI is PCI compliant", "ElevenLabs makes it
compliant", "you'll become SAQ A".

**Risks / prerequisites:** a **dedicated Twilio account/project** (PCI Mode is
account-wide and irreversible), a Stripe test account + Pay Connector, and **RFC 2833
DTMF end to end** WxCC → CUBE → freeSWITCH → Twilio — test this first, it is the single
thing that can sink the scene. Fallback: env-gated simulator (keypad page in the browser
standing in for the phone's keypad) so the demo still runs.

Other AI billing skills (no card needed): balance / due date / last payment, "why is my
bill high" (usage vs last year), **payment extension** when eligible, disconnect-pending
warning, text a Quick-Pay link (mock MyEnergy page), bank draft / Rest Easy sign-up
request.

### 2.6 Agent desktop widgets (WxCC layout `KC_Horry.json`)

- **Member card (screen pop)** — CIS account: name, address, status pills (Life support,
  Disconnect pending, Bank draft, Rest Easy), balance/due/last payment, outage status for
  their service point with ETR. Present on every call, AI-escalated or not.
- **What the AI did** — journey strip (Identified → Outage known → Subscribed SMS →
  Escalated: wires down) + summary + collapsible transcript (Aliv pattern).
- **Billing assistant (agentic)** — a chat panel inside the widget where the agent asks
  in plain words ("is she eligible for an extension?", "set one up to the 15th", "text
  her a pay link") and Claude runs the same middleware tools the voice AI uses, showing
  each tool call as a card the agent confirms. Plus one-click rail buttons: **Take secure
  payment**, **Payment extension**, **Text pay link**, **Subscribe to restoration
  text**, **Report outage**.
- **Supervisor tab** — Storm Mode switch, live AI conversations, storm roster button.

### 2.7 Web chat (item 6)

Mock horryelectric.com page with a chat bubble (home-services `chat.ts` + stillwater
pattern): the same agent in text mode — check/report an outage by address, balance after
light verification, restoration-text signup, escalate into the agent's widget. Payments
in chat = a **secure pay link**, never card numbers in the chat.

### 2.8 Email ticketing (item 6 — idea, not committed)

What they likely mean: today a shared distribution list gets every email and someone
forwards by hand. WxCC answer: **email as a routed channel** — emails become queued
tasks with SLA timers, auto-acknowledged with a case number, and threaded replies. Our
add: AI reads each email, **tags reason + urgency + account** (matched from the sender
address in the CIS), drafts a reply, and routes to the right team (billing, new service,
right-of-way/tree trimming, outage). Demo version: an inbox tab in the widget with 6
seeded emails tagged live. Recommend **show as a 2-minute slide-plus-widget beat** and
ask questions on the discovery call rather than build the full thing.

### 2.9 Executive dashboard (items 4, 5)

Storm-day view with a date picker of "storm days":

- AI calls handled, **containment %**, escalations by reason, avg handle time AI vs
  human, peak calls/min curve with the Storm Mode on/off band
- Outage reports created, known-outage confirmations (calls deflected), restoration
  subscriptions → notifications sent → "power back?" confirmations / nested outages caught
- Payments taken by AI vs agent ($ and count)
- **Auto-tagged call reasons** (replaces the manual single code; multiple tags per call)
  + **sentiment** distribution and trend; every slice drills into the calls behind it:
  member, time, duration, reasons, sentiment, summary, transcript
- Abandoned calls / hold time tiles labelled "from WxCC Analyzer" (narrate the native
  reporting; don't rebuild it)

Deterministic seeded baseline + live overlay (home-services `aiops.ts` pattern), so
calls made in the room move the numbers.

## 3. Architecture

```
 Browser pages (/horry/)                       WxCC Agent Desktop (KC_Horry.json)
 site.html (chat)  supervisor.html  outages.html  member card · AI summary · billing
 dashboard.html  pay-sim.html  roster.html       assistant · supervisor storm toggle
        └──────────────┬───────────────────────────────────┘
                       ▼   nginx kcdev2 /horry/  →  Fastify :8165 (packages/service)
        ├─ ModeStore        storm / normal / overflow (+ audit)
        ├─ CisAdapter       mock NISC/Meridian (one file to swap)
        ├─ OutageStore      events, ETR, restore, nested-outage tickets
        ├─ NotifyEngine     SMS + AI outbound callbacks, paced
        ├─ PaymentService   sessions, Twilio Pay webhooks, results → CIS
        ├─ CallStore        GUID rows, journey, transcript, tags, sentiment
        ├─ ChatStore        web chat sessions
        ├─ Assistant        Claude tool-use loop for the billing assistant
        ├─ AiOps / Metrics  dashboard baseline + live overlay
        └─ AgentHub (WS)    widgets
        env-gated adapters (unset = simulator): ElevenLabs, Twilio SMS, Twilio Pay +
        Stripe, Anthropic, WxCC stats
```

Stack and conventions per `../CLAUDE.md`. State: in-memory + JSON snapshots
(home-services pattern, no native deps).

## 4. Demo scenes (draft run-of-show, ~25 min)

1. **Storm hits** (3 min) — dashboard calm → supervisor flips Storm Mode → banner
   everywhere → simulator floods the outage line.
2. **Known outage, text me** (3 min, live call) — AI identifies, confirms the known
   outage + ETR, signs up for SMS. Outage page: Mark restored → presenter's phone gets
   the text; reply NO → nested outage ticket appears.
3. **Wires down** (2 min, live call) — safety script, emergency escalation, agent
   screen pop with "Wires down" pill and the AI summary.
4. **Pay my bill with the AI** (3 min, live call) — balance, keypad payment, confirmation;
   CIS card updates.
5. **Live agent → secure pay → back** (3 min) — agent in billing, clicks Take secure
   payment, caller pays on the keypad, lands back with the same agent; widget shows the
   result. "Your agent never heard the card. Your recording never has it."
6. **Billing assistant** (2 min) — agent asks for an extension in plain words.
7. **Web chat** (2 min) — report an outage from the website.
8. **Dashboard** (4 min) — storm-day stats, auto-tags, sentiment, drill into a call.
9. **Storm roster** (1 min) — 50 temporary agents into the outage queue in one click.
10. **Email ticketing** (1 min, optional) — AI-tagged inbox.

## 5. Proposed scope cut for Nov 4

| Priority | Piece |
| --- | --- |
| **Must** | Storm Mode switch + flow branch; AI outage agent (identify, known/unknown, safety, subscribe); mock CIS; restoration notifier (SMS real, voice callback real if time); member card widget; dashboard with auto-tags + sentiment + drill-in; web chat |
| **Must (sim fallback)** | AI secure payment — built against Twilio Pay, simulator page if Twilio PCI account/DTMF path isn't proven by Fri 10/30 |
| **Should** | Live agent → secure pay → back; billing assistant; nested-outage catch |
| **Could** | Storm roster page; email inbox beat; text-to-report; Spanish; overflow mode |

## 6. Open decisions — see TODO.md "Decisions"
