// The controller-side state machine for agent-first calls, driven by a fake event socket:
// park → re-entry originate → bridge; hand-off → transfer A, hold B; A parks again → re-bridge.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AgentFirstBridge, defaultOptions, type ReturnInfo } from '../src/agent-first.js';

class FakeEsl extends EventEmitter {
  ready = true;
  cmds: string[] = [];
  async api(cmd: string): Promise<string> {
    this.cmds.push(cmd);
    return '+OK';
  }
  async bgapi(cmd: string): Promise<string> {
    this.cmds.push(cmd);
    return '+OK 2b2b2b2b';
  }
  park(uuid: string, vars: Record<string, string>) {
    this.emit('event', { 'Event-Name': 'CHANNEL_PARK', 'Unique-ID': uuid, ...vars });
  }
  hangup(uuid: string, cause = 'NORMAL_CLEARING') {
    this.emit('event', { 'Event-Name': 'CHANNEL_HANGUP', 'Unique-ID': uuid, 'Hangup-Cause': cause });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 10));
const A = 'aaaaaaaa-0000-0000-0000-000000000001';

function setup() {
  const esl = new FakeEsl();
  const opts = { ...defaultOptions(), holdAnnounce: '/tmp/announce.wav', holdMusic: '/tmp/moh.wav' };
  const bridge = new AgentFirstBridge(esl, opts);
  const returned: ReturnInfo[] = [];
  bridge.on('returned', (r: ReturnInfo) => returned.push(r));
  return { esl, bridge, returned };
}

async function memberArrives(esl: FakeEsl) {
  esl.park(A, {
    variable_horry_solution: 'HorryAgentFirst',
    variable_horry_role: 'caller',
    variable_horry_guid: 'guid-1',
    'Caller-Caller-ID-Number': '+18435550118',
    'Caller-Caller-ID-Name': 'Dorothy Skipper',
  });
  await tick();
}

describe('AgentFirstBridge', () => {
  it('dials back into WxCC as the member and bridges the legs', async () => {
    const { esl, bridge } = setup();
    await memberArrives(esl);
    const c = bridge.activeByAni('843-555-0118');
    expect(c?.state).toBe('bridged');
    expect(c?.guid).toBe('guid-1');
    const originate = esl.cmds.find((x) => x.startsWith('originate '))!;
    expect(originate).toContain('origination_caller_id_number=+18435550118');
    expect(originate).toContain('horry_role=agent');
    expect(originate).toContain('park_after_bridge=true');
    expect(originate).toContain('sofia/gateway/cube/+19724309658 &park()');
    expect(esl.cmds.at(-1)).toBe(`uuid_bridge ${A} ${c!.b}`);
  });

  it('refuses a second 1122 leg from the same member while the first is still connecting (loop guard)', async () => {
    const { esl, bridge } = setup();
    let release: (v: string) => void = () => undefined;
    esl.bgapi = (cmd: string) => {
      esl.cmds.push(cmd);
      return new Promise<string>((r) => (release = r)); // originate still in flight
    };
    await memberArrives(esl);
    esl.park('aaaaaaaa-0000-0000-0000-000000000002', { variable_horry_solution: 'HorryAgentFirst', 'Caller-Caller-ID-Number': '+18435550118' });
    await tick();
    expect(bridge.all()).toHaveLength(1);
    expect(esl.cmds.at(-1)).toBe('uuid_kill aaaaaaaa-0000-0000-0000-000000000002');
    release('+OK');
  });

  it('ignores parks that are not ours', async () => {
    const { esl, bridge } = setup();
    esl.park('other', { variable_horry_solution: 'LiveTranslate', 'Caller-Caller-ID-Number': '+15555550000' });
    await tick();
    expect(bridge.all()).toHaveLength(0);
    expect(esl.cmds).toHaveLength(0);
  });

  it('hands the member to Savannah, holds the agent, and re-bridges when she hangs up', async () => {
    const { esl, bridge, returned } = setup();
    await memberArrives(esl);
    const c = bridge.activeByAni('8435550118')!;
    await bridge.handoff('8435550118', '4321');
    expect(c.state).toBe('with_savannah');
    expect(c.handoffRef).toBe('4321');
    expect(esl.cmds.at(-1)).toBe(`uuid_transfer ${A} horry_savannah XML public`);

    // B falls out of the bridge and parks: the agent gets the announcement, then music.
    esl.park(c.b, { variable_horry_solution: 'HorryAgentFirst', variable_horry_role: 'agent' });
    await tick();
    expect(esl.cmds.slice(-2)).toEqual([
      `uuid_broadcast ${c.b} playback::/tmp/announce.wav aleg`,
      `uuid_broadcast ${c.b} endless_playback::/tmp/moh.wav aleg`,
    ]);

    // Savannah hangs up: A parks with the phase set and the bridge answered.
    esl.park(A, { variable_horry_solution: 'HorryAgentFirst', variable_horry_role: 'caller', variable_horry_phase: 'savannah', variable_originate_disposition: 'SUCCESS' });
    await tick();
    expect(c.state).toBe('bridged');
    expect(esl.cmds.slice(-2)).toEqual([`uuid_break ${c.b} all`, `uuid_bridge ${A} ${c.b}`]);
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ answered: true, reason: 'savannah_hungup' });
  });

  it('reports a hand-off Savannah never answered', async () => {
    const { esl, bridge, returned } = setup();
    await memberArrives(esl);
    await bridge.handoff('8435550118', '1111');
    esl.park(A, { variable_horry_solution: 'HorryAgentFirst', variable_horry_phase: 'savannah', variable_originate_disposition: 'NO_ANSWER' });
    await tick();
    expect(returned[0]).toMatchObject({ answered: false, reason: 'not_answered' });
    expect(bridge.activeByAni('8435550118')?.state).toBe('bridged');
  });

  it('recall pulls the member back and the park re-bridges', async () => {
    const { esl, bridge, returned } = setup();
    await memberArrives(esl);
    await bridge.handoff('8435550118', '2222');
    expect(await bridge.recall('8435550118')).toBe(true);
    expect(esl.cmds.at(-1)).toBe(`uuid_transfer ${A} horry_return XML public`);
    esl.park(A, { variable_horry_solution: 'HorryAgentFirst', variable_horry_phase: 'return' });
    await tick();
    expect(returned[0]).toMatchObject({ reason: 'recalled' });
  });

  it("pulls the member back itself when Savannah's leg ends without A parking", async () => {
    const { esl, bridge, returned } = setup();
    await memberArrives(esl);
    const c = bridge.activeByAni('8435550118')!;
    await bridge.handoff('8435550118', '5555');
    // A leaves the AGENT's bridge first (that is the hand-off itself): must NOT recall.
    esl.emit('event', { 'Event-Name': 'CHANNEL_UNBRIDGE', 'Unique-ID': A, 'Other-Leg-Unique-ID': c.b });
    await new Promise((r) => setTimeout(r, 1700));
    expect(esl.cmds.some((x) => x.includes('horry_return'))).toBe(false);
    // A bridges to Savannah's leg, then her leg hangs up; A never parks on its own.
    esl.emit('event', { 'Event-Name': 'CHANNEL_BRIDGE', 'Unique-ID': A, 'Other-Leg-Unique-ID': 'savannah-leg', variable_horry_phase: 'savannah' });
    await tick();
    expect(c.savannahLeg).toBe('savannah-leg');
    esl.emit('event', { 'Event-Name': 'CHANNEL_HANGUP', 'Unique-ID': 'savannah-leg', 'Other-Leg-Unique-ID': A, 'Hangup-Cause': 'NORMAL_CLEARING' });
    await new Promise((r) => setTimeout(r, 1700));
    expect(esl.cmds.at(-1)).toBe(`uuid_transfer ${A} horry_return XML public`);
    esl.park(A, { variable_horry_solution: 'HorryAgentFirst', variable_horry_phase: 'return', variable_originate_disposition: 'SUCCESS' });
    await tick();
    expect(c.state).toBe('bridged');
    expect(returned[0]).toMatchObject({ answered: true, reason: 'savannah_hungup' });
  });

  it('an automatic recall after wrap-up reads as Savannah finishing, not the agent cancelling', async () => {
    const { esl, bridge, returned } = setup();
    await memberArrives(esl);
    await bridge.handoff('8435550118', '6666');
    expect(await bridge.recall('8435550118', 'auto')).toBe(true);
    expect(await bridge.recall('8435550118', 'auto')).toBe(true); // second call is a no-op
    expect(esl.cmds.filter((x) => x.includes('horry_return'))).toHaveLength(1);
    esl.park(A, { variable_horry_solution: 'HorryAgentFirst', variable_horry_phase: 'return', variable_originate_disposition: 'SUCCESS' });
    await tick();
    expect(returned[0]).toMatchObject({ reason: 'savannah_hungup' });
  });

  it('refuses a hand-off for a call that is not bridged through us', async () => {
    const { bridge } = setup();
    await expect(bridge.handoff('8435550199', '3333')).rejects.toThrow(/did not come through/);
  });

  it('either leg hanging up ends both', async () => {
    const { esl, bridge } = setup();
    await memberArrives(esl);
    const c = bridge.activeByAni('8435550118')!;
    esl.hangup(c.b);
    await tick();
    expect(c.state).toBe('ended');
    expect(esl.cmds.slice(-2)).toEqual([`uuid_kill ${A}`, `uuid_kill ${c.b}`]);
    expect(bridge.activeByAni('8435550118')).toBeUndefined();
  });

  it('a failed re-entry hangs the member up so the flow queues them', async () => {
    const { esl, bridge } = setup();
    esl.bgapi = async (cmd: string) => {
      esl.cmds.push(cmd);
      return '-ERR NO_ROUTE_DESTINATION';
    };
    await memberArrives(esl);
    expect(bridge.all()[0]?.state).toBe('ended');
    expect(esl.cmds.some((x) => x === `uuid_kill ${A}`)).toBe(true);
  });
});
