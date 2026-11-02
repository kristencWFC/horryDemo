// horry-demo entry point. kcdev2 :8165 behind nginx /horry/ (systemd horry-demo).
import { env, dataDir, twilioConfigured, wxccConfigured, staffingConfigured } from './env.js';
import { MemberStore } from './members.js';
import { NextGenClient } from './nextgen.js';
import { OutageStore } from './outages.js';
import { CallStore } from './calls.js';
import { Sms } from './sms.js';
import { Payments } from './payments.js';
import { ModeStore } from './mode.js';
import { StaffingStore } from './staffing.js';
import { HandoffStore } from './handoff.js';
import { ReminderStore } from './reminders.js';
import { wireNotifier } from './notify.js';
import { wireAgentSummaries } from './agent-summaries.js';
import { buildServer } from './server.js';
import { fsRelayConfigured } from './freeswitch.js';

const members = new MemberStore(dataDir);
const nextgen = NextGenClient.fromEnv(env.PORT);
const outages = new OutageStore(dataDir);
const calls = new CallStore(dataDir);
const sms = new Sms();
const payments = new Payments(nextgen);
const mode = new ModeStore(dataDir);
const staffing = new StaffingStore(dataDir);
const handoffs = new HandoffStore(dataDir); // agent → Savannah payment hand-offs (use case 1)
const reminders = new ReminderStore(dataDir); // payment reminder lists (use case 3)
wireNotifier(outages, sms);
wireAgentSummaries(calls);

const app = await buildServer({ dataDir, members, nextgen, outages, calls, sms, payments, mode, staffing, handoffs, reminders });
(await import('./chat.js')).registerChat(app, { dataDir, members, nextgen, outages, calls, sms, payments, mode, staffing, handoffs, reminders }); // web chat (site.html bubble ↔ <horry-chat>)
(await import('./agent-desk.js')).registerAgentDeskRoutes(app, { dataDir, members, nextgen, outages, calls, sms, payments, handoffs }); // agent desktop: <horry-member> + billing.html
(await import('./email.js')).registerEmail(app, { dataDir, members, nextgen, outages }); // email board: <horry-email> (api/emails...)
await app.listen({ port: env.PORT, host: env.HOST });
console.log(
  `HORRY listening on ${env.HOST}:${env.PORT} — NextGen ${nextgen.isMock ? 'MOCK' : 'LIVE'}, Twilio ${twilioConfigured() ? 'real' : 'simulated'}, ` +
    `WxCC storm variable ${wxccConfigured() ? 'real' : 'local only'}, outage-queue staffing ${staffingConfigured() ? 'real' : 'simulated'}, FS relay ${fsRelayConfigured() ? 'real' : 'simulated'}, storm=${mode.get().storm}`
);
