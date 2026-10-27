# NextGen CIS Integration & Payment Gateway Web API — what we use

**CONFIDENTIAL — Meridian Cooperative proprietary.** Source: "NextGen CIS Integration &
Payment Gateway Web API — RPS and IVR Integration Guide" v2.6 (2022-08-04) and "NextGen
and Payment Gateway Requests and Responses Examples" (©2021 Meridian), supplied by
Kristen 2026-10-27 from earlier WFC work. Keep the PDFs and this note in this private
repo only (`docs/client/` if the PDFs are added) — never in a public recording, the WFC
team wiki or a client-facing doc without Meridian's permission.

## Is this what Horry uses? — Yes (high confidence)

- Horry's member portal "MyEnergy Online" is Meridian Cooperative's product (footer:
  "Copyright 2026 by Meridian Cooperative"); their CIS is Meridian's **UPN
  (utilityPOWERnet)**. "NISC (formerly Meridian)" = Meridian merged into NISC on
  2026-08-01 (`nisc-meridian.md`).
- NextGen CIS Integration is Meridian's REST interface **for third-party IVR and kiosk
  (RPS) vendors** to read/update UPN and take payments — exactly our role.
- To confirm on the discovery call: the NextGen web API is enabled on Horry's UPN install
  (it is per-utility: base URL, UPN API user, Meridian client id + payment-gateway API key),
  and whether NISC keeps it supported post-merger (NISC says it will converge on iVUE).

## Auth

- `POST https://{server}/NextGenCISIntegration/token` — form-encoded `grant_type=password`,
  `username`, `password` (UPN API user) → bearer token, **expires_in ≈ 120 s**.
- Payment Gateway: `Authorization: Bearer <PaymentToken>` — a JWT returned **per account**
  in `UpnAccountsFinancialInformation.PaymentToken` (claims: coop + member; 401/403 on
  mismatch). Alternatively the vendor signs its own HS256 JWT with a Meridian-issued key.

## Endpoints the demo mirrors (`packages/service/src/nextgen-mock.ts`)

| Need | Call | Notes |
| --- | --- | --- |
| Caller ID → account | `GET api/account/UpnAccountsInfo/1/{phone}` | 1 = phone (**must include area code**), 2 = service address, 3 = email → `MemberAddressInfos[{MemberSep, ServiceAddress, ZipCode}]` |
| Screen pop / billing | `GET api/account/UpnAccountsFinancialInformation/true/accountnumbers?accountnumbers={sep}` | balance, AmountDue, DueDate, PastDueAmount, CutOffDate, OnCutOffList, LastPayment/Date, AllowArrangementFlag, CardProfileExists + Last4CcDigits, ChkProfileExists, Levelized, PaymentToken |
| "Why is my bill high" | `GET api/account/GetUsageHistory/{sep}/{from}/{thru}` | daily kWh + DailyEnergyCost |
| Account notes (AI summary, outage report) | `PUT api/account/UpdateUpnAccounts` | Notes + NoteType on MemberSep / OutageID / ServiceOrder …; also phone updates (phones WITHOUT area code here — inconsistent with lookup) |
| Extension | `POST api/payment/RequestPaymentExtension` | `{MemberSep, FinalDueDate, InstallmentList[]}` → `ConfirmationNbr` |
| Arrangements | `GET api/arrangement/ArrangementDetails/{sep}`, `POST …/CreateArrangement/{sep}` | rules engine result + installments (not mocked yet) |
| Pre-payment checks | `GET api/payment/ValidatePayment/{sep}/{amount}/{CC|EC}/{appId}` | appId 3 = IVR; returns UniqueId, merchant ids, SSLEnabled |
| Pay — card on file | `POST paymentgatewayapiv2/sedc/api/payments/cc/{clientid}/ivr/saleWithProfile` | **no card data** — the demo's PCI-free AI payment |
| Pay — new card | `POST …/cc/{clientid}/ivr/sale` | takes `CardAccountNumber`+`Cvv` **or `Token`** ("Provide either CardAccountNumber or Token, not both", error 1007) |
| Pay — bank draft | `POST …/ec/{clientid}/ivr/sale` | e-check with profile |
| Void | `DELETE …/payments/{sedcUniqueId}` | |
| Do-not-call | `PUT api/alert/DoNotCallList` | outbound restoration calls should respect it |

Gateway processor behind Meridian: **Elavon via Fusebox** (error-code table: "Could not
connect to Fusebox", "original sale not found at Fusebox (Elavon)").

## What it means for PCI

- The IVR `sale` with `CardAccountNumber` means **whoever collects the digits is in PCI
  scope** — that is how today's IVR/agents put Horry in SAQ D territory.
- Our design never sends a card number: **card on file → `saleWithProfile`**; new card →
  a PCI-certified capture (hosted page or Twilio Pay) that yields a **token** → `sale` with
  `Token`. **Open question for Meridian:** which token types their gateway accepts (Elavon
  / Fusebox tokens) — that decides whether the production capture is Meridian's own hosted
  page, Twilio Pay's Generic Pay Connector, or a PCI vault that forwards to the gateway.
