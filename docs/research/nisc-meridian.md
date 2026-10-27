# Research — NISC / Meridian CIS (2026-10-27)

**Bottom line:** Horry runs **Meridian Cooperative's** CIS. Their member portal "MyEnergy
Online" (https://myenergy.horryelectric.com/onlineportal/) footer reads "Copyright 2026 by
Meridian Cooperative". Meridian merged into NISC effective **2026-08-01** → "NISC
(formerly Meridian)". It is not NISC's iVUE (yet — NISC says it will converge on one
iVUE-based CIS).

## NISC and Meridian

- **NISC**: technology co-op in Mandan, ND. CIS = NISC Enterprise System / iVUE; member
  portal = SmartHub. https://www.nisc.coop/service
- **Meridian Cooperative**: formerly **SEDC** (Atlanta, founded 1976). Billing suite
  **UPN (utilityPOWERnet)**; subsidiaries Futura Systems (operations/OMS) and Arista.
- Merger: boards approved 2026-05-12; members approved (announced 2026-07-15); effective
  2026-08-01 under the NISC name. Meridian/UPN support line 866-867-3788 continues.
  - https://www.nisc.coop/press-release/members-of-nisc-and-meridian-cooperative-approve-merger-uniting-two-technology-cooperatives/
  - https://www.nisc.coop/merger
  - https://www.telecompetitor.com/nisc-and-meridian-cooperative-announce-plans-to-merge/

## "NextGen CIS"

Not found as a public NISC, Meridian, Harris, Cogsdale or Hansen product (only NextGen
Healthcare, unrelated). No WFC repo under GitHub KC or GitHub WFC Repos references
NextGen / Meridian / NISC. Moderate confidence it is not a public product name — could be
an internal/roadmap name, or a different vendor a past WFC client used. **Ask Kristen
which client.**

## API surface

No public API docs; integrations are partner/NDA. Known partner integrations:
InvoiceCloud payments ↔ Meridian (https://invoicecloud.net/?p=24092), Alianza ↔ NISC,
**"NISC CallCapture IVR"** in the Mitel marketplace (possibly what they run today —
ask). Nothing Cisco/Webex-specific found.

## Horry Electric public footprint

- https://horryelectric.com — offices Conway + Socastee, founded 1940; ~105k members
  (third-party tracker, medium confidence)
- Main line / automated pay 843-369-2211; **outage line 843-369-2212** (their newsletter)
- Outage map "Web Outage Viewer" https://outages.horryelectric.com/ (Angular/Leaflet/Esri,
  vendor unidentified — Futura plausible)
- Portal features: Quick-Pay, Quick-Outage, Account/Use History, Analyze My Bill, Alerts,
  service requests. App "HEC Mobile". Kiosks, bank draft, Equal Pay / "Rest Easy".
- No web chat seen.

## Mock CIS field set

See HLD §2.4.
