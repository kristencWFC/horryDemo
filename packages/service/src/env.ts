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
  // The demo org is shared: the picker offers only teams whose name starts with this (plus
  // any team already on the queue), so nobody can staff Horry's queue with a colleague's team.
  WXCC_STAFFING_TEAM_PREFIX: z.string().default('KC_Horry'),

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
