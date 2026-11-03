// Agent-first calls through the WFC AI Controller (use case 1 redesign, Kristen 2026-11-03).
//
// A member who calls 972-903-8486 (EP_KC_Horry_Payment) is bridged by that flow to freeSWITCH
// 1122 with X-Solution-Name: HorryAgentFirst. The dialplan intercept
// (deploy/freeswitch/dialplan-horry-agent-first.xml) answers that leg (A) and parks it; this
// module, on the event socket of the same VM, then:
//
//   1. originates leg B back into WxCC (gateway cube, CUBE dial-peers 1145/1146 → EP_KC_Horry
//      972-430-9658) presenting the member's own number, so the main flow queues it to
//      Q_Horry_Billing and the agent's Desktop pops the member; then uuid_bridge A B. The
//      member hears WxCC's own queue treatment on B, never us. (Kristen 2026-11-03: Horry's
//      own numbers, not the Live Translate re-entry, so demos stay separate.)
//   2. on "Hand payment to Savannah": uuid_transfer A → dialplan ext `horry_savannah`, which
//      bridges A to Savannah's SIP number with the call GUID. B falls out of the bridge and
//      parks (park_after_bridge); we play the agent an announcement + hold music on it. The
//      agent's Desktop task never ends and the agent never hears the payment.
//   3. when Savannah hangs up (or never answered, or the agent cancels), A parks again with
//      horry_phase set; we stop the hold audio and uuid_bridge A B. Same task, no re-queue.
//
// Either leg hanging up ends the other. The shape is Live Translate's (kc-wiki
// live-translation-pattern) minus the audio streams: park + bridge only, no media bugs.
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { EslEvent, EslLike } from './esl.js';
import { last10 } from './env.js';

export const SOLUTION = 'HorryAgentFirst';

export type AgentFirstState = 'connecting' | 'bridged' | 'with_savannah' | 'ended';

export interface AgentFirstCall {
  /** Leg A: the member, as bridged to us by the WxCC flow. */
  a: string;
  /** Leg B: our re-entry into WxCC, the leg the agent answers. */
  b: string;
  ani: string;
  name: string;
  guid: string;
  state: AgentFirstState;
  startedAt: number;
  savannahAt?: number;
  holdStarted?: boolean;
  handoffRef?: string;
  /** Who asked for the member back: the agent (Cancel) or the service (wrap-up / post-call / her leg ended). */
  recallWhy?: 'agent' | 'auto';
  /** Savannah's SIP leg, learned from A's CHANNEL_BRIDGE while handing off. */
  savannahLeg?: string;
  endedAt?: number;
  endedBy?: string;
}

export interface AgentFirstOptions {
  reentryDial: string;
  originateTimeoutS: number;
  savannahExtension: string;
  returnExtension: string;
  /** Files freeSWITCH plays to the AGENT while Savannah has the member ('' = skip). */
  holdAnnounce: string;
  holdMusic: string;
  /** Safety net: a hand-off that runs this long is pulled back. */
  maxSavannahMs: number;
}

const here = dirname(fileURLToPath(import.meta.url));
/** Committed in the repo so freeSWITCH (same VM) can read it by absolute path. */
export const DEFAULT_HOLD_ANNOUNCE = join(here, '..', 'public', 'audio', 'savannah-hold.wav');

export const defaultOptions = (): AgentFirstOptions => ({
  reentryDial: 'sofia/gateway/cube/+19724309658',
  originateTimeoutS: 45,
  savannahExtension: 'horry_savannah',
  returnExtension: 'horry_return',
  holdAnnounce: existsSync(DEFAULT_HOLD_ANNOUNCE) ? DEFAULT_HOLD_ANNOUNCE : '',
  holdMusic: '/usr/share/freeswitch/sounds/ivr/onholdmusic.wav',
  maxSavannahMs: 15 * 60_000,
});

export interface ReturnInfo {
  call: AgentFirstCall;
  /** Savannah's leg answered (she had the member), or it never connected. */
  answered: boolean;
  reason: 'savannah_hungup' | 'not_answered' | 'recalled';
}

/**
 * Events: 'started' (call), 'bridged' (call), 'handoff' (call), 'returned' (ReturnInfo),
 * 'ended' (call). Wired to the hand-off record in agent-desk.ts.
 */
export class AgentFirstBridge extends EventEmitter {
  private calls = new Map<string, AgentFirstCall>(); // by leg A uuid
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly esl: EslLike | undefined,
    private readonly opts: AgentFirstOptions = defaultOptions(),
  ) {
    super();
    esl?.on('event', (ev: EslEvent) => void this.onEvent(ev));
  }

  get enabled(): boolean {
    return Boolean(this.esl);
  }

  status() {
    return {
      enabled: this.enabled,
      connected: this.esl?.ready ?? false,
      reentry: this.opts.reentryDial,
      live: this.all().filter((c) => c.state !== 'ended').length,
    };
  }

  all(): AgentFirstCall[] {
    return [...this.calls.values()].sort((x, y) => y.startedAt - x.startedAt);
  }

  /** The live agent-first call for this member's number (bridged or with Savannah). */
  activeByAni(ani: string): AgentFirstCall | undefined {
    const p = last10(ani);
    return p ? this.all().find((c) => c.state !== 'ended' && c.ani === p) : undefined;
  }

  byLeg(uuid: string): AgentFirstCall | undefined {
    return this.calls.get(uuid) ?? this.all().find((c) => c.b === uuid);
  }

  private tag(c: AgentFirstCall): string {
    return `HORRY AGENT-FIRST ${c.ani || '?'} a=${c.a.slice(0, 8)}`;
  }

  // ---------------------------------------------------------------- events

  async onEvent(ev: EslEvent): Promise<void> {
    const name = ev['Event-Name'];
    const uuid = ev['Unique-ID'] ?? '';
    if (!uuid) return;
    try {
      // Trace every event that touches one of our legs: freeSWITCH's own log file is not
      // being written on kc-dev-2 (stopped 2026-09-18), so this is the only record.
      const mine = this.byLeg(uuid) ?? this.byLeg(ev['Other-Leg-Unique-ID'] ?? '');
      if (mine && mine.state !== 'ended') {
        console.log(`${this.tag(mine)}: ${name} on ${uuid === mine.a ? 'A' : uuid === mine.b ? 'B' : 'other leg ' + uuid.slice(0, 8)} phase=${ev['variable_horry_phase'] ?? ''} cause=${ev['Hangup-Cause'] ?? ''} disp=${ev['variable_originate_disposition'] ?? ''}`);
      }
      const other = ev['Other-Leg-Unique-ID'] ?? '';
      if (mine && mine.state === 'with_savannah') {
        // A bridging to anything but B while handing off = Savannah's leg. (The first unbridge
        // after the hand-off is A leaving the AGENT — second live test 2026-11-03 recalled on it.)
        if (name === 'CHANNEL_BRIDGE' && uuid === mine.a && other && other !== mine.b) {
          mine.savannahLeg = other;
          return;
        }
        // Her leg ended, or A fell out of its bridge with her, and A did not park on its own:
        // pull A to the return extension ourselves (first live test: silence, no park).
        const herLegGone = mine.savannahLeg && ((name === 'CHANNEL_UNBRIDGE' && uuid === mine.a && other === mine.savannahLeg) || (name === 'CHANNEL_HANGUP' && uuid === mine.savannahLeg));
        if (herLegGone) {
          this.timer(mine, 'unbridged', 1500, () => void this.recall(mine.ani, 'auto'));
          return;
        }
      }
      if (name === 'CHANNEL_PARK') {
        if (ev['variable_horry_solution'] !== SOLUTION) return;
        if ((ev['variable_horry_role'] ?? 'caller') === 'agent') {
          // B parks twice: right after originate (&park) and when A leaves the bridge for Savannah.
          const c = this.byLeg(uuid);
          if (c && c.state === 'with_savannah') await this.startHold(c);
          return;
        }
        const c = this.calls.get(uuid);
        if (!c) {
          await this.newCall(uuid, ev);
          return;
        }
        if (c.state === 'with_savannah') await this.rejoin(c, ev);
      } else if (name === 'CHANNEL_HANGUP') {
        const c = this.byLeg(uuid);
        if (c && c.state !== 'ended') await this.end(c, uuid === c.a ? 'caller' : 'agent', ev['Hangup-Cause'] ?? 'unknown');
      }
    } catch (err) {
      console.log(`HORRY AGENT-FIRST event ${name} ${uuid.slice(0, 8)} failed: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- 1. re-entry + bridge

  private async newCall(a: string, ev: EslEvent): Promise<void> {
    const esl = this.esl;
    if (!esl) return;
    // Loop guard: if the re-entry number's flow ever bridged to 1122 as HorryAgentFirst too, our
    // own leg B would show up here as a new member within seconds. Refuse it rather than dial again.
    const ani = last10(ev['Caller-Caller-ID-Number'] ?? '');
    const dup = ani ? this.all().find((x) => x.ani === ani && x.state === 'connecting' && Date.now() - x.startedAt < 90_000) : undefined;
    if (dup) {
      console.log(`HORRY AGENT-FIRST ${ani}: a second 1122 leg arrived while the first is still connecting — the re-entry flow is bridging instead of queueing. Hanging it up.`);
      await esl.api(`uuid_kill ${a}`).catch(() => undefined);
      return;
    }
    const c: AgentFirstCall = {
      a,
      b: randomUUID(),
      ani,
      name: (ev['Caller-Caller-ID-Name'] ?? '').replace(/[{},'"\\]/g, '').trim(),
      guid: ev['variable_horry_guid'] || ev['variable_sip_h_X-Call-GUID'] || '',
      state: 'connecting',
      startedAt: Date.now(),
    };
    this.calls.set(a, c);
    if (this.calls.size > 100) for (const [k, v] of this.calls) if (v.state === 'ended' && this.calls.size > 60) this.calls.delete(k);
    console.log(`${this.tag(c)}: member on 1122 (guid ${c.guid || 'none'}) — dialing back into WxCC`);
    this.emit('started', c);
    try {
      // Comfort ringback on the answered A leg for the few seconds the re-entry takes; the
      // member hears WxCC's own queue treatment the moment B is up (Kristen 2026-11-03).
      await esl.api(`uuid_broadcast ${a} tone_stream://%(2000,4000,440,480);loops=-1 aleg`);
      const raw = ev['Caller-Caller-ID-Number'] ?? '';
      const callerId = raw.replace(/[^+\d]/g, '') || c.ani;
      const vars = [
        `origination_uuid=${c.b}`,
        `origination_caller_id_number=${callerId}`,
        `origination_caller_id_name='${c.name || callerId}'`,
        `horry_solution=${SOLUTION}`,
        'horry_role=agent',
        'sip_copy_custom_headers=false', // never reflect Webex's own X- headers back at it
        'park_after_bridge=true', // when A leaves for Savannah, B parks instead of hanging up
        'hangup_after_bridge=false',
        'playback_terminators=none',
        'ignore_early_media=true',
        `originate_timeout=${this.opts.originateTimeoutS}`,
      ].join(',');
      const res = await esl.bgapi(`originate {${vars}}${this.opts.reentryDial} &park()`, (this.opts.originateTimeoutS + 15) * 1000);
      if (c.state === 'ended') return;
      if (!res.startsWith('+OK')) throw new Error(`originate: ${res}`);
      await esl.api(`uuid_break ${a} all`);
      const bridged = await esl.api(`uuid_bridge ${a} ${c.b}`);
      if (bridged.startsWith('-ERR')) throw new Error(`uuid_bridge: ${bridged}`);
      c.state = 'bridged';
      console.log(`${this.tag(c)}: agent leg up, bridged`);
      this.emit('bridged', c);
    } catch (err) {
      console.log(`${this.tag(c)}: re-entry failed (${(err as Error).message}) — hanging up so the flow's failure path queues the member`);
      await this.end(c, 'setup', 'REENTRY_FAILED');
    }
  }

  // ---------------------------------------------------------------- 2. hand-off

  /** Send the member to Savannah and hold the agent. Throws when there is no live bridged call. */
  async handoff(ani: string, ref: string): Promise<AgentFirstCall> {
    const esl = this.esl;
    if (!esl) throw new Error('The WFC AI Controller is not connected to this service.');
    const c = this.activeByAni(ani);
    if (!c) throw new Error('This call did not come through the WFC AI Controller, so it cannot be handed off automatically.');
    if (c.state === 'with_savannah') throw new Error('Savannah already has this member.');
    if (c.state !== 'bridged') throw new Error('The call is still connecting.');
    c.handoffRef = ref;
    c.savannahAt = Date.now();
    c.holdStarted = false;
    c.recallWhy = undefined;
    c.savannahLeg = undefined;
    c.state = 'with_savannah';
    const r = await esl.api(`uuid_transfer ${c.a} ${this.opts.savannahExtension} XML public`);
    if (r.startsWith('-ERR')) {
      c.state = 'bridged';
      throw new Error(`The controller refused the transfer (${r}).`);
    }
    console.log(`${this.tag(c)}: member sent to Savannah (ref ${ref})`);
    this.emit('handoff', c);
    // B's park event starts the hold audio; this covers a missed event.
    this.timer(c, 'hold', 1500, () => void this.startHold(c));
    this.timer(c, 'max', this.opts.maxSavannahMs, () => void this.recall(c.ani));
    return c;
  }

  private async startHold(c: AgentFirstCall): Promise<void> {
    const esl = this.esl;
    if (!esl || c.holdStarted || c.state !== 'with_savannah') return;
    c.holdStarted = true;
    // Broadcasts queue on the channel, so the announcement plays first, then the music loops.
    if (this.opts.holdAnnounce) await esl.api(`uuid_broadcast ${c.b} playback::${this.opts.holdAnnounce} aleg`).catch(() => undefined);
    if (this.opts.holdMusic) await esl.api(`uuid_broadcast ${c.b} endless_playback::${this.opts.holdMusic} aleg`).catch(() => undefined);
  }

  /** Pull the member back from Savannah: the agent's Cancel, or the service once she is done. */
  async recall(ani: string, why: 'agent' | 'auto' = 'agent'): Promise<boolean> {
    const esl = this.esl;
    const c = this.activeByAni(ani);
    if (!esl || !c || c.state !== 'with_savannah') return false;
    if (c.recallWhy) return true; // already on its way back
    c.recallWhy = why;
    console.log(`${this.tag(c)}: recalling the member from Savannah (${why})`);
    const r = await esl.api(`uuid_transfer ${c.a} ${this.opts.returnExtension} XML public`);
    if (r.startsWith('-ERR')) {
      c.recallWhy = undefined;
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- 3. back together

  private async rejoin(c: AgentFirstCall, ev: EslEvent): Promise<void> {
    const esl = this.esl;
    if (!esl) return;
    this.clearTimers(c);
    const phase = ev['variable_horry_phase'] ?? '';
    const disposition = ev['variable_originate_disposition'] ?? '';
    const heldMs = Date.now() - (c.savannahAt ?? Date.now());
    const answered = Boolean(c.savannahLeg) || disposition === 'SUCCESS' || heldMs > 8000;
    const reason: ReturnInfo['reason'] = phase === 'return' && c.recallWhy !== 'auto' ? 'recalled' : answered ? 'savannah_hungup' : 'not_answered';
    c.recallWhy = undefined;
    c.savannahLeg = undefined;
    await esl.api(`uuid_break ${c.b} all`).catch(() => undefined);
    const bridged = await esl.api(`uuid_bridge ${c.a} ${c.b}`);
    if (bridged.startsWith('-ERR')) {
      console.log(`${this.tag(c)}: re-bridge failed (${bridged}) — ending`);
      await this.end(c, 'rejoin', 'REBRIDGE_FAILED');
      return;
    }
    c.state = 'bridged';
    c.holdStarted = false;
    console.log(`${this.tag(c)}: member back with the agent (${reason}, ${Math.round(heldMs / 1000)} s)`);
    this.emit('returned', { call: c, answered, reason } satisfies ReturnInfo);
  }

  private async end(c: AgentFirstCall, by: string, cause: string): Promise<void> {
    c.state = 'ended';
    c.endedAt = Date.now();
    c.endedBy = `${by}:${cause}`;
    this.clearTimers(c);
    console.log(`${this.tag(c)}: ended by ${by} (${cause})`);
    const esl = this.esl;
    if (esl) {
      // Either leg hanging up ends the other; uuid_kill on a gone channel is harmless.
      for (const leg of [c.a, c.b]) await esl.api(`uuid_kill ${leg}`).catch(() => undefined);
    }
    this.emit('ended', c);
  }

  private timer(c: AgentFirstCall, key: string, ms: number, fn: () => void): void {
    const id = `${c.a}:${key}`;
    clearTimeout(this.timers.get(id));
    const t = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    t.unref();
    this.timers.set(id, t);
  }

  private clearTimers(c: AgentFirstCall): void {
    for (const key of ['hold', 'max', 'unbridged']) {
      const id = `${c.a}:${key}`;
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
    }
  }
}
