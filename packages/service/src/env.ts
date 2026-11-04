// zod-validated env. Every external adapter is OPTIONAL — with an empty .env the
// whole demo runs simulated on a laptop (home-services house pattern).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
// The repo-root .env (the provisioning script reads the same file).
config({ path: join(here, '..', '..', '..', '.env'), quiet: true });

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8165),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:8165'),
  BUSINESS_TIMEZONE: z.string().default('America/New_York'),
  DATA_DIR: z.string().default(''),

  // ElevenLabs (agent tools + webhooks)
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_AGENT_ID: z.string().optional(),
  ELEVENLABS_WEBHOOK_SECRET: z.string().optional(),
  // Outbound reminder calls (use case 3): the Twilio number attached to Savannah, see scripts/attach-outbound-number.mjs.
  ELEVENLABS_PHONE_NUMBER_ID: z.string().optional(),
  OUTBOUND_CALLER_NUMBER: z.string().optional(),
  TOOL_SHARED_SECRET: z.string().optional(),

  // NextGen CIS Integration Web API (Meridian / NISC). Unset base = the built-in mock
  // served by this service at /mock/NextGenCISIntegration — same paths and JSON shapes
  // as the real API, so going live is these three values.
  NEXTGEN_BASE_URL: z.string().optional(),
  NEXTGEN_USERNAME: z.string().default('NEXTGENCISUSER'),
  NEXTGEN_PASSWORD: z.string().default('demo'),

  // Twilio SMS (restoration texts, payment links, inbound OUT/STATUS replies)
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_SMS_FROM: z.string().optional(),
  // Demo safety valve: when set, EVERY outbound text goes to this number instead.
  SMS_OVERRIDE_NUMBER: z.string().optional(),

  // freeSWITCH ivr-controller agent-tool relay (escalation → SIP BYE X-IVR-* headers)
  FS_AGENT_TOOL_URL: z.string().optional(),
  FS_AGENT_TOOL_SECRET: z.string().optional(),

  // Agent-first calls through the WFC AI Controller (use case 1, src/agent-first.ts): the
  // service drives freeSWITCH over its event socket on the same VM. Unset = the hand-off
  // button only records the hand-off and the agent transfers by hand.
  FS_ESL_ENABLED: z.enum(['true', 'false', '1', '0']).default('false').transform((v) => v === 'true' || v === '1'),
  FS_ESL_HOST: z.string().default('127.0.0.1'),
  FS_ESL_PORT: z.coerce.number().default(8021),
  FS_ESL_PASSWORD: z.string().default('ClueCon'),
  /** The re-entry into WxCC as the member: gateway cube (CUBE dial-peers 1145/1146) → EP_KC_Horry 972-430-9658, whose flow queues to the agent. */
  FS_REENTRY_DIAL: z.string().default('sofia/gateway/cube/+19724309658'),
  FS_ORIGINATE_TIMEOUT_S: z.coerce.number().default(45),
  /** What the AGENT hears while Savannah has the member: announcement WAV ('' = none) then looping music. */
  FS_HOLD_ANNOUNCE: z.string().optional(),
  FS_HOLD_MUSIC: z.string().default('/usr/share/freeswitch/sounds/ivr/onholdmusic.wav'),
  /** What the AGENT hears the moment the member is back ('' = nothing). */
  FS_BACK_ANNOUNCE: z.string().optional(),

  // Storm Mode = a WxCC Global Variable the flow reads. The middleware writes its
  // defaultValue through the Config API with a Service App token. Unset = local flag only.
  WXCC_API_BASE: z.string().default('https://api.wxcc-us1.cisco.com'),
  WEBEX_ORG_ID: z.string().optional(),
  WXCC_STORM_VARIABLE_ID: z.string().optional(),
  WEBEX_CLIENT_ID: z.string().optional(),
  WEBEX_CLIENT_SECRET: z.string().optional(),
  WEBEX_REFRESH_TOKEN: z.string().optional(),

  // Storm staffing: the outage queue whose team list the supervisor widget edits (same
  // Service App). Unset = simulated teams.
  WXCC_OUTAGE_QUEUE_ID: z.string().optional(),
  // Payment hand-off (use case 1): the entry point the Member tab transfers the call to. The id is
  // looked up by name through the config API; set WXCC_PAYMENT_EP_ID to skip the lookup.
  WXCC_PAYMENT_EP_NAME: z.string().default('EP_KC_Horry_Payment'),
  WXCC_PAYMENT_EP_ID: z.string().optional(),
  WXCC_PAYMENT_EP_DN: z.string().default('9729038486'),
  // The demo org is shared: the picker offers only teams whose name starts with this (plus
  // any team already on the queue), so nobody can staff Horry's queue with a colleague's team.
  WXCC_STAFFING_TEAM_PREFIX: z.string().default('KC_Horry'),

  // Live quality management (src/live-qa.ts): the controller streams agent calls to this
  // service; Deepgram transcribes, Claude rates the member's mood, the supervisor can listen /
  // whisper / join. Unset keys = no transcript (audio ignored) and word rules for the rating.
  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_MODEL: z.string().default('nova-2'),
  ANTHROPIC_API_KEY: z.string().optional(),
  QA_MODEL: z.string().default('claude-opus-5-5'),
  /** Where the controller sends the audio (this service, same VM). Default = ws://127.0.0.1:{PORT}/api/qa/stream */
  QA_STREAM_URL: z.string().optional(),
  /** Dial string for the supervisor's phone; {number} = the 10 digits typed on AI Operations. A SIP
   *  phone registered to the controller works too (e.g. user/1000, no placeholder). */
  QA_MONITOR_DIAL: z.string().default('sofia/gateway/cube/+1{number}'),
  QA_MONITOR_CALLER_ID: z.string().default('9724309658'),
  /** Text this number once per call that turns negative ('' = none). */
  QA_ALERT_SMS_TO: z.string().optional(),
  QA_ALERT_SCORE: z.coerce.number().default(-0.3),
  /** X-Solution-Name the flow sends Savannah's calls to the controller with (docs/wxcc-flow-notes.md
   *  step 5): the service watches the controller's bridge events for it to rate her calls live. */
  QA_SAVANNAH_SOLUTION: z.string().default('horryelectric'),

  // Cisco AI Assistant wrap-up summaries for the live-agent leg. URL template with
  // {interactionId} (and optionally {orgId}). Unset = simulated summaries. [CONFIRM] path.
  WXCC_SUMMARY_URL: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;
export const env: Env = EnvSchema.parse(process.env);

export const dataDir = env.DATA_DIR || join(here, '..', 'data');

export const twilioConfigured = (): boolean =>
  Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_SMS_FROM);

export const wxccConfigured = (): boolean =>
  Boolean(
    env.WEBEX_ORG_ID && env.WXCC_STORM_VARIABLE_ID && env.WEBEX_CLIENT_ID && env.WEBEX_CLIENT_SECRET && env.WEBEX_REFRESH_TOKEN
  );

export const staffingConfigured = (): boolean =>
  Boolean(env.WEBEX_ORG_ID && env.WXCC_OUTAGE_QUEUE_ID && env.WEBEX_CLIENT_ID && env.WEBEX_CLIENT_SECRET && env.WEBEX_REFRESH_TOKEN);

export const baseUrl = (): string => env.PUBLIC_BASE_URL.replace(/\/$/, '');

export const last10 = (p: string | undefined | null): string => String(p ?? '').replace(/\D/g, '').slice(-10);
