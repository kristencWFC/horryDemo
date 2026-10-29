// Outbound SMS (restoration notices, ETR updates, payment links) + an outbox the ops
// console shows. Real Twilio when TWILIO_* is set; otherwise a fake sender that only
// logs — the demo still shows every message in the outbox.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env, twilioConfigured, last10 } from './env.js';

export interface SmsMessage {
  at: string;
  to: string;
  body: string;
  direction: 'out' | 'in';
  status: 'sent' | 'simulated' | 'failed' | 'received';
  sid?: string;
  purpose: string;
}

export class Sms {
  private log: SmsMessage[] = [];
  /** Demo text number set on the AI Operations page (api/settings demoSmsTo): every text goes
   *  there instead of the member's phone. Wins over SMS_OVERRIDE_NUMBER. */
  demoTo = '';

  outbox(): SmsMessage[] {
    return [...this.log].reverse().slice(0, 200);
  }

  recordInbound(from: string, body: string): void {
    this.log.push({ at: new Date().toISOString(), to: last10(from), body, direction: 'in', status: 'received', purpose: 'reply' });
  }

  async send(to: string, body: string, purpose: string): Promise<SmsMessage> {
    const dest = last10(this.demoTo || env.SMS_OVERRIDE_NUMBER || to);
    const msg: SmsMessage = { at: new Date().toISOString(), to: last10(to), body, direction: 'out', status: 'simulated', purpose };
    this.log.push(msg);
    if (!twilioConfigured()) {
      console.log(`HORRY SMS (simulated) → ${dest}: ${body}`);
      return msg;
    }
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: `+1${dest}`, From: env.TWILIO_SMS_FROM!, Body: body }),
      });
      const j = (await res.json()) as { sid?: string; message?: string };
      msg.status = res.ok ? 'sent' : 'failed';
      msg.sid = j.sid;
      if (!res.ok) console.log(`HORRY SMS failed → ${dest}: ${j.message ?? res.status}`);
    } catch (err) {
      msg.status = 'failed';
      console.log(`HORRY SMS error → ${dest}: ${(err as Error).message}`);
    }
    return msg;
  }
}

/** Twilio webhook signature: base64(HMAC-SHA1(authToken, url + sorted key+value pairs)). */
export function twilioSignatureOk(url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!env.TWILIO_AUTH_TOKEN) return true;
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = createHmac('sha1', env.TWILIO_AUTH_TOKEN).update(data).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
