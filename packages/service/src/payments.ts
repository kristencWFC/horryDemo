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
  method: 'link' | 'keypad' | 'card_on_file';
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
