# Discovery summary (Nick Mazzarese, Cisco — posted 2026-10-27)

Transcribed from Kristen's screenshot; item 1 was cut off ("…the next steps, such as a
demo or pricing exercise.").

2. **Current setup:** 109 employees, 163 phones (128 actual users), 33–35 active contact
   center agents.
3. **Storm operations:** during emergencies they need flexibility to quickly onboard up to
   50 additional employees from various departments to handle calls as ACD agents in a
   dedicated "outage queue."
4. **Mitel challenges:** current Mitel system, in use for 26 years, considered antiquated —
   clunky contact center integration, difficult ACD user setup, non-user-friendly reporting.
5. **Reporting & AI:** reports on call handling, abandoned calls, hold times. Very
   interested in AI automatic call tagging based on conversation content, replacing their
   current manual, single-code system.
6. **Digital:** email ticketing system to replace their manual distribution group; web
   chat; potentially social media.
7. **Remote work & hardware:** all agents in-office; open to a mix of desk phones and
   softphones.
8. **Cloud migration:** not opposed to cloud; project driven by limits of on-prem Mitel.
9. **System integration:** CIS/billing and accounting system, NISC (formerly Meridian),
   specifically for screen pop, which Mitel could not achieve.
10. **Call recording & PCI:** integrated call recording (moving away from a third-party
    solution) and a PCI-compliant method for agents to take card payments over the phone
    without affecting their PCI SAQ D status.

## Kristen's direction (2026-10-27)

- Item 3: supervisor flips on an AI inbound agent during emergencies (bridge transfer →
  freeSWITCH → ElevenLabs): gather info, look up account, say if the outage is already
  reported, offer callback or text on restoration; something must manage those callbacks.
- Dashboard: AI inbound stats on storm days, call review + summaries, sentiment.
- Item 6: inbound web chat from their website (Infinity Home Services pattern).
- Item 9: key billing info on the widget; AI handles payments when due; agentic billing
  tool in the agent desktop widget.
- PCI: AI takes payments if possible; a live agent can transfer to the AI for card
  details and get the caller back.
