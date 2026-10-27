# Research — PCI card payments by phone (2026-10-27)

## ElevenLabs

- Claims a **PCI DSS Level 1 Service Provider** certification renewal (blog, 2026-10-16);
  scope/QSA not stated — request the AOC via the trust center (compliance.elevenlabs.io).
  https://elevenlabs.io/blog/certification-renewals
- Marketing: "PCI-compliant payments with DTMF capture and redaction" / "PCI-aware
  controls". https://elevenlabs.io/ai-customer-support
- **DTMF input reaches the LLM** — "The agent receives the collected digits as a user
  turn"; `redact_input` hides digits in stored transcript/logs/analysis only and "does
  not hide digits from the agent during the live call".
  https://elevenlabs.io/docs/eleven-agents/customization/multimodal-input
- Conversation history redaction = post-call only.
  https://elevenlabs.io/docs/eleven-agents/customization/privacy/conversation-history-redaction
- No Stripe / Twilio Pay / PCI Pal partnership or "secure input" mode found.

**Conclusion:** the ElevenLabs agent must not collect card data.

## Twilio Pay

- `<Pay>` collects card by DTMF → Pay Connector (Stripe, Braintree, CardConnect, Chase,
  Adyen, Base Commerce, Generic) → charge or tokenize → `action` URL gets the result;
  call continues with the returned TwiML. https://www.twilio.com/docs/voice/twiml/pay
- **PCI Mode** must be enabled, is **irreversible** and account-wide → use a dedicated
  account/project.
- Agent Assisted Pay: `POST /Calls/{CallSid}/Payments`, masked status callbacks, "agents
  are not able to hear any DTMF tones". https://www.twilio.com/docs/voice/api/payment-resource
- Works on any Programmable Voice call with a CallSid (SIP Domain / BYOC with TwiML);
  not plain Elastic SIP Trunking (inference — no doc says it directly).
- **Test RFC 2833 DTMF end to end** WxCC → CUBE → freeSWITCH → Twilio first.

## Alternatives

- DTMF-masking vendors: PCI Pal, Sycurio, Eckoh — no WxCC listing found.
- freeSWITCH `play_and_get_digits` + our own Stripe call = **our servers in PCI scope**;
  lab only, never sell.
- WxCC: platform PCI for digital/log masking; **no native secure voice capture**. App Hub:
  SecureCall (BroadSource), C3 Payments.
  https://apphub.webex.com/applications/securecall-broadsource-group-pty-ltd-40209
  https://apphub.webex.com/applications/c3-payments-customer-dynamics-95460

## Sales wording

See HLD §2.5 — use verbatim; never say "the AI is PCI compliant" or "you'll become SAQ A".
