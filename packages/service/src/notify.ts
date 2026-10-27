// The restoration notifier — keeps the promises the AI made. Listens to OutageStore:
//  - etr      → text every waiting SMS subscriber the new estimate
//  - restored → each subscriber gets a text (or a call) "power is restored — still out?
//               reply OUT"; paced like the home-services SMS blasts so the console's
//               progress bar is visible
// Voice callbacks are SIMULATED for now (logged + marked notified); the real path is an
// ElevenLabs outbound call from the same agent (outboundDialer launcher) — TODO.md.
import type { OutageStore, Outage } from './outages.js';
import { spokenEtr } from './outages.js';
import type { Sms } from './sms.js';
import { env } from './env.js';

const PACE_MS = 350;

export function wireNotifier(outages: OutageStore, sms: Sms): void {
  outages.on('etr', (o: Outage) => {
    for (const sub of outages.subsFor(o.id).filter((s) => s.status === 'waiting' && s.channel === 'sms')) {
      void sms.send(
        sub.phone,
        `Horry Electric: updated estimate for power restoration at ${sub.address}: ${spokenEtr(o.etr, env.BUSINESS_TIMEZONE)}. We'll text you when it's back on.`,
        'etr_update'
      );
    }
  });

  outages.on('restored', (o: Outage) => {
    const subs = outages.subsFor(o.id).filter((s) => s.status === 'waiting');
    subs.forEach((sub, i) => {
      setTimeout(() => {
        if (sub.channel === 'sms') {
          void sms
            .send(
              sub.phone,
              `Horry Electric: power has been restored at ${sub.address}. Thank you for your patience, ${sub.memberName.split(' ')[0]}. Still out? Reply OUT and we'll send a crew. Reply STOP to opt out.`,
              'restored'
            )
            .then((m) => outages.updateSub(sub.id, { status: m.status === 'failed' ? 'failed' : 'notified', notifiedAt: m.at }));
        } else {
          console.log(`HORRY NOTIFY (simulated voice callback) → ${sub.phone}: power restored at ${sub.address}`);
          outages.updateSub(sub.id, { status: 'notified', notifiedAt: new Date().toISOString(), reply: 'voice callback (simulated)' });
        }
      }, i * PACE_MS).unref();
    });
  });
}
