// Live quality management: the rules scorer, a session fed by transcript finals, the alert, the
// PCI pause during a hand-off, listen / whisper / join through a fake event socket, and what
// Customer Review gets when the call ends.
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentFirstBridge, defaultOptions as agentFirstDefaults } from '../src/agent-first.js';
import { CallStore } from '../src/calls.js';
import { LiveQa, defaultOptions, labelOf, maskDigits, rulesReading, type Turn } from '../src/live-qa.js';

class FakeEsl extends EventEmitter {
  ready = true;
  cmds: string[] = [];
  async api(cmd: string): Promise<string> {
    this.cmds.push(cmd);
    return '+OK';
  }
  async bgapi(cmd: string): Promise<string> {
    this.cmds.push(cmd);
    // Eavesdrop legs and the supervisor's take-over leg get a full uuid back (live-qa.ts parses it).
    return cmd.startsWith('originate') && cmd.includes('eavesdrop') ? '+OK 9e9e9e9e-1111-2222-3333-444444444444' : cmd.includes('horry_qa_monitor') ? '+OK 2b2b2b2b-1111-2222-3333-444444444444' : '+OK 2b2b2b2b';
  }
  park(uuid: string, vars: Record<string, string>) {
    this.emit('event', { 'Event-Name': 'CHANNEL_PARK', 'Unique-ID': uuid, ...vars });
  }
  hangup(uuid: string) {
    this.emit('event', { 'Event-Name': 'CHANNEL_HANGUP', 'Unique-ID': uuid, 'Hangup-Cause': 'NORMAL_CLEARING' });
  }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const turn = (speaker: Turn['speaker'], text: string): Turn => ({ at: new Date().toISOString(), speaker, text });

function setup(opts: Partial<ReturnType<typeof defaultOptions>> = {}) {
  const esl = new FakeEsl();
  const calls = new CallStore(mkdtempSync(join(tmpdir(), 'horry-qa-')));
  const bridge = new AgentFirstBridge(esl, { ...agentFirstDefaults(), holdAnnounce: '', holdMusic: '/tmp/moh.wav', backAnnounce: '' });
  const texts: string[] = [];
  const qa = new LiveQa(esl, calls, bridge, {
    ...defaultOptions(),
    transcription: true,
    streamUrl: 'ws://127.0.0.1:8165/api/qa/stream',
    alertSmsTo: '2145550100',
    sendSms: async (_to, body) => void texts.push(body),
    ...opts,
  });
  return { esl, calls, bridge, qa, texts };
}

async function memberArrives(esl: FakeEsl) {
  esl.park(A, {
    variable_horry_solution: 'HorryAgentFirst',
    variable_horry_role: 'caller',
    variable_horry_guid: 'guid-qa-1',
    'Caller-Caller-ID-Number': '+18435550118',
    'Caller-Caller-ID-Name': 'Jamie Skipper',
  });
  await tick();
}

describe('rules scorer', () => {
  it('reads anger and gratitude from the member\'s own words, latest words weighing most', () => {
    const angry = rulesReading([turn('member', 'This is the third time this month, it is ridiculous'), turn('agent', 'I understand')], 0);
    expect(angry.label).toBe('negative');
    expect(angry.why).toContain('third time');
    const happy = rulesReading([turn('member', 'This is ridiculous'), turn('agent', 'Let me fix that'), turn('member', 'Oh wonderful, thank you so much')], angry.score);
    expect(happy.score).toBeGreaterThan(angry.score);
    expect(labelOf(0)).toBe('neutral');
  });

  it('never keeps a card number', () => {
    expect(maskDigits('the card is 4242 4242 4242 4242 expiring 12 28')).toBe('the card is [digits removed] expiring 12 28');
    expect(maskDigits('account 00212040001')).toBe('account [digits removed]');
    expect(maskDigits('call me at 843-555-0118')).toBe('call me at 843-555-0118');
  });
});

describe('LiveQa with the controller', () => {
  it('starts a stereo stream of the member leg once the call is bridged, and ends with the call', async () => {
    const { esl, qa, calls } = setup();
    await memberArrives(esl);
    const s = qa.get('guid-qa-1')!;
    expect(s.state).toBe('live');
    expect(s.member).toBe('Jamie Skipper');
    expect(esl.cmds).toContain(`uuid_audio_stream ${A} start ws://127.0.0.1:8165/api/qa/stream?guid=guid-qa-1&ani=8435550118 stereo 8000`);
    qa.addTurn('guid-qa-1', 'agent', 'Thanks for calling Horry Electric, this is Tonya.');
    qa.addTurn('guid-qa-1', 'member', 'Hi, my power is still out and nobody called me back. I am fed up.');
    await tick(1500);
    expect(s.label).toBe('negative');
    expect(s.alert?.why).toContain('fed up');
    esl.hangup(A);
    await tick();
    expect(s.state).toBe('ended');
    const row = calls.get('guid-qa-1')!;
    expect(row.sentiment).toBe('negative');
    expect(row.qa?.turns).toHaveLength(2);
    expect(row.qa?.alertAt).toBeTruthy();
    expect(row.endedAt).toBeTruthy();
  });

  it('texts the supervisor once when a call turns negative, and acknowledges', async () => {
    const { esl, qa, texts } = setup();
    await memberArrives(esl);
    qa.addTurn('guid-qa-1', 'member', 'I want a supervisor, this is unacceptable');
    await tick(1500);
    qa.addTurn('guid-qa-1', 'member', 'Still unacceptable');
    await tick(1500);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('Jamie Skipper');
    qa.acknowledge('guid-qa-1', 'Kristen');
    expect(qa.get('guid-qa-1')!.alert?.acknowledgedBy).toBe('Kristen');
  });

  it('pauses the stream and drops any monitor while Savannah takes the payment; nothing from that phase is kept', async () => {
    const { esl, qa, bridge } = setup();
    await memberArrives(esl);
    await qa.monitor('guid-qa-1', 'listen', 'Kristen', '214-555-0100');
    expect(qa.get('guid-qa-1')!.monitor?.mode).toBe('listen');
    await bridge.handoff('843-555-0118', '1234');
    await tick();
    const s = qa.get('guid-qa-1')!;
    expect(s.phase).toBe('savannah');
    expect(esl.cmds).toContain(`uuid_audio_stream ${A} pause`);
    expect(s.monitor).toBeUndefined();
    expect(esl.cmds).toContain('uuid_kill 9e9e9e9e-1111-2222-3333-444444444444');
    expect(qa.addTurn('guid-qa-1', 'member', 'four two four two')).toBeUndefined();
    await expect(qa.monitor('guid-qa-1', 'listen', 'Kristen', '2145550100')).rejects.toThrow(/payment/);
    // Member back with the agent: the stream resumes.
    const c = bridge.activeByAni('843-555-0118')!;
    c.savannahLeg = 'savannah-leg';
    esl.park(A, { variable_horry_solution: 'HorryAgentFirst', variable_horry_role: 'caller', variable_horry_phase: 'savannah', variable_originate_disposition: 'SUCCESS' });
    await tick();
    expect(s.phase).toBe('agent');
    expect(esl.cmds).toContain(`uuid_audio_stream ${A} resume`);
  });

  it('listens, whispers and joins by eavesdropping the member leg from the supervisor\'s phone', async () => {
    const { esl, qa } = setup({ monitorDial: 'sofia/gateway/cube/+1{number}' });
    await memberArrives(esl);
    await expect(qa.monitor('guid-qa-1', 'join', 'Kristen', '')).rejects.toThrow(/10-digit/);
    const s = await qa.monitor('guid-qa-1', 'join', 'Kristen', '(214) 555-0100');
    const originate = esl.cmds.find((x) => x.includes('eavesdrop'))!;
    expect(originate).toContain('sofia/gateway/cube/+12145550100');
    expect(originate).toContain(`&eavesdrop(${A})`);
    expect(originate).toContain('eavesdrop_bridge_aleg=true');
    expect(originate).toContain('eavesdrop_bridge_bleg=true');
    expect(s.monitor?.by).toBe('Kristen');
    await qa.monitor('guid-qa-1', 'whisper', 'Kristen', '');
    expect(esl.cmds.at(-1)).toBe('uuid_recv_dtmf 9e9e9e9e-1111-2222-3333-444444444444 2');
    await qa.monitor('guid-qa-1', 'listen', 'Kristen', '');
    expect(esl.cmds.at(-1)).toBe('uuid_recv_dtmf 9e9e9e9e-1111-2222-3333-444444444444 0');
    // The supervisor hangs up their phone: the monitor clears on its own.
    esl.hangup('9e9e9e9e-1111-2222-3333-444444444444');
    expect(qa.get('guid-qa-1')!.monitor).toBeUndefined();
    expect(qa.get('guid-qa-1')!.monitorNote).toBe('Monitored by Kristen.');
  });

  it('dials a SIP phone as is when the dial string has no placeholder', async () => {
    const { esl, qa } = setup({ monitorDial: 'user/1000' });
    await memberArrives(esl);
    await qa.monitor('guid-qa-1', 'listen', 'Kristen', '');
    expect(esl.cmds.find((x) => x.includes('eavesdrop'))).toContain('}user/1000 &eavesdrop(');
  });

  it('take over on the agent line: the member leg is re-bridged to the supervisor and the agent\'s leg is dropped', async () => {
    const { esl, qa, bridge } = setup();
    await memberArrives(esl);
    const s = qa.get('guid-qa-1')!;
    const b = bridge.activeByAni('843-555-0118')!.b;
    expect(qa.actions(s)).toEqual({ listen: true, whisper: true, join: true, takeover: true });
    await qa.monitor('guid-qa-1', 'takeover', 'Kristen', '2145550100');
    const originate = esl.cmds.find((x) => x.startsWith('originate') && x.includes('horry_qa_monitor'))!;
    expect(originate).toContain('sofia/gateway/cube/+12145550100');
    expect(originate).toContain('&park()');
    expect(esl.cmds).toContain(`uuid_bridge ${A} 2b2b2b2b-1111-2222-3333-444444444444`);
    expect(esl.cmds).toContain(`uuid_kill ${b}`);
    expect(esl.cmds).not.toContain(`uuid_kill ${A}`);
    expect(s.phase).toBe('supervisor');
    expect(s.monitor?.mode).toBe('takeover');
    expect(qa.actions(s)).toEqual({ listen: false, whisper: false, join: false, takeover: false });
    // The agent's leg hangs up: the session stays live with the supervisor.
    esl.hangup(b);
    await tick();
    expect(s.state).toBe('live');
    // The supervisor hangs up: the member's leg is ended and the row records who took the call.
    esl.hangup('2b2b2b2b-1111-2222-3333-444444444444');
    await tick();
    expect(esl.cmds).toContain(`uuid_kill ${A}`);
    esl.hangup(A);
    await tick();
    expect(s.state).toBe('ended');
    expect(qa['calls'].get('guid-qa-1')!.qa?.takenOverBy).toBe('Kristen');
  });
});

describe("LiveQa on Savannah's calls", () => {
  const EL = 'e1e1e1e1-0000-0000-0000-000000000002';
  const SAV = 'a5a5a5a5-0000-0000-0000-000000000003';
  function savannahAnswers(esl: FakeEsl) {
    esl.emit('event', {
      'Event-Name': 'CHANNEL_BRIDGE',
      'Unique-ID': SAV,
      'Other-Leg-Unique-ID': EL,
      'Call-Direction': 'inbound',
      'Caller-Caller-ID-Number': '+18435550101',
      'variable_sip_h_X-Solution-Name': 'horryelectric',
      'variable_sip_h_X-Call-GUID': 'guid-sav-1',
    });
    return tick();
  }

  it('starts a session from the controller\'s bridge event and rates the member live', async () => {
    const { esl, qa, calls } = setup();
    calls.seed({ guid: 'guid-sav-1', ani: '8435550101', dnis: '', channel: 'voice', stormMode: false, memberName: 'Casey Hardee' });
    await savannahAnswers(esl);
    const s = qa.get('guid-sav-1')!;
    expect(s.phase).toBe('savannah');
    expect(s.member).toBe('Casey Hardee');
    expect(esl.cmds).toContain(`uuid_audio_stream ${SAV} start ws://127.0.0.1:8165/api/qa/stream?guid=guid-sav-1&ani=8435550101 stereo 8000`);
    qa.addTurn('guid-sav-1', 'savannah', 'Hi Casey, this is Savannah. Are you calling about the outage in Socastee?');
    qa.addTurn('guid-sav-1', 'member', 'Yes and this is ridiculous, it is the third time this month.');
    await tick(1500);
    expect(s.label).toBe('negative');
    expect(qa.actions(s)).toEqual({ listen: true, whisper: false, join: true, takeover: false });
    await expect(qa.monitor('guid-sav-1', 'whisper', 'Kristen', '2145550100')).rejects.toThrow(/Savannah/);
    // Her leg ends (she handed the call back), then the member leg: the row keeps the rating.
    esl.hangup(EL);
    expect(s.phase).toBe('agent');
    esl.hangup(SAV);
    await tick();
    expect(s.state).toBe('ended');
    expect(calls.get('guid-sav-1')!.sentiment).toBe('negative');
  });

  it('take the call from Savannah: escalates to the supervisor and drops her leg', async () => {
    const sent: string[] = [];
    const { esl, qa } = setup({ sendToSupervisor: async (c, by) => void sent.push(`${c.guid}:${by}`) || true });
    await savannahAnswers(esl);
    const s = qa.get('guid-sav-1')!;
    expect(qa.actions(s).takeover).toBe(true);
    await qa.monitor('guid-sav-1', 'takeover', 'Kristen', '');
    expect(sent).toEqual(['guid-sav-1:Kristen']);
    expect(esl.cmds).toContain(`uuid_kill ${EL}`);
    expect(s.monitorNote).toBe('Taken over by Kristen.');
  });

  it('ignores bridge events for other solutions and for the agent line', async () => {
    const { esl, qa } = setup();
    esl.emit('event', { 'Event-Name': 'CHANNEL_BRIDGE', 'Unique-ID': 'x-1', 'Other-Leg-Unique-ID': 'x-2', 'Call-Direction': 'inbound', 'variable_sip_h_X-Solution-Name': 'cretedemo' });
    await memberArrives(esl);
    esl.emit('event', { 'Event-Name': 'CHANNEL_BRIDGE', 'Unique-ID': A, 'Other-Leg-Unique-ID': 'b-1', 'Call-Direction': 'inbound', 'variable_sip_h_X-Solution-Name': 'horryelectric' });
    await tick();
    expect(qa.live()).toHaveLength(1);
    expect(qa.get('guid-qa-1')!.phase).toBe('agent');
  });
});

describe('LiveQa fed through the API (no controller)', () => {
  it('rates and records a session, but cannot monitor it', async () => {
    const calls = new CallStore(mkdtempSync(join(tmpdir(), 'horry-qa-')));
    const qa = new LiveQa(undefined, calls, undefined, { ...defaultOptions(), transcription: false });
    qa.start({ guid: 'api-1', ani: '8435550101', member: 'Casey Hardee', agentName: 'Mike R.' });
    qa.addTurn('api-1', 'member', 'Thank you so much, that was perfect');
    await tick(1500);
    expect(qa.get('api-1')!.label).toBe('positive');
    await expect(qa.monitor('api-1', 'listen', 'x', '2145550100')).rejects.toThrow(/Controller/);
    qa.end('api-1');
    const row = calls.get('api-1')!;
    expect(row.sentiment).toBe('positive');
    expect(row.agentName).toBe('Mike R.');
    expect(row.qa?.transcription).toBe('off');
  });
});
