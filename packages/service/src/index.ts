// horry-demo entry point. kcdev2 :8165 behind nginx /horry/ (systemd horry-demo).
import { join } from 'node:path';
import { env, dataDir, twilioConfigured, wxccConfigured, staffingConfigured } from './env.js';
import { JsonStore } from './store.js';
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
import { EslClient } from './esl.js';
import { AgentFirstBridge, defaultOptions as agentFirstDefaults } from './agent-first.js';

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

// Agent-first calls through the WFC AI Controller (use case 1): freeSWITCH's event socket is
// on this VM. Unset FS_ESL_ENABLED = the hand-off button records only, agent transfers by hand.
const esl = env.FS_ESL_ENABLED
  ? new EslClient({ host: env.FS_ESL_HOST, port: env.FS_ESL_PORT, password: env.FS_ESL_PASSWORD, events: ['CHANNEL_PARK', 'CHANNEL_HANGUP', 'CHANNEL_UNBRIDGE', 'CHANNEL_BRIDGE', 'BACKGROUND_JOB'] })
  : undefined;
esl?.start();
const agentFirst = new AgentFirstBridge(esl, {
  ...agentFirstDefaults(),
  reentryDial: env.FS_REENTRY_DIAL,
  originateTimeoutS: env.FS_ORIGINATE_TIMEOUT_S,
  ...(env.FS_HOLD_ANNOUNCE !== undefined ? { holdAnnounce: env.FS_HOLD_ANNOUNCE } : {}),
  holdMusic: env.FS_HOLD_MUSIC,
  ...(env.FS_BACK_ANNOUNCE !== undefined ? { backAnnounce: env.FS_BACK_ANNOUNCE } : {}),
});

// Live quality management: transcript + sentiment of agent calls on the controller, listen / whisper /
// join from AI Operations, sentiment drill-in on Customer Review (src/live-qa.ts).
const { LiveQa, defaultOptions: qaDefaults, claudeScorer, rulesScorer } = await import('./live-qa.js');
const qa = new LiveQa(esl, calls, agentFirst, {
  ...qaDefaults(),
  streamUrl: env.QA_STREAM_URL ?? `ws://127.0.0.1:${env.PORT}/api/qa/stream`,
  monitorDial: env.QA_MONITOR_DIAL,
  monitorCallerId: env.QA_MONITOR_CALLER_ID,
  alertAt: env.QA_ALERT_SCORE,
  scorer: env.ANTHROPIC_API_KEY ? claudeScorer(env.ANTHROPIC_API_KEY, env.QA_MODEL) : rulesScorer,
  scorerName: env.ANTHROPIC_API_KEY ? 'claude' : 'rules',
  transcription: Boolean(env.DEEPGRAM_API_KEY),
  alertSmsTo: env.QA_ALERT_SMS_TO ?? '',
  sendSms: (to, body, purpose) => sms.send(to, body, purpose),
  savannahSolution: env.QA_SAVANNAH_SOLUTION,
  // Take over on Savannah's side = an escalation to the supervisor: the flow reads it back from
  // api/intake/:guid after the controller hands the call back (department "supervisor").
  sendToSupervisor: async (call, by) => {
    const row = calls.get(call.guid) ?? calls.seed({ guid: call.guid, ani: call.ani, dnis: '', channel: 'voice', stormMode: false, memberName: call.member });
    const esc = { department: 'supervisor', urgency: 'emergency', reason: 'supervisor_takeover', summary: `${by} is taking this call from Savannah.`, at: new Date().toISOString() };
    calls.patch(row, { escalation: esc });
    calls.step(row, 'escalated', `supervisor / emergency: ${by} is taking the call`, 'escalation');
    const { relayResultToFreeswitch } = await import('./freeswitch.js');
    return relayResultToFreeswitch(row.guid, { escalate: 'true', department: esc.department, urgency: esc.urgency, reason: esc.reason, summary: esc.summary, caller_name: row.memberName ?? '', account_number: row.memberSep ?? '' });
  },
});

const app = await buildServer({ dataDir, members, nextgen, outages, calls, sms, payments, mode, staffing, handoffs, reminders, agentFirst, qa });
// The supervisor's monitor phone is saved through PATCH api/settings (routes.ts owns settings.json); read it fresh here.
const settingsStore = new JsonStore<{ supervisorPhone?: string }>(join(dataDir, 'settings.json'));
(await import('./qa-routes.js')).registerQa(app, { qa, calls, settings: () => settingsStore.load() ?? {} });
(await import('./chat.js')).registerChat(app, { dataDir, members, nextgen, outages, calls, sms, payments, mode, staffing, handoffs, reminders }); // web chat (site.html bubble ↔ <horry-chat>)
(await import('./agent-desk.js')).registerAgentDeskRoutes(app, { dataDir, members, nextgen, outages, calls, sms, payments, handoffs, mode, staffing, agentFirst }); // agent desktop: <horry-member> + billing.html
(await import('./email.js')).registerEmail(app, { dataDir, members, nextgen, outages }); // email board: <horry-email> (api/emails...)
await app.listen({ port: env.PORT, host: env.HOST });
console.log(
  `HORRY listening on ${env.HOST}:${env.PORT} — NextGen ${nextgen.isMock ? 'MOCK' : 'LIVE'}, Twilio ${twilioConfigured() ? 'real' : 'simulated'}, ` +
    `WxCC storm variable ${wxccConfigured() ? 'real' : 'local only'}, outage-queue staffing ${staffingConfigured() ? 'real' : 'simulated'}, FS relay ${fsRelayConfigured() ? 'real' : 'simulated'}, agent-first ${esl ? `ESL ${env.FS_ESL_HOST}:${env.FS_ESL_PORT}` : 'off'}, storm=${mode.get().storm}`
);
