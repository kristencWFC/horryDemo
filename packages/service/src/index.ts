// horry-demo entry point. kcdev2 :8165 behind nginx /horry/ (systemd horry-demo).
import { env, dataDir, twilioConfigured, wxccConfigured } from './env.js';
import { MemberStore } from './members.js';
import { NextGenClient } from './nextgen.js';
import { OutageStore } from './outages.js';
import { CallStore } from './calls.js';
import { Sms } from './sms.js';
import { Payments } from './payments.js';
import { ModeStore } from './mode.js';
import { wireNotifier } from './notify.js';
import { buildServer } from './server.js';
import { fsRelayConfigured } from './freeswitch.js';

const members = new MemberStore(dataDir);
const nextgen = NextGenClient.fromEnv(env.PORT);
const outages = new OutageStore(dataDir);
const calls = new CallStore(dataDir);
const sms = new Sms();
const payments = new Payments(nextgen);
const mode = new ModeStore(dataDir);
wireNotifier(outages, sms);

const app = await buildServer({ dataDir, members, nextgen, outages, calls, sms, payments, mode });
await app.listen({ port: env.PORT, host: env.HOST });
console.log(
  `HORRY listening on ${env.HOST}:${env.PORT} — NextGen ${nextgen.isMock ? 'MOCK' : 'LIVE'}, Twilio ${twilioConfigured() ? 'real' : 'simulated'}, ` +
    `WxCC storm variable ${wxccConfigured() ? 'real' : 'local only'}, FS relay ${fsRelayConfigured() ? 'real' : 'simulated'}, storm=${mode.get().storm}`
);
