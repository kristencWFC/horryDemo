# WxCC flow build sheet — KC_Horry_Electric (Designer, by Kristen)

Status 2026-10-27: middleware + ElevenLabs agent built; **flow not built**. Flow edits are
Designer-only (standing rule). `{{mw}}` = `https://kcdev2.workflowconcepts.com/horry`.
Every HTTP node: **timeout 10 s** (the 2 s default fails silently). Responses are flat strings.

## Objects to create (Control Hub)

| Object | Name | Notes |
| --- | --- | --- |
| Global Variable | `Global_StormMode` (String, default `false`, not agent-editable, reportable) | **Storm Mode.** The middleware PUTs its `defaultValue` (`api/mode` → `cad-variable/{id}`). Put its id in `WXCC_STORM_VARIABLE_ID` |
| Entry point + DID | `EP_KC_Horry` | new demo DID |
| Queues | `Q_Horry_Outage`, `Q_Horry_Billing` | team for the demo; storm agents get the outage skill |
| Flow | `KC_Horry_Electric` | below |
| Desktop layout | `KC_Horry.json` | later — widgets first (lockstep rule) |

Service App for the variable write: scope `cjp:config_write` (+ `cjp:config_read`); org
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
6. **On return**, read the BYE headers: `X-IVR-Escalate`, `X-IVR-Department`,
   `X-IVR-Urgency`, `X-IVR-Reason`, `X-IVR-Summary`, `X-IVR-Caller-Name`,
   `X-IVR-Account-Number`, `X-IVR-Service-Address`, `X-IVR-Outage-Id`.
7. **Case** `X-IVR-Escalate`:
   - not `true` → (optional "Thanks for calling Horry Electric") → **Disconnect**.
   - `true` → Set CAD (`aiDepartment`, `aiUrgency`, `aiReason`, `aiSummary`, `memberName`,
     `accountNumber`, `serviceAddress`, `outageId`, `refCode=GUID`) →
     **Case** `X-IVR-Department`: `outage` → `Q_Horry_Outage`, `billing` → `Q_Horry_Billing`,
     else `Q_Horry_Billing`. **Priority**: `X-IVR-Urgency == emergency` → queue priority 1
     (wires down jump the line), `priority` → 3, else default.
8. **Fallbacks**: bridge failure (FS down) → straight to the step-7 queue with CAD
   `aiReason=ai_unavailable` — callers are never stranded.

## Live agent → secure payment → back (phase 4, not built)

Agent widget "Take secure payment" → middleware mints a session tied to GUID + agent id →
agent blind-transfers to the secure-pay EP → same flow, Case on `X-Pay-Session` → bridge
to the AI with `X-Solution-Name=horryelectric` + session → AI takes card on file / link /
keypad → BYE with `X-IVR-Payment-Ref` + `X-IVR-Return-Agent` → **Queue to Agent** (last
agent) with 30 s fallback to `Q_Horry_Billing`.
