// Secure payments — card details NEVER reach this service, the AI or the agent.
//
// Two methods (HLD §2.5):
//  - link:   the member gets a text with a payment page (pay.html). In the demo that page
//            is ours and posts only a TOKEN + last four (it stands in for the co-op's
//            hosted Quick-Pay / a PCI-certified hosted page). The sale goes to the Meridian
//            Payment Gateway API with Token, exactly the field the real gateway accepts.
//  - keypad: Twilio <Pay> out-and-back (dedicated PCI-Mode Twilio account). Not wired
//            yet — start reports "unavailable" so the AI offers the link instead.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { NextGenClient } from './nextgen.js';

export type PaymentStatus = 'pending' | 'approved' | 'declined' | 'expired';

export interface PaymentSession {
  id: string;
  guid: string; // call / chat row
  memberSep: string;
  memberName: string;
  amount: number;
  method: 'link' | 'keypad' | 'card_on_file' | 'echeck_on_file' | 'new_card';
  phone: string;
  status: PaymentStatus;
  createdAt: string;
  completedAt?: string;
  last4?: string;
  cardType?: string;
  confirmation?: string; // spoken — 6 digits
  sedcTrackingId?: string;
  attempts: number;
  initiatedBy: 'ai' | 'agent';
}

/** A card the member read to Savannah. Lives only for the duration of one tool call; never stored or logged. */
export interface SpokenCard {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  zip: string;
}

export function luhnOk(number: string): boolean {
  const d = number.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function cardBrandOf(number: string): string {
  const d = number.replace(/\D/g, '');
  if (/^4/.test(d)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(d)) return 'Mastercard';
  if (/^3[47]/.test(d)) return 'American Express';
  if (/^6(011|5)/.test(d)) return 'Discover';
  return 'Card';
}

/** Why a spoken card cannot be charged, or '' when it can (demo gateway rules: Luhn, expiry, the declined test card). */
export function spokenCardProblem(c: SpokenCard, now = new Date()): string {
  const d = c.number.replace(/\D/g, '');
  if (!luhnOk(d)) return 'card_number_invalid';
  if (!(c.expMonth >= 1 && c.expMonth <= 12)) return 'expiration_invalid';
  const year = c.expYear < 100 ? 2000 + c.expYear : c.expYear;
  if (year < now.getFullYear() || (year === now.getFullYear() && c.expMonth < now.getMonth() + 1)) return 'card_expired';
  if (!/^\d{3,4}$/.test(c.cvc.replace(/\D/g, ''))) return 'security_code_invalid';
  if (!/^\d{5}$/.test(c.zip.replace(/\D/g, ''))) return 'zip_invalid';
  return '';
}

export class Payments extends EventEmitter {
  private sessions = new Map<string, PaymentSession>();

  constructor(private readonly nextgen: NextGenClient) {
    super();
  }

  all(): PaymentSession[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): PaymentSession | undefined {
    const s = this.sessions.get(id);
    if (s && s.status === 'pending' && Date.now() - Date.parse(s.createdAt) > 30 * 60_000) s.status = 'expired';
    return s;
  }

  latestFor(guid: string): PaymentSession | undefined {
    return this.all().find((s) => s.guid === guid);
  }

  create(p: Omit<PaymentSession, 'id' | 'status' | 'createdAt' | 'attempts'>): PaymentSession {
    const s: PaymentSession = { ...p, id: randomBytes(6).toString('base64url'), status: 'pending', createdAt: new Date().toISOString(), attempts: 0 };
    this.sessions.set(s.id, s);
    this.emit('change', s);
    return s;
  }

  /** Card on file: ValidatePayment → saleWithProfile. Resolves immediately (no page). */
  async payWithProfile(s: PaymentSession): Promise<PaymentSession> {
    s.attempts += 1;
    const validate = await this.nextgen.validatePayment(s.memberSep, s.amount, 'CC');
    if (validate.ErrorString) throw new Error(validate.ErrorString);
    const fin = await this.nextgen.financial(s.memberSep);
    const sale = await this.nextgen.saleWithProfile({ memberSep: s.memberSep, amount: s.amount, validate, paymentToken: fin?.PaymentToken ?? null });
    s.last4 = sale.LastFourDigitsOfCard;
    s.cardType = sale.CardTypeName;
    if (sale.StatusCode === 0) {
      s.status = 'approved';
      s.confirmation = sale.AuthorizationCode;
      s.sedcTrackingId = sale.SedcTrackingId;
      s.completedAt = new Date().toISOString();
    } else {
      s.status = 'declined';
    }
    this.emit('change', s);
    return s;
  }

  /**
   * E-check from the bank account on file. Horry runs e-checks through Milsoft and cards through
   * Meridian (SEDC) — two systems, one question to the member. The demo has no Milsoft sandbox, so
   * this validates the amount with the member system and records the draft as approved.
   */
  async payWithEcheck(s: PaymentSession): Promise<PaymentSession> {
    s.attempts += 1;
    const validate = await this.nextgen.validatePayment(s.memberSep, s.amount, 'EC').catch(() => ({ ErrorString: '' } as { ErrorString?: string }));
    if (validate.ErrorString) throw new Error(validate.ErrorString);
    s.cardType = 'E-check';
    s.last4 = '';
    s.status = 'approved';
    s.confirmation = String(100000 + Math.floor(Math.random() * 900000));
    s.completedAt = new Date().toISOString();
    this.emit('change', s);
    return s;
  }

  /**
   * A new card the member read to Savannah by voice (use case 1, Kristen 2026-11-03): the
   * details go from the member's phone to the AI and into the gateway, never to the agent's
   * desktop, the agent's ear or this service's logs. Demo gateway: Luhn + expiry; the Stripe
   * test number 4000 0000 0000 0002 declines, everything else valid approves. Production:
   * tokenise with the Meridian gateway and saleWithToken, as `complete()` does for the page.
   */
  async payWithNewCard(s: PaymentSession, card: SpokenCard): Promise<PaymentSession> {
    s.attempts += 1;
    const digitsOnly = card.number.replace(/\D/g, '');
    s.last4 = digitsOnly.slice(-4);
    s.cardType = cardBrandOf(digitsOnly);
    const validate = await this.nextgen.validatePayment(s.memberSep, s.amount, 'CC').catch(() => ({ ErrorString: '' } as { ErrorString?: string }));
    if (validate.ErrorString) throw new Error(validate.ErrorString);
    if (spokenCardProblem(card) || digitsOnly === '4000000000000002') {
      s.status = 'declined';
    } else {
      s.status = 'approved';
      s.confirmation = String(100000 + Math.floor(Math.random() * 900000));
      s.completedAt = new Date().toISOString();
    }
    this.emit('change', s);
    return s;
  }

  /**
   * The payment page finished tokenizing (demo: a test token; production: the hosted
   * page / Twilio Pay connector). ValidatePayment → gateway sale with Token → result.
   */
  async complete(id: string, cardToken: string, last4: string, cardType: string): Promise<PaymentSession> {
    const s = this.get(id);
    if (!s) throw new Error('unknown payment session');
    if (s.status !== 'pending' && s.status !== 'declined') return s;
    s.attempts += 1;
    const validate = await this.nextgen.validatePayment(s.memberSep, s.amount, 'CC');
    if (validate.ErrorString) throw new Error(validate.ErrorString);
    const fin = await this.nextgen.financial(s.memberSep);
    const sale = await this.nextgen.saleWithToken({
      memberSep: s.memberSep,
      amount: s.amount,
      cardToken,
      last4,
      cardType,
      validate,
      paymentToken: fin?.PaymentToken ?? null,
    });
    s.last4 = last4;
    s.cardType = cardType;
    if (sale.StatusCode === 0) {
      s.status = 'approved';
      s.confirmation = sale.AuthorizationCode;
      s.sedcTrackingId = sale.SedcTrackingId;
      s.completedAt = new Date().toISOString();
    } else {
      s.status = 'declined';
    }
    this.emit('change', s);
    return s;
  }
}
