# horryDemo — Horry Electric Cooperative demo (electric co-op, storm ops + billing AI)

Demo for **Horry Electric Cooperative** (Conway, SC; ~105k members; horryelectric.com),
replacing a 26-year-old Mitel. Customer demo **Wed 2026-11-04, 10:00 AM ET** — Dale
Johnson (IT Manager) + 8–10 across business functions; opportunity via Nick Mazzarese
(Cisco); WFC: Dave Chiarello, Jerry Lyon, Nadine. WFC record: Autotask company 884,
Dropbox `/Accounts/Horry Electric Cooperative`, folder `02-sales/wxcc-contact-center/`.
GitHub: `kristencWFC/horryDemo` (Kristen created it 2026-10-27).

Read `docs/HLD.md` and `TODO.md` (STATE + Decisions) first.

## Ground rules

- Workspace conventions (`../CLAUDE.md`): Claude commits, **never pushes**; never touches
  servers; secrets in gitignored `.env`; keep TODO.md + HLD current.
- Sibling repos are **reference-only** (home-services, cable-bahamas-demo,
  stillwater-agent, outboundDialer, agentLiveAssist, creteDemo). Exception: the
  freeSWITCH repo's per-demo registry entry (`horryelectric`, commit 87bb1f6) — the
  established pattern every demo follows.
- Flow edits are **Designer-only, by Kristen** (`docs/wxcc-flow-notes.md` is the build
  sheet). Layout + widgets move in lockstep (widgets deploy first); approval-first on
  layout edits.
- Client name is demo-visible on purpose; member personas and numbers are fictional.
- **The NextGen docs are Meridian-proprietary** — `docs/research/nextgen-cis-api.md`
  stays in this private repo; never in the team wiki, recordings or client documents.
- **PCI wording is load-bearing** — HLD §2.5, `docs/research/pci-payments.md`. No card
  number ever passes through the agent, a tool, this service or a log: card on file
  (`saleWithProfile`), token from the pay page, or Twilio Pay. ElevenLabs DTMF reaches
  the LLM, so the agent never collects digits. The gateway mock REFUSES raw card numbers.

## Load-bearing facts

- **kcdev2 :8165**, nginx `/horry/`, systemd `horry-demo`, `/opt/horryDemo`. Pages use
  relative `api/...` paths (prefix-safe). Empty `.env` = fully simulated.
- **ElevenLabs agent `horryDemo`** `agent_5701m5zn0g2jegma4z7p0wpc255m` (branch
  `agtbrch_8801m5zn0g2zfgfrnebs6yc483qn`), persona Savannah. Configured ONLY via
  `scripts/provision-agent.mjs` from `agent/system-prompt.txt` + `agent/tools.json`
  (`--patch` after edits). It was cloned from Crete: the six detached Crete tools are
  Crete's live tools — never delete them. Details: `docs/elevenlabs-agent-setup.md`.
- **SIP number not assigned** — 1150 refused as "already exists" (TODO decision 4).
- `ELEVENLABS_API_KEY` in `.env` is the shared workspace key from home-services (Kristen
  asked for it 2026-10-27). `TOOL_SHARED_SECRET` is Horry's own and is baked into the
  agent's tool headers — changing it means re-running `--patch`.
- **NextGen mock** at `/mock/NextGenCISIntegration` mirrors the real API (paths, field
  names, ~2-min tokens, phone lookups need the area code). The client only talks HTTP to
  `NEXTGEN_BASE_URL` (unset = the mock) — keep it that way so going live is config.
- **Storm Mode** = WxCC global variable written via Config API (`mode.ts`, Service App
  token with persisted rotation in `webex.ts`); local flag when WxCC env is unset.
- Call rows are keyed by the WxCC interaction GUID (`X-Call-GUID` → `sip_call_guid`);
  tools fall back to the caller's recent row by ANI.
- Demo-phone override: Storm Console "Demo caller" maps the presenter's ANI to any
  member (default Kristen's cell → Linda Hardee, in the seeded Socastee outage).
- Runtime state `packages/service/data/*.json` (gitignored); console "Reset demo data".

## Reuse map

| Piece | Source |
| --- | --- |
| Inbound DID → call-context → freeSWITCH bridge → ElevenLabs → BYE headers | `../home-services` (`docs/wxcc-flow-notes.md`, `freeswitch.ts`) |
| Agent provisioning script | `../cable-bahamas-demo/scripts/provision-agent.mjs` (adapted) |
| Payments conversation, assist rail, journey strip, AI summary widget | `../cable-bahamas-demo` |
| Web chat (site bubble → agent widget) | `../home-services/packages/service/src/chat.ts`, `../stillwater-agent` |
| AI outbound callbacks | `../outboundDialer` (ElevenLabs outbound launcher) |
| Dashboard baseline + live overlay + drill-in | `../home-services/src/aiops.ts`, kc-wiki `demo-dashboard-patterns` |
| Widget build + WS client | `../home-services/packages/widgets`, kc-wiki `widget-design-system` |
