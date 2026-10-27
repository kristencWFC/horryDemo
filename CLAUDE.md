# horry-electric — Horry Electric Cooperative demo (electric co-op, storm ops + billing AI)

Demo for **Horry Electric Cooperative** (Conway, SC; ~105k members; horryelectric.com),
replacing a 26-year-old Mitel. Customer demo **Wed 2026-11-04, 10:00 AM ET** — Dale
Johnson (IT Manager) + 8–10 across business functions; opportunity via Nick Mazzarese
(Cisco); WFC: Dave Chiarello, Jerry Lyon, Nadine. WFC record: Autotask company 884,
Dropbox `/Accounts/Horry Electric Cooperative`, folder `02-sales/wxcc-contact-center/`.

Read `docs/HLD.md` and `TODO.md` (STATE + Decisions) first.

## Ground rules

- Workspace conventions (`../CLAUDE.md`): Claude commits, **never pushes**; never touches
  servers; secrets in gitignored `.env`; keep TODO.md + HLD current.
- Sibling repos are **reference-only** (home-services, cable-bahamas-demo,
  stillwater-agent, outboundDialer, agentLiveAssist, creteDemo, freeSWITCH).
- Flow edits are **Designer-only, by Kristen**. Layout + widgets move in lockstep
  (widgets deploy first); approval-first on layout edits.
- Client name is demo-visible on purpose; member personas and numbers are fictional.
- **PCI wording is load-bearing** — HLD §2.5. The ElevenLabs agent never collects card
  digits (DTMF reaches the LLM); Twilio Pay does.

## Reuse map

| Piece | Source |
| --- | --- |
| Inbound DID → call-context → freeSWITCH bridge → ElevenLabs → BYE headers | `../home-services` (`docs/wxcc-flow-notes.md`, `freeswitch.ts`, `voice.ts`) |
| Payments conversation, assist rail, journey strip, AI summary widget | `../cable-bahamas-demo` |
| Web chat (site bubble → agent widget) | `../home-services/packages/service/src/chat.ts`, `../stillwater-agent` |
| SMS send/inbound + paced blasts | `../home-services/src/sms.ts` |
| AI outbound callbacks | `../outboundDialer` (ElevenLabs outbound launcher) |
| Dashboard baseline + live overlay + drill-in | `../home-services/src/aiops.ts`, kc-wiki `demo-dashboard-patterns` |
| Pick store (if used) | `../home-services/src/pick.ts` (crete port — keep comments) |
| Screen-pop account card pattern | `../agentLiveAssist` |
