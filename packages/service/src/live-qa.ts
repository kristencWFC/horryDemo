// Live quality management (Horry asked for it after the 2026-11-04 demo).
//
//   During the call  a supervisor sees every live agent call with the member's sentiment as it
//                    moves, gets an alert when a call turns negative, and can listen, whisper to
//                    the agent or join from the AI Operations page.
//   After the call   Customer Review keeps the two-party transcript, the sentiment timeline and
//                    the reason, next to Savannah's summary (analytics.ts).
//
// Where the audio comes from: calls on the agent line (972-903-8486) ride the WFC AI Controller
// (agent-first.ts), so the member leg is a freeSWITCH channel. Once the legs are bridged the
// service asks the controller for a stereo stream of that leg (uuid_audio_stream → the WebSocket
// at api/qa/stream): channel 0 = the member, channel 1 = whoever they are talking to. Deepgram
// turns it into text; a scorer (Claude, or word rules when there is no key) rates the member's
// mood after each thing they say. Listen / whisper / join = the controller originates a call to
// the supervisor's phone and eavesdrops the member leg (eavesdrop: 0 = listen, 2 = speak to the
// agent only, 3 = speak to both).
//
// PCI: while Savannah has the member for a payment the stream is PAUSED, any monitor is dropped,
// and nothing from that phase is kept; long digit runs are masked before any text is stored.
import { EventEmitter } from 'node:events';
import type { AgentFirstBridge, AgentFirstCall, ReturnInfo } from './agent-first.js';
import type { CallStore } from './calls.js';
import type { EslEvent, EslLike } from './esl.js';
import { last10 } from './env.js';

export type Speaker = 'member' | 'agent' | 'savannah';
export type Label = 'positive' | 'neutral' | 'negative';
export type MonitorMode = 'listen' | 'whisper' | 'join';

export interface Turn {
  at: string;
  speaker: Speaker;
  text: string;
}

export interface Reading {
  at: string;
  score: number; // -1 (angry) .. +1 (delighted)
  label: Label;
  why: string;
}

export interface Monitor {
  by: string;
  mode: MonitorMode;
  uuid: string;
  dial: string;
  startedAt: string;
}

export interface QaSession {
  guid: string;
  /** The member leg on the controller ('' for sessions fed through the API). */
  legA: string;
  ani: string;
  member: string;
  agentName: string;
  startedAt: string;
  endedAt?: string;
  state: 'live' | 'ended';
  /** Who the member is talking to right now. */
  phase: 'agent' | 'savannah';
  turns: Turn[];
  readings: Reading[];
  score: number;
  label: Label;
  why: string;
  alert?: { at: string; why: string; acknowledgedBy?: string; acknowledgedAt?: string };
  monitor?: Monitor;
  /** Why the last monitor stopped ('' = none). */
  monitorNote: string;
  transcription: 'live' | 'off';
  /** What rated the sentiment on this call. */
  scorer: 'claude' | 'rules';
}

/** What Customer Review keeps on the call row when the session ends. */
export interface QaRecord {
  score: number;
  label: Label;
  why: string;
  readings: Reading[];
  turns: Turn[];
  alertAt?: string;
  acknowledgedBy?: string;
  monitoredBy?: string;
  agentName: string;
  scorer: 'claude' | 'rules';
  transcription: 'live' | 'off';
}

export type Scorer = (turns: Turn[], previous: number) => Promise<Omit<Reading, 'at'>>;

export interface LiveQaOptions {
  /** ws URL the controller streams audio to (this service's api/qa/stream). */
  streamUrl: string;
  /** Dial string for the supervisor's phone; {number} = the 10 digits they typed. */
  monitorDial: string;
  monitorCallerId: string;
  /** Below this the call is flagged. */
  alertAt: number;
  scorer: Scorer;
  scorerName: 'claude' | 'rules';
  transcription: boolean;
  /** Texted once per flagged call ('' = no text). */
  alertSmsTo: string;
  sendSms?: (to: string, body: string, purpose: string) => Promise<unknown>;
}

// ---- rules scorer (no key needed) --------------------------------------------------------

const PHRASES: [RegExp, number][] = [
  // strong negative
  [/\b(supervisor|manager)\b/, -0.6],
  [/\b(unacceptable|ridiculous|outrageous|absurd)\b/, -0.6],
  [/\b(cancel|switch|leave)\b.*\b(service|provider|co-?op)\b/, -0.6],
  [/\b(lawyer|attorney|report you|public service commission|psc)\b/, -0.6],
  [/\b(third|fourth|fifth|every) (time|month|week)\b/, -0.5],
  [/\b(sick of|fed up|had it|tired of)\b/, -0.6],
  [/\b(damn|hell|crap|bullshit|stupid|idiot|bs)\b/, -0.6],
  [/\b(hung up on|hang up on|nobody (called|answered)|no one (called|answered|cares))\b/, -0.5],
  // mild negative
  [/\b(frustrat\w*|annoy\w*|upset|angry|mad|furious|disappoint\w*)\b/, -0.4],
  [/\b(waste of|wasting my|not happy|unhappy|terrible|awful|worst|horrible|unfair)\b/, -0.4],
  [/\b(can'?t afford|shut (me )?off|disconnect\w*|cut (me )?off)\b/, -0.3],
  [/\b(still (out|no power|waiting)|how much longer|hours? now|all (day|night))\b/, -0.3],
  [/\b(why (is|does|do|would)|what do you mean|that'?s not right|doesn'?t make sense)\b/, -0.2],
  // positive
  [/\b(thank you so much|thanks so much|really appreciate|appreciate (it|that|you))\b/, 0.5],
  [/\b(wonderful|perfect|awesome|fantastic|excellent|you'?ve been (great|very helpful|a big help))\b/, 0.5],
  [/\b(thank you|thanks)\b/, 0.3],
  [/\b(great|good|helpful|sounds good|no problem|that works|okay great|alright great)\b/, 0.2],
];

export function rulesReading(turns: Turn[], previous: number): Omit<Reading, 'at'> {
  const mine = turns.filter((t) => t.speaker === 'member').slice(-8);
  if (!mine.length) return { score: previous, label: labelOf(previous), why: '' };
  let num = 0;
  let den = 0;
  let why = '';
  mine.forEach((t, i) => {
    const w = 0.4 + (0.6 * (i + 1)) / mine.length; // the latest words count most
    const low = t.text.toLowerCase();
    let s = 0;
    for (const [re, v] of PHRASES) if (re.test(low)) s += v;
    s = Math.max(-1, Math.min(1, s));
    if (s !== 0) why = `Member said "${t.text.trim()}"`;
    num += w * s;
    den += w;
  });
  const window = den ? num / den : 0;
  const score = round2(0.3 * previous + 0.7 * window);
  return { score, label: labelOf(score), why: why || (Math.abs(score) < 0.1 ? 'Matter-of-fact so far.' : '') };
}

export const rulesScorer: Scorer = async (turns, previous) => rulesReading(turns, previous);

export function labelOf(score: number): Label {
  return score <= -0.3 ? 'negative' : score >= 0.25 ? 'positive' : 'neutral';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Card and account numbers never reach a transcript: eleven or more digits in a row become a
 *  marker (a 10-digit phone number stays readable). */
export function maskDigits(text: string): string {
  return text.replace(/\d(?:[\s-]*\d){10,}/g, '[digits removed]');
}

// ---- sessions ------------------------------------------------------------------------------

export const defaultOptions = (): LiveQaOptions => ({
  streamUrl: 'ws://127.0.0.1:8165/api/qa/stream',
  monitorDial: 'sofia/gateway/cube/+1{number}',
  monitorCallerId: '9724309658',
  alertAt: -0.3,
  scorer: rulesScorer,
  scorerName: 'rules',
  transcription: false,
  alertSmsTo: '',
});

/**
 * Events: 'change' (session), 'alert' (session), 'ended' (session).
 */
export class LiveQa extends EventEmitter {
  private sessions = new Map<string, QaSession>(); // by guid
  private scoring = new Set<string>();
  private dirty = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly esl: EslLike | undefined,
    private readonly calls: CallStore,
    agentFirst: AgentFirstBridge | undefined,
    readonly opts: LiveQaOptions = defaultOptions(),
  ) {
    super();
    agentFirst?.on('bridged', (c: AgentFirstCall) => void this.onBridged(c));
    agentFirst?.on('handoff', (c: AgentFirstCall) => void this.onHandoff(c));
    agentFirst?.on('returned', (r: ReturnInfo) => void this.onReturned(r.call));
    agentFirst?.on('ended', (c: AgentFirstCall) => this.end(c.guid || c.a));
    esl?.on('event', (ev: EslEvent) => this.onEslEvent(ev));
  }

  status() {
    return {
      transcription: this.opts.transcription ? 'live' : 'off',
      scorer: this.opts.scorerName,
      monitor: this.esl ? 'controller' : 'off',
      live: this.live().length,
    };
  }

  all(): QaSession[] {
    return [...this.sessions.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  live(): QaSession[] {
    return this.all().filter((s) => s.state === 'live');
  }

  get(guid: string): QaSession | undefined {
    return this.sessions.get(guid);
  }

  byLeg(uuid: string): QaSession | undefined {
    return this.all().find((s) => s.legA === uuid);
  }

  /** A session for a call we know about (the controller's, or one created through the API). */
  start(p: { guid: string; legA?: string; ani: string; member?: string; agentName?: string }): QaSession {
    const existing = this.sessions.get(p.guid);
    if (existing && existing.state === 'live') return existing;
    const row = this.calls.get(p.guid) ?? this.calls.findRecentByAni(p.ani);
    const s: QaSession = {
      guid: p.guid,
      legA: p.legA ?? '',
      ani: last10(p.ani),
      member: p.member || row?.memberName || 'Unknown caller',
      agentName: p.agentName || row?.agentName || '',
      startedAt: new Date().toISOString(),
      state: 'live',
      phase: 'agent',
      turns: [],
      readings: [],
      score: 0,
      label: 'neutral',
      why: '',
      monitorNote: '',
      transcription: this.opts.transcription ? 'live' : 'off',
      scorer: this.opts.scorerName,
    };
    this.sessions.set(p.guid, s);
    if (this.sessions.size > 80) for (const [k, v] of this.sessions) if (v.state === 'ended' && this.sessions.size > 50) this.sessions.delete(k);
    console.log(`HORRY QA ${s.guid.slice(0, 8)}: session for ${s.member} (${s.ani})`);
    this.emit('change', s);
    return s;
  }

  /** The Member tab told us who answered. */
  setAgent(guid: string, agentName: string): void {
    const s = this.sessions.get(guid);
    if (s && agentName && s.agentName !== agentName) {
      s.agentName = agentName;
      this.emit('change', s);
    }
  }

  /** A final from the transcriber (or a test / the API): remember it and re-score. */
  addTurn(guid: string, speaker: Speaker, text: string, at = new Date().toISOString()): Turn | undefined {
    const s = this.sessions.get(guid);
    if (!s || s.state !== 'live') return undefined;
    if (s.phase === 'savannah') return undefined; // the payment: nothing kept
    const turn: Turn = { at, speaker, text: maskDigits(text.trim()) };
    if (!turn.text) return undefined;
    s.turns.push(turn);
    if (s.turns.length > 400) s.turns.splice(0, s.turns.length - 400);
    this.emit('change', s);
    if (speaker === 'member') this.scheduleScore(s, 1200);
    return turn;
  }

  private scheduleScore(s: QaSession, ms: number): void {
    this.dirty.add(s.guid);
    clearTimeout(this.timers.get(s.guid));
    const t = setTimeout(() => void this.score(s), ms);
    t.unref();
    this.timers.set(s.guid, t);
  }

  async score(s: QaSession): Promise<void> {
    if (this.scoring.has(s.guid)) return; // one in flight; re-run after if more arrived
    this.dirty.delete(s.guid);
    this.scoring.add(s.guid);
    try {
      const r = await this.opts.scorer(s.turns.slice(-16), s.score);
      const reading: Reading = { at: new Date().toISOString(), score: round2(Math.max(-1, Math.min(1, r.score))), label: r.label, why: r.why };
      s.readings.push(reading);
      if (s.readings.length > 200) s.readings.splice(0, s.readings.length - 200);
      s.score = reading.score;
      s.label = labelOf(reading.score);
      s.why = reading.why;
      if (s.label === 'negative' && reading.score <= this.opts.alertAt && !s.alert) {
        s.alert = { at: reading.at, why: reading.why };
        console.log(`HORRY QA ${s.guid.slice(0, 8)}: NEGATIVE (${s.score}) ${s.why}`);
        this.emit('alert', s);
        void this.notify(s);
      }
      this.emit('change', s);
    } catch (err) {
      console.log(`HORRY QA ${s.guid.slice(0, 8)}: scoring failed (${(err as Error).message})`);
    } finally {
      this.scoring.delete(s.guid);
      if (this.dirty.has(s.guid) && s.state === 'live') this.scheduleScore(s, 300);
    }
  }

  private async notify(s: QaSession): Promise<void> {
    const to = last10(this.opts.alertSmsTo);
    if (!to || !this.opts.sendSms) return;
    const who = s.agentName ? ` with ${s.agentName}` : '';
    await this.opts.sendSms(to, `Horry Electric: a call${who} is going badly (${s.member}). ${s.why} Open AI Operations to listen or join.`, 'qa_alert').catch(() => undefined);
  }

  acknowledge(guid: string, by: string): QaSession | undefined {
    const s = this.sessions.get(guid);
    if (!s?.alert) return s;
    s.alert.acknowledgedBy = by || 'supervisor';
    s.alert.acknowledgedAt = new Date().toISOString();
    this.emit('change', s);
    return s;
  }

  // ---- the controller's call -----------------------------------------------------------------

  private async onBridged(c: AgentFirstCall): Promise<void> {
    const s = this.start({ guid: c.guid || c.a, legA: c.a, ani: c.ani, member: c.name });
    s.legA = c.a;
    await this.stream(s, 'start');
  }

  private async onHandoff(c: AgentFirstCall): Promise<void> {
    const s = this.sessions.get(c.guid || c.a);
    if (!s || s.state !== 'live') return;
    s.phase = 'savannah';
    await this.stream(s, 'pause');
    if (s.monitor) await this.stopMonitor(s.guid, 'Monitoring stopped for the payment.');
    this.emit('change', s);
  }

  private async onReturned(c: AgentFirstCall): Promise<void> {
    const s = this.sessions.get(c.guid || c.a);
    if (!s || s.state !== 'live') return;
    s.phase = 'agent';
    await this.stream(s, 'resume');
    this.emit('change', s);
  }

  private async stream(s: QaSession, verb: 'start' | 'pause' | 'resume' | 'stop'): Promise<void> {
    if (!this.esl || !s.legA || !this.opts.transcription) return;
    const url = `${this.opts.streamUrl}?guid=${encodeURIComponent(s.guid)}&ani=${encodeURIComponent(s.ani)}`;
    const cmd = verb === 'start' ? `uuid_audio_stream ${s.legA} start ${url} stereo 8000` : `uuid_audio_stream ${s.legA} ${verb}`;
    const r = await this.esl.api(cmd).catch((err: Error) => `-ERR ${err.message}`);
    if (r.startsWith('-ERR')) console.log(`HORRY QA ${s.guid.slice(0, 8)}: audio stream ${verb} failed (${r})`);
  }

  /** The stream socket for a call: who it belongs to (the controller passes guid + ani on the URL). */
  sessionForStream(guid: string, ani: string): QaSession | undefined {
    return this.sessions.get(guid) ?? this.live().find((s) => s.ani === last10(ani));
  }

  end(guid: string): QaSession | undefined {
    const s = this.sessions.get(guid);
    if (!s || s.state === 'ended') return s;
    s.state = 'ended';
    s.endedAt = new Date().toISOString();
    clearTimeout(this.timers.get(guid));
    if (s.monitor && this.esl) void this.esl.api(`uuid_kill ${s.monitor.uuid}`).catch(() => undefined);
    s.monitor = undefined;
    this.persist(s);
    console.log(`HORRY QA ${s.guid.slice(0, 8)}: ended ${s.label} (${s.score}) after ${s.turns.length} turns`);
    this.emit('ended', s);
    this.emit('change', s);
    return s;
  }

  /** Customer Review reads the call row: sentiment, reason, timeline, transcript. */
  private persist(s: QaSession): void {
    const row = this.calls.get(s.guid) ?? (s.ani ? this.calls.findRecentByAni(s.ani) : undefined) ?? this.calls.seed({ guid: s.guid, ani: s.ani, dnis: '', channel: 'voice', stormMode: false, memberName: s.member, startedAt: s.startedAt });
    const qa: QaRecord = {
      score: s.score,
      label: s.label,
      why: s.why,
      readings: s.readings,
      turns: s.turns,
      ...(s.alert ? { alertAt: s.alert.at } : {}),
      ...(s.alert?.acknowledgedBy ? { acknowledgedBy: s.alert.acknowledgedBy } : {}),
      ...(s.monitorNote.startsWith('Monitored by') ? { monitoredBy: s.monitorNote.replace('Monitored by ', '').replace(/\.$/, '') } : {}),
      agentName: s.agentName,
      scorer: s.scorer,
      transcription: s.transcription,
    };
    // Savannah's post-call sentiment (ElevenLabs) wins when she had the whole call; here the member
    // talked to a person, so the live reading is the call's sentiment.
    this.calls.patch(row, {
      qa,
      ...(s.readings.length ? { sentiment: s.label } : {}),
      ...(s.agentName && !row.agentName ? { agentName: s.agentName } : {}),
      ...(row.endedAt ? {} : { endedAt: s.endedAt }),
      ...(row.memberName ? {} : { memberName: s.member }),
    });
  }

  // ---- listen / whisper / join -----------------------------------------------------------------

  private static readonly DTMF: Record<MonitorMode, string> = { listen: '0', whisper: '2', join: '3' };

  async monitor(guid: string, mode: MonitorMode, by: string, phone: string): Promise<QaSession> {
    const esl = this.esl;
    const s = this.sessions.get(guid);
    if (!s || s.state !== 'live') throw new Error('That call has ended.');
    if (!esl) throw new Error('The WFC AI Controller is not connected to this service.');
    if (!s.legA) throw new Error('This call did not come through the WFC AI Controller, so it cannot be monitored from here.');
    if (s.phase === 'savannah') throw new Error('Savannah is taking a payment on this call; monitoring resumes when the member is back with the agent.');
    if (s.monitor) {
      // Already on the call: switch what the supervisor's voice reaches (eavesdrop reads DTMF).
      const r = await esl.api(`uuid_recv_dtmf ${s.monitor.uuid} ${LiveQa.DTMF[mode]}`);
      if (r.startsWith('-ERR')) throw new Error(`The controller could not switch modes (${r}).`);
      s.monitor.mode = mode;
      this.emit('change', s);
      return s;
    }
    const number = last10(phone);
    if (this.opts.monitorDial.includes('{number}') && number.length !== 10) throw new Error('Enter the 10-digit phone the controller should call you on.');
    const dial = this.opts.monitorDial.replace('{number}', number);
    const vars = [
      `origination_caller_id_number=${this.opts.monitorCallerId}`,
      `origination_caller_id_name='Horry QA'`,
      'eavesdrop_enable_dtmf=true',
      `eavesdrop_bridge_aleg=${mode === 'join' ? 'true' : 'false'}`,
      `eavesdrop_bridge_bleg=${mode === 'join' || mode === 'whisper' ? 'true' : 'false'}`,
      'ignore_early_media=true',
      'originate_timeout=30',
      `horry_qa_monitor=${s.guid}`,
    ].join(',');
    const res = await esl.bgapi(`originate {${vars}}${dial} &eavesdrop(${s.legA})`, 45_000);
    const m = /^\+OK\s+([0-9a-f-]{36})/i.exec(res);
    if (!m) throw new Error(`The controller could not reach your phone (${res.slice(0, 80)}).`);
    s.monitor = { by: by || 'supervisor', mode, uuid: m[1]!, dial, startedAt: new Date().toISOString() };
    s.monitorNote = `Monitored by ${s.monitor.by}.`;
    console.log(`HORRY QA ${s.guid.slice(0, 8)}: ${s.monitor.by} ${mode} via ${dial}`);
    this.emit('change', s);
    return s;
  }

  async stopMonitor(guid: string, note = ''): Promise<QaSession | undefined> {
    const s = this.sessions.get(guid);
    if (!s?.monitor) return s;
    const uuid = s.monitor.uuid;
    s.monitor = undefined;
    if (note) s.monitorNote = note;
    if (this.esl) await this.esl.api(`uuid_kill ${uuid}`).catch(() => undefined);
    this.emit('change', s);
    return s;
  }

  private onEslEvent(ev: EslEvent): void {
    if (ev['Event-Name'] !== 'CHANNEL_HANGUP') return;
    const uuid = ev['Unique-ID'] ?? '';
    const s = this.live().find((x) => x.monitor?.uuid === uuid);
    if (s) {
      s.monitor = undefined;
      this.emit('change', s);
    }
  }
}

// ---- the Claude scorer ---------------------------------------------------------------------

const SYSTEM =
  'You rate the mood of an electric cooperative member during a live phone call with the co-op\'s contact center. ' +
  'The transcript is a live transcription, so words may be garbled. Rate ONLY the member (not the agent, not Savannah the assistant): ' +
  'how they feel toward the co-op and this call right now, weighting their most recent words most. ' +
  'Reply with one JSON object and nothing else: {"score": number from -1 (angry, threatening to leave, asking for a supervisor) ' +
  'through 0 (matter-of-fact) to 1 (warm, grateful), "label": "negative" | "neutral" | "positive", ' +
  '"why": one short sentence that quotes the member\'s own words that drove the score}. ' +
  'A member reporting an outage or a bill problem calmly is neutral, not negative. Do not include digits of any card or account number in "why".';

/** The live scorer: one short Messages call per new member turn (debounced), JSON out. */
export function claudeScorer(apiKey: string, model: string): Scorer {
  // The SDK is loaded lazily so the service (and its tests) never need it unless a key is set.
  let clientP: Promise<InstanceType<typeof import('@anthropic-ai/sdk').default>> | undefined;
  const client = () => (clientP ??= import('@anthropic-ai/sdk').then((m) => new m.default({ apiKey, maxRetries: 1, timeout: 20_000 })));
  return async (turns, previous) => {
    const c = await client();
    const who: Record<Speaker, string> = { member: 'Member', agent: 'Agent', savannah: 'Savannah' };
    const text = turns.map((t) => `${who[t.speaker]}: ${t.text}`).join('\n');
    const res = await c.messages.create({
      model,
      max_tokens: 300,
      system: SYSTEM,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: `Previous score: ${previous}\n\nTranscript so far (latest last):\n${text}` }],
    });
    if (res.stop_reason === 'refusal') return rulesReading(turns, previous);
    const out = res.content.find((b) => b.type === 'text')?.text ?? '';
    const json = /\{[\s\S]*\}/.exec(out)?.[0];
    if (!json) return rulesReading(turns, previous);
    const j = JSON.parse(json) as { score?: number; label?: string; why?: string };
    const score = typeof j.score === 'number' ? j.score : 0;
    return { score, label: labelOf(score), why: maskDigits(String(j.why ?? '')).slice(0, 240) };
  };
}
