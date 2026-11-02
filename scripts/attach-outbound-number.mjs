// Attach the Twilio number Savannah calls out from (use case 3, payment reminders).
//
//   node scripts/attach-outbound-number.mjs +12075315136 "Horry reminders"
//
// Imports the number into the WFC AI Agent platform with the Twilio credentials from .env
// (same account as texting), assigns it to Savannah (ELEVENLABS_AGENT_ID), and prints the
// phone_number_id to put in .env as ELEVENLABS_PHONE_NUMBER_ID — on the server too.
// Run it from a clean shell (no test env vars), like provision-agent.mjs.
import dotenv from 'dotenv';
dotenv.config({ override: true });

const [, , number, label = 'Horry reminders'] = process.argv;
const { ELEVENLABS_API_KEY: key, ELEVENLABS_AGENT_ID: agent, TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token } = process.env;
if (!number || !key || !agent || !sid || !token) {
  console.error('usage: node scripts/attach-outbound-number.mjs +1XXXXXXXXXX [label]  (needs ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN in .env)');
  process.exit(1);
}
const h = { 'xi-api-key': key, 'Content-Type': 'application/json' };

// Already imported? Reuse it.
const list = await (await fetch('https://api.elevenlabs.io/v1/convai/phone-numbers', { headers: h })).json();
let id = (Array.isArray(list) ? list : []).find((p) => p.phone_number === number)?.phone_number_id;
if (!id) {
  const r = await fetch('https://api.elevenlabs.io/v1/convai/phone-numbers', { method: 'POST', headers: h, body: JSON.stringify({ phone_number: number, label, sid, token }) });
  const j = await r.json();
  if (!r.ok) { console.error('import failed:', JSON.stringify(j)); process.exit(1); }
  id = j.phone_number_id;
  console.log(`imported ${number} → ${id}`);
} else console.log(`${number} already imported → ${id}`);

const a = await fetch(`https://api.elevenlabs.io/v1/convai/phone-numbers/${id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ agent_id: agent }) });
if (!a.ok) { console.error('assign failed:', await a.text()); process.exit(1); }
console.log(`assigned to agent ${agent}\n\nAdd to .env (local AND server):\nELEVENLABS_PHONE_NUMBER_ID=${id}\nOUTBOUND_CALLER_NUMBER=${number.replace(/\D/g, '').slice(-10)}`);
