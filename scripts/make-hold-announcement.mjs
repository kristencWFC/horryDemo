#!/usr/bin/env node
// Makes packages/service/public/audio/savannah-hold.wav — what the AGENT hears while
// Savannah takes the member's payment (use case 1). Spoken in Savannah's own voice via
// ElevenLabs text-to-speech, written as 8 kHz mono 16-bit PCM WAV so freeSWITCH plays it
// as-is (uuid_broadcast). Committed to the repo; run again only to change the wording.
//
//   node scripts/make-hold-announcement.mjs ["custom wording"]
//
// Reads ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID from ./.env (never pass them on the
// command line).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envText = readFileSync(join(root, '.env'), 'utf8');
const envOf = (k) => (envText.match(new RegExp(`^${k}=(.*)$`, 'm')) ?? [])[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
const key = envOf('ELEVENLABS_API_KEY');
const agentId = envOf('ELEVENLABS_AGENT_ID');
if (!key || !agentId) {
  console.error('ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID must be in .env');
  process.exit(1);
}

const text =
  process.argv[2] ||
  "Savannah is taking the member's payment now. Please stay on the line; you'll be reconnected as soon as it's done.";

const headers = { 'xi-api-key': key, 'content-type': 'application/json' };
const agent = await (await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, { headers })).json();
const voiceId = agent?.conversation_config?.tts?.voice_id;
if (!voiceId) {
  console.error('Could not read the agent voice id', JSON.stringify(agent).slice(0, 200));
  process.exit(1);
}

const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_8000`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5' }),
});
if (!res.ok) {
  console.error('TTS failed', res.status, (await res.text()).slice(0, 300));
  process.exit(1);
}
const pcm = Buffer.from(await res.arrayBuffer());

// 44-byte WAV header for 8 kHz mono 16-bit PCM.
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(8000, 24);
header.writeUInt32LE(8000 * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);

const out = join(root, 'packages', 'service', 'public', 'audio', 'savannah-hold.wav');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, pcm]));
console.log(`wrote ${out} (${(pcm.length / 16000).toFixed(1)} s): "${text}"`);
