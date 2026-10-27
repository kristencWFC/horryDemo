// Mock of Meridian's NextGen CIS Integration Web API + Payment Gateway Web API
// (RPS and IVR Integration Guide v2.6 — docs/research/nextgen-cis-api.md). Same paths,
// same JSON field names, same quirks (UpnAccountsInfo by phone needs the area code;
// MemberSep comes back 11 chars zero-padded on updates; tokens expire in ~2 minutes),
// so nextgen.ts talks to this exactly as it would talk to the co-op's real server.
// Only the fields the demo uses are populated; the rest are present with neutral values.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { MemberStore, Member } from './members.js';

const CLIENT_ID = '988'; // Meridian-assigned utility client id (sample value from the guide)
const tokens = new Set<string>();

function uniqueId(appId: string): string {
  return `${CLIENT_ID}~${appId}^0${Math.floor(Math.random() * 9) + 1}^${Date.now()}${Math.floor(Math.random() * 10000)}`;
}

function financial(m: Member) {
  return {
    MemberSep: Number(m.MemberSep),
    Name: m.Name,
    ErrorMessage: null,
    ServiceAddress: m.ServAddr,
    Location: Number(m.Location),
    CurrentBalance: m.CurrentBalance,
    PpmBalance: 0.0,
    AmountDue: m.AmountDue,
    DueDate: m.DueDate,
    PastDueAmount: m.PastDueAmount,
    CutOffDate: m.CutOffDate,
    PendingDisconnectType: m.OnCutOffList ? 'NONPAY' : null,
    LastPayment: m.LastPayment,
    PaymentDate: m.PaymentDate,
    NbrPayments: 1,
    MeterRead: 44280,
    ReadDate: m.BillDate,
    BillDate: m.BillDate,
    LevelizedBillAmount: m.LevelizedBillAmount,
    NbrCutOff: 0,
    AccountStatus: m.AcctStatus,
    OpenArrangements: (m.Extensions ?? []).length,
    Arrangements: (m.Extensions ?? []).length,
    BrokenArrangements: 0,
    CoopParam23: 2,
    AllowArrangementFlag: m.AllowArrangementFlag && (m.Extensions ?? []).length === 0,
    Checkcode: 0,
    CreditCardCode: 0,
    NbrBadChecks: 0,
    CardProfileExists: m.CardProfileExists,
    Last4CcDigits: m.Last4CcDigits,
    ChkProfileExists: m.BankDraft,
    DepositAmount: 0.0,
    IsFirstBill: false,
    OnCutOffList: m.OnCutOffList,
    CollectionAmount: m.PastDueAmount,
    Last4EcAccountDigits: m.BankDraft ? '8097' : null,
    BudgetOrLevelizedBillAmount: m.LevelizedBillAmount || null,
    InstallmentDueDate: null,
    InstallmentAmount: null,
    PrepaidInfoItems: [],
    ServiceType: 'Electric',
    DebtMgtBalance: null,
    ChecksAllowed: true,
    CreditcardsAllowed: true,
    Last4ssn: null,
    PaymentToken: `mock.${randomBytes(12).toString('base64url')}`,
  };
}

export function registerNextGenMock(f: FastifyInstance, members: MemberStore): void {
  const P = '/mock/NextGenCISIntegration';
  const auth = (h: string | undefined) => Boolean(h && tokens.has(h.replace(/^Bearer\s+/i, '')));

  f.post(`${P}/token`, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    if (b.grant_type !== 'password' || !b.username) return reply.code(400).send({ error: 'invalid_grant' });
    const t = randomBytes(48).toString('base64url');
    tokens.add(t);
    setTimeout(() => tokens.delete(t), 120_000).unref();
    return { access_token: t, token_type: 'bearer', expires_in: 119 };
  });

  f.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith(`${P}/api/`)) return;
    if (!auth(req.headers.authorization)) return reply.code(401).send({ Message: 'Authorization has been denied for this request.' });
  });

  // inquiryType 1 = phone (WITH area code), 2 = service address, 3 = email
  f.get(`${P}/api/account/UpnAccountsInfo/:type/:value`, async (req) => {
    const { type, value } = req.params as { type: string; value: string };
    const v = decodeURIComponent(value);
    const hits = type === '1' ? members.byPhone(v) : type === '2' ? members.byAddress(v) : members.byEmail(v);
    return {
      MemberAddressInfos: hits.map((m) => ({ MemberSep: Number(m.MemberSep), ServiceAddress: m.ServAddr, ZipCode: m.Zip })),
    };
  });

  f.get(`${P}/api/account/UpnAccountsFinancialInformation/:isMbrSep/accountnumbers`, async (req) => {
    const q = req.query as Record<string, string | string[]>;
    const raw = q.accountnumbers ?? q.accountNumbers ?? '';
    const ids = (Array.isArray(raw) ? raw : String(raw).split(',')).filter(Boolean);
    return ids.map((id) => {
      const m = members.bySep(id);
      return m ? financial(m) : { MemberSep: Number(id), ErrorMessage: 'Account not found.' };
    });
  });

  f.get(`${P}/api/account/GetUsageHistory/:acct/:from/:thru`, async (req) => {
    const { acct, from, thru } = req.params as Record<string, string>;
    const m = members.bySep(acct);
    if (!m) return [];
    const start = new Date(from);
    const end = new Date(thru);
    const lastYear = end.getTime() < Date.now() - 200 * 86400_000;
    const monthly = lastYear ? m.KwhSameMonthLastYear : m.KwhLast30;
    const out = [];
    for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400_000)) {
      const kwh = Math.round((monthly / 30) * (0.85 + 0.3 * Math.abs(Math.sin(d.getTime() / 86400_000))));
      out.push({
        Meter: m.Meter,
        TotalEnergy: String(kwh),
        DailyTimeStamp: d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }),
        UsedFromGrid: String(kwh),
        UsageType: 'Actual',
        DailyEnergyCost: (kwh * 0.118).toFixed(2),
      });
    }
    return out;
  });

  f.put(`${P}/api/account/UpdateUpnAccounts`, async (req) => {
    const b = (req.body ?? {}) as { UpnAccount?: { MemberSep?: string; Notes?: string; NoteType?: string; CellPhone?: string }[] };
    return {
      UpnAccounts: (b.UpnAccount ?? []).map((u) => {
        const m = u.MemberSep ? members.bySep(u.MemberSep) : undefined;
        if (!m) return { MemberSep: String(u.MemberSep ?? ''), UpdateStatus: 'Account not found.' };
        if (u.Notes) members.addNote(m.MemberSep, u.NoteType ?? 'AN', u.Notes);
        if (u.CellPhone) members.patch(m.MemberSep, { CellPhone: u.CellPhone });
        return { MemberSep: m.MemberSep, UpdateStatus: 'UPN account updated successfully.' };
      }),
    };
  });

  f.get(`${P}/api/payment/ValidatePayment/:acct/:amount/:type/:app`, async (req, reply) => {
    const { acct, type, app } = req.params as Record<string, string>;
    const m = members.bySep(acct);
    if (!m) return reply.code(400).send({ ErrorString: 'Account not found.' });
    return {
      ErrorString: null,
      UniqueId: uniqueId(app),
      ClientId: CLIENT_ID,
      CreditCardMerchantId: '0008024791454123',
      BankNumber: '000215',
      ECheckMerchantId: '9900002583',
      ECheckTxCodePrefix: 'SED',
      BankRoutingNumber: type.toUpperCase() === 'EC' && m.BankDraft ? '061101155' : null,
      BankAccountNumber: type.toUpperCase() === 'EC' && m.BankDraft ? '1234568097' : null,
      BankAccountType: type.toUpperCase() === 'EC' && m.BankDraft ? 'C' : null,
      FirstName: null,
      LastName: null,
      MiddleName: null,
      Suffix: null,
      SSLEnabled: 'false',
      HPUserName: null,
      HPUserID: '3349',
      TaxAmount: '0.0',
    };
  });

  f.post(`${P}/api/payment/RequestPaymentExtension`, async (req, reply) => {
    const b = (req.body ?? {}) as { MemberSep?: number | string; FinalDueDate?: string };
    const m = b.MemberSep !== undefined ? members.bySep(String(b.MemberSep)) : undefined;
    if (!m || !b.FinalDueDate) return reply.code(400).send({ Message: 'MemberSep and FinalDueDate are required.' });
    if (!m.AllowArrangementFlag || (m.Extensions ?? []).length > 0) return { ConfirmationNbr: null, Message: 'Extension denied by co-op rules.' };
    const confirmation = String(Math.floor(100000 + Math.random() * 900000));
    members.patch(m.MemberSep, {
      Extensions: [...(m.Extensions ?? []), { confirmation, payBy: b.FinalDueDate, at: new Date().toISOString() }],
      OnCutOffList: false,
    });
    return { ConfirmationNbr: confirmation };
  });

  // ---- Payment Gateway Web API (sedc) ------------------------------------------------
  // Only the Token form is implemented: card numbers never enter this service
  // (the real gateway also accepts CardAccountNumber — that path is what puts an IVR in
  // PCI scope, which is exactly what this demo is designed to avoid).
  const PG = '/mock/paymentgatewayapiv2/sedc/api/payments';

  // Card on file (CardProfileExists) — no card data in the request at all.
  f.post(`${PG}/cc/:clientid/ivr/saleWithProfile`, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string | number | boolean>;
    const m = members.bySep(String(b.CustomerAccountNumber ?? ''));
    const amount = Number(b.BillAmount);
    if (!m) return reply.code(400).send([{ ErrorMessage: 'Invalid customer account number', ErrorCode: 1002 }]);
    if (!(amount > 0)) return reply.code(400).send([{ ErrorMessage: 'Expecting a positive value in BillAmount', ErrorCode: 1006 }]);
    if (!m.CardProfileExists) return reply.code(400).send([{ ErrorMessage: 'No credit card profile on file', ErrorCode: 1008 }]);
    members.applyPayment(m.MemberSep, amount, new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }));
    return {
      ClientReferenceNumber: '0',
      Amount: amount,
      BillAmount: amount,
      ConvenienceFee: 0.0,
      AuthorizationCode: String(Math.floor(100000 + Math.random() * 900000)),
      StatusMessage: 'Approved',
      StatusCode: 0,
      HostTransactionId: String(Date.now()),
      CustomerAccountNumber: m.MemberSep,
      LastFourDigitsOfCard: m.Last4CcDigits ?? '',
      CardTypeName: m.CardBrand ?? 'VISA',
      SedcTrackingId: String(b.UniqueId),
      ExpiryMonth: 12,
      ExpiryYear: 29,
      NameOnCard: '',
      Zip: m.Zip,
    };
  });
  f.post(`${PG}/cc/:clientid/ivr/sale`, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string | number | boolean>;
    if (b.CardAccountNumber) return reply.code(400).send([{ ErrorMessage: 'Demo mock refuses raw card numbers — send Token.', ErrorCode: 1007 }]);
    if (!b.Token) return reply.code(400).send([{ ErrorMessage: 'Provide a Token or CardAccountNumber', ErrorCode: 1008 }]);
    const amount = Number(b.BillAmount);
    if (!(amount > 0)) return reply.code(400).send([{ ErrorMessage: 'Expecting a positive value in BillAmount', ErrorCode: 1006 }]);
    const declined = String(b.Token).endsWith('0002'); // test-token convention: …0002 declines
    // The real gateway "posts back credit card payments" to the CIS (guide, process flow
    // diagram) — the mock does the same, so the balance drops on the member card.
    if (!declined) {
      members.applyPayment(String(b.CustomerAccountNumber), amount, new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }));
    }
    return {
      ClientReferenceNumber: '0',
      Amount: amount,
      BillAmount: amount,
      ConvenienceFee: 0.0,
      AuthorizationCode: declined ? '' : String(Math.floor(100000 + Math.random() * 900000)),
      StatusMessage: declined ? 'Declined' : 'Approved',
      StatusCode: declined ? 5 : 0,
      HostTransactionId: String(Date.now()),
      CustomerAccountNumber: String(b.CustomerAccountNumber),
      LastFourDigitsOfCard: String(b.Last4 ?? ''),
      CardTypeName: String(b.CardType ?? 'VISA'),
      SedcTrackingId: String(b.UniqueId),
      ExpiryMonth: 12,
      ExpiryYear: 29,
      NameOnCard: '',
      Zip: '',
    };
  });
}
