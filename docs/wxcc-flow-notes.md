# WxCC flow build sheet — KC_Horry_Electric (Designer, by Kristen)

Status 2026-10-27: middleware + ElevenLabs agent built; **flow not built**. Flow edits are
Designer-only (standing rule). `{{mw}}` = `https://kcdev2.workflowconcepts.com/horry`.
Every HTTP node: **timeout 10 s** (the 2 s default fails silently). Responses are flat strings.

## Objects to create (Control Hub)

| Object | Name | Notes |
| --- | --- | --- |
| Global Variable | `Global_StormMode` (String, default `false`, not agent-editable, reportable) | **Send calls to Savannah.** `true` when Storm Mode OR "AI agent for all calls" is on (2026-10-29; the name stays). Savannah's greeting (storm vs everyday) comes from our service, so the flow is unchanged. The middleware PUTs its `defaultValue` (`api/mode` → `cad-variable/{id}`). Put its id in `WXCC_STORM_VARIABLE_ID` |
| Entry point + DID | `EP_KC_Horry` | demo line **(972) 430-9658** (2026-10-28) |
| Team | `KC_HorryElectric` ✅ created 2026-10-28 | the normal (home) team on `Q_Horry_Outage`; desktop layout `KC_Horry.json` |
| Queues | `Q_Horry_Outage` ✅ created 2026-10-28 (no skill required), `Q_Horry_Billing` | team-based; extra department teams are added/removed by the supervisor widget. `Q_Horry_Billing` is staffed by `KC_Horry_Billing` (the demo's billing agent) |
| Demo logins | supervisor on `KC_HorryElectric` (AI Operations + Call Review pages, takes no calls); agent on `KC_Horry_Billing` | layout `KC_Horry` assigned to both teams. Test scripts A/B/C: demo overview page §9 |
| Flow | `KC_Horry_Electric` | below |
| Desktop layout | `KC_Horry.json` | later — widgets first (lockstep rule) |

Outage queue staffing: the supervisor widget edits **`Q_Horry_Outage`'s distribution group**
(adds/removes teams; normal staffing is snapshotted and restored by "Return to normal"). Put the
queue id in `WXCC_OUTAGE_QUEUE_ID`. Set the queue to **team-based** routing and give it one
distribution group with the normal team(s). Create the extra department teams the demo picks from
(e.g. `KC_Horry_Billing`, `KC_Horry_Engineering`, `KC_Horry_Dispatch`) — they need no other config,
but **the name must start with `KC_Horry`**: the org is shared, so the picker shows only those
(`WXCC_STAFFING_TEAM_PREFIX`) plus teams already on the queue.

Service App for the variable write and the queue edit: scope `cjp:config_write` (+ `cjp:config_read`); org
admin authorizes once → `WEBEX_CLIENT_ID/SECRET/REFRESH_TOKEN` in the server `.env`.
**Use a Service App no other box uses** (refresh tokens rotate — kc-wiki
webex-service-app-auth).

## Flow, node by node

1. **NewPhoneContact** → set `GUID` = interaction id.
2. **Add the global variable** `Global_StormMode` to the flow (Flow → Global Variables).
3. **HTTP Request** `GET {{mw}}/api/call-context?ani={{NewPhoneContact.ANI}}&dnis={{NewPhoneContact.DNIS}}&id={{GUID}}`
   → outputs `found`, `member_name`, `account_number`, `storm_mode`, `outage_known`,
   `life_support` (seeds the call row the AI reads seconds later).
4. **Case** on `Global_StormMode`:
   - `true` → step 5 (AI first).
   - otherwise → normal routing: (optional menu) → Set CAD (`memberName`, `accountNumber`)
     → **Queue** `Q_Horry_Billing` (screen pop reads `api/member?ani=`). *Option for the
     demo: send blue-sky calls to the AI too (billing/payments scenes) — a second DNIS or a
     menu choice "pay my bill" → step 5.*
5. **BridgeTransfer** → **DN 1122** (freeSWITCH front door) with custom headers
   `X-Call-GUID={{GUID}}`, `X-Solution-Name=horryelectric`.
6. **On return**, one **HTTP Request** (no Parse node, no BYE headers — Crete's shipped
   pattern): `GET {{mw}}/api/intake/{{GUID}}`, timeout 10 s. Output mapping (all strings):
   `$.escalate` → `aiEscalate`, `$.department` → `aiDepartment`, `$.urgency` → `aiUrgency`,
   `$.reason` → `aiReason`, `$.summary` → `aiSummary`, `$.member_name` → `memberName`,
   `$.account_number` → `accountNumber`, `$.service_address` → `serviceAddress`,
   `$.outage_id` → `outageId`. Unknown GUID returns `escalate=false` with empty fields.
7. **Case** `aiEscalate`:
   - not `true` → (optional "Thanks for calling Horry Electric") → **Disconnect**.
   - `true` → Set CAD (`aiDepartment`, `aiUrgency`, `aiReason`, `aiSummary`, `memberName`,
     `accountNumber`, `serviceAddress`, `outageId`, `refCode=GUID`) →
     **Case** `X-IVR-Department`: `outage` → `Q_Horry_Outage`, `billing` → `Q_Horry_Billing`,
     else `Q_Horry_Billing`. **Priority**: `X-IVR-Urgency == emergency` → queue priority 1
     (wires down jump the line), `priority` → 3, else default.
8. **Fallbacks**: bridge failure (FS down) → straight to the step-7 queue with CAD
   `aiReason=ai_unavailable` — callers are never stranded.

## Payment hand-off: agent → Savannah → same agent (use case 1, 2026-11-02)

Kristen's branch in `KC_Horry_Electric`: **Case** on `NewPhoneContact.DNIS` = `9729038486`
(EP_KC_Horry_Payment). The agent gets there with Desktop **Transfer → Entry point →
EP_KC_Horry_Payment** after clicking **Hand payment to Savannah** on the Member tab / Calls page.

1. **HTTP Request** `GET {{mw}}/api/handoff/by-ani/{{NewPhoneContact.ANI}}`, timeout 10 s.
   Output mapping (strings): `$.found` → `hoFound`, `$.agent_email` → `hoAgentEmail`,
   `$.agent_name` → `hoAgentName`, `$.ref` → `hoRef`, `$.member_name` → `memberName`,
   `$.account_number` → `accountNumber`, `$.amount` → `hoAmount`.
2. **Case** `hoFound`: not `true` → play "Sorry, there is no payment waiting on this line" →
   **Queue** `Q_Horry_Billing`. (Nobody is stranded if the agent forgot the button.)
3. **BridgeTransfer** → DN **1122**, same headers as the main path (`X-Call-GUID={{GUID}}`,
   `X-Solution-Name=horryelectric`). Same solution name on purpose: the service recognises the
   caller's open hand-off and gives Savannah the payment-only greeting and script.
4. **On return** (Savannah calls wrap_up → end_call; the controller drops her leg): Set CAD
   `memberName`, `accountNumber`, `hoRef` → **Queue To Agent**: agent variable `hoAgentEmail`,
   lookup by **email**, fallback / timeout → **Queue** `Q_Horry_Billing`. The agent's Calls page
   already shows the payment and confirmation when the call rings back.
5. Bridge failure → **Queue To Agent** straight away (the agent explains and uses the text link).

Service side: `POST api/agent-desk/handoff` (the button) → `handoffs.json`; Savannah's tools post
the steps; `GET api/agent-desk/handoff?agent=` feeds the Calls page every 3 s. [CONFIRM]
Queue To Agent by email in this tenant; the email must match `$STORE.agent.agentEmailId`.
