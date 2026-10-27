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

## Kristen's questions (2026-10-27): "Do most use Stripe? Is that PCI SAQ D?"

- **Stripe is not what co-ops typically use.** Electric co-ops on Meridian process through
  their CIS vendor's gateway — the **Meridian Payment Gateway** (Elavon/Fusebox behind it;
  `nextgen-cis-api.md`) — or a utility-billing processor such as InvoiceCloud or Paymentus.
  In this demo Stripe is not used at all: payments post through the (mocked) Meridian
  gateway, the same calls Horry's real IVR vendor makes.
- **SAQ type is not decided by the processor.** It is decided by how card data touches
  *the merchant's own* systems and people. SAQ D is the catch-all for merchants whose
  environment stores, processes or transmits card data — e.g. agents hearing or keying
  card numbers, recordings that capture them, an IVR that collects digits and posts them
  to the gateway. That is almost certainly why Horry is SAQ D today.
- **"Without affecting their SAQ D status"** = the new contact center must not ADD to
  their card-data environment. Descoped capture (card on file, hosted link, or keypad
  entry into a PCI-certified service) keeps WxCC, recordings, the AI and agents out of the
  card-data flow — it doesn't add scope and may reduce it. Whether Horry can drop to a
  smaller SAQ depends on their other channels (kiosks, walk-in, portal) — their QSA decides.

## Demo payment methods, in order of preference (built 2026-10-27)

1. **Card on file** — `pay_with_card_on_file` → ValidatePayment → `saleWithProfile`. Zero
   card data anywhere. Works for any member with `CardProfileExists`.
2. **Secure text link** — `send_payment_link` → member pays on their own phone
   (`pay.html`, demo stand-in for Meridian's hosted Quick-Pay / a PCI-certified hosted
   page; the page tokenizes in the browser and posts only token + last four) → gateway
   `sale` with `Token`. Works today with no extra accounts.
3. **Keypad (Twilio Pay)** — `start_keypad_payment` returns "unavailable" until the
   dedicated PCI-Mode Twilio account + connector exist; the agent then offers the link.
