// NextGen CIS Integration Web API client. Talks HTTP to NEXTGEN_BASE_URL — the co-op's
// real server, or (unset) this service's own mock at /mock. Everything the AI, the
// widgets and the dashboard know about a member comes through here, so the move to
// Horry's live UPN system is configuration, not code.
import { env } from './env.js';

export interface AddressInfo {
  MemberSep: number;
  ServiceAddress: string;
  ZipCode: string;
}

export interface Financial {
  MemberSep: number;
  Name: string;
  ErrorMessage: string | null;
  ServiceAddress: string;
  Location: number;
  CurrentBalance: number;
  AmountDue: number;
  DueDate: string;
  PastDueAmount: number;
  CutOffDate: string | null;
  PendingDisconnectType: string | null;
  LastPayment: number;
  PaymentDate: string;
  BillDate: string;
  LevelizedBillAmount: number;
  AccountStatus: string;
  AllowArrangementFlag: boolean;
  CardProfileExists: boolean;
  Last4CcDigits: string | null;
  ChkProfileExists: boolean;
  OnCutOffList: boolean;
  BudgetOrLevelizedBillAmount: number | null;
  PaymentToken: string | null;
}

export interface UsageDay {
  TotalEnergy: string;
  DailyTimeStamp: string;
  DailyEnergyCost: string;
}

export interface ValidatePaymentResult {
  ErrorString: string | null;
  UniqueId: string;
  ClientId: string;
  CreditCardMerchantId: string;
  SSLEnabled: string;
  HPUserID: string;
}

export interface SaleResult {
  Amount: number;
  AuthorizationCode: string;
  StatusMessage: string;
  StatusCode: number;
  LastFourDigitsOfCard: string;
  CardTypeName: string;
  SedcTrackingId: string;
}

const pad11 = (sep: string | number) => String(sep).replace(/\D/g, '').padStart(11, '0');

export class NextGenClient {
  private token: { value: string; exp: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(private readonly base: string) {}

  static fromEnv(port: number): NextGenClient {
    return new NextGenClient((env.NEXTGEN_BASE_URL || `http://127.0.0.1:${port}/mock`).replace(/\/$/, ''));
  }

  get isMock(): boolean {
    return !env.NEXTGEN_BASE_URL;
  }

  // Tokens live ~2 minutes (expires_in 119) — refresh with a 15 s skew, single-flight.
  private async bearer(): Promise<string> {
    if (this.token && Date.now() < this.token.exp) return this.token.value;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const res = await fetch(`${this.base}/NextGenCISIntegration/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'password', username: env.NEXTGEN_USERNAME, password: env.NEXTGEN_PASSWORD }),
      });
      if (!res.ok) throw new Error(`NextGen token HTTP ${res.status}`);
      const j = (await res.json()) as { access_token: string; expires_in: number };
      this.token = { value: j.access_token, exp: Date.now() + (j.expires_in - 15) * 1000 };
      return j.access_token;
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}/NextGenCISIntegration/api/${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.bearer()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`NextGen ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** inquiryType 1 = phone (10 digits WITH area code), 2 = service address, 3 = email. */
  async accountsInfo(type: 1 | 2 | 3, value: string): Promise<AddressInfo[]> {
    const v = type === 1 ? value.replace(/\D/g, '').slice(-10) : value;
    const r = await this.call<{ MemberAddressInfos?: AddressInfo[] }>('GET', `account/UpnAccountsInfo/${type}/${encodeURIComponent(v)}`);
    return r.MemberAddressInfos ?? [];
  }

  async financial(memberSep: string | number): Promise<Financial | null> {
    const r = await this.call<Financial[]>(
      'GET',
      `account/UpnAccountsFinancialInformation/true/accountnumbers?accountnumbers=${pad11(memberSep)}&ServiceAddrRequired=true`
    );
    const f = r[0];
    return f && !f.ErrorMessage ? f : null;
  }

  async usage(memberSep: string | number, from: Date, thru: Date): Promise<UsageDay[]> {
    const d = (x: Date) =>
      `${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}-${x.getFullYear()}`;
    return this.call<UsageDay[]>('GET', `account/GetUsageHistory/${pad11(memberSep)}/${d(from)}/${d(thru)}`);
  }

  async addNote(memberSep: string | number, notes: string, noteType = 'AN'): Promise<void> {
    await this.call('PUT', 'account/UpdateUpnAccounts', { UpnAccount: [{ MemberSep: pad11(memberSep), Notes: notes, NoteType: noteType }] });
  }

  async requestExtension(memberSep: string | number, payBy: string, amount: number): Promise<string | null> {
    const r = await this.call<{ ConfirmationNbr: string | null }>('POST', 'payment/RequestPaymentExtension', {
      MemberSep: Number(pad11(memberSep)),
      FinalDueDate: payBy,
      InstallmentList: [{ Amount: amount, DueDate: payBy }],
    });
    return r.ConfirmationNbr ?? null;
  }

  /** applicationId 3 = IVR. paymentType CC | EC. */
  async validatePayment(memberSep: string | number, amount: number, type: 'CC' | 'EC' = 'CC'): Promise<ValidatePaymentResult> {
    return this.call<ValidatePaymentResult>('GET', `payment/ValidatePayment/${pad11(memberSep)}/${amount.toFixed(2)}/${type}/3`);
  }

  private gatewayBase(): string {
    return this.isMock ? `${this.base}/paymentgatewayapiv2` : `${this.base.replace(/\/NextGenCISIntegration$/, '')}/paymentgatewayapiv2`;
  }

  /** Charge the card profile already on file (CardProfileExists) — no card data at all. */
  async saleWithProfile(args: { memberSep: string | number; amount: number; validate: ValidatePaymentResult; paymentToken: string | null }): Promise<SaleResult> {
    const res = await fetch(`${this.gatewayBase()}/sedc/api/payments/cc/${args.validate.ClientId}/ivr/saleWithProfile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(args.paymentToken ? { Authorization: `Bearer ${args.paymentToken}` } : {}) },
      body: JSON.stringify({
        ApplicationId: 3,
        UniqueId: args.validate.UniqueId,
        CustomerAccountNumber: pad11(args.memberSep),
        InvoiceNumber: '',
        BillAmount: args.amount.toFixed(2),
        ConvenienceFee: '0',
        PaymentDate: new Date().toISOString().replace('T', ' ').slice(0, 23),
        CallBackHeader: '69',
        CCMerchantID: args.validate.CreditCardMerchantId,
        UpdateProfile: false,
        ConvenienceFlag: false,
        SSLEnabled: args.validate.SSLEnabled === 'true',
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Payment gateway HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as SaleResult;
  }

  /**
   * Meridian Payment Gateway sale with a TOKEN (never a card number). paymentToken is the
   * JWT from UpnAccountsFinancialInformation; it goes in the Authorization header.
   */
  async saleWithToken(args: {
    memberSep: string | number;
    amount: number;
    cardToken: string;
    last4: string;
    cardType: string;
    validate: ValidatePaymentResult;
    paymentToken: string | null;
  }): Promise<SaleResult> {
    const res = await fetch(`${this.gatewayBase()}/sedc/api/payments/cc/${args.validate.ClientId}/ivr/sale`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(args.paymentToken ? { Authorization: `Bearer ${args.paymentToken}` } : {}) },
      body: JSON.stringify({
        ApplicationId: 3,
        UniqueId: args.validate.UniqueId,
        CustomerAccountNumber: pad11(args.memberSep),
        BillAmount: args.amount.toFixed(2),
        Token: args.cardToken,
        Last4: args.last4,
        CardType: args.cardType,
        ConvenienceFee: '0',
        PaymentDate: new Date().toISOString().replace('T', ' ').slice(0, 23),
        CallBackHeader: '69',
        CCMerchantID: args.validate.CreditCardMerchantId,
        CreateProfile: 'false',
        ConvenienceFlag: false,
        SSLEnabled: args.validate.SSLEnabled === 'true',
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Payment gateway HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as SaleResult;
  }
}
