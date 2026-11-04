// HTTP + WebSocket surface for live quality management (live-qa.ts).
//
//   GET  api/qa/live                        → every call in progress (Savannah's and the agents'),
//                                             one line each, with sentiment, alert, monitor state
//                                             and which actions apply
//   GET  api/qa/sessions/:guid              → one session with its transcript and timeline
//   POST api/qa/sessions/:guid/monitor      {mode: listen|whisper|join|takeover, phone, by}
//   POST api/qa/sessions/:guid/monitor/stop
//   POST api/qa/sessions/:guid/ack          {by}
//   POST api/qa/sessions                    {guid, ani, member?, agentName?, phase?}   (API-fed session)
//   POST api/qa/sessions/:guid/turns        {speaker, text}                            (API-fed turn)
//   POST api/qa/sessions/:guid/end
//   WS   api/qa/stream?guid=&ani=           the controller's stereo audio (mod_audio_stream)
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CallRow, CallStore } from './calls.js';
import { openDeepgram, type SttStream } from './deepgram.js';
import { env, last10 } from './env.js';
import type { LiveQa, MonitorMode, Phase, QaSession, Speaker } from './live-qa.js';

export interface QaDeps {
  qa: LiveQa;
  calls: CallStore;
  settings: () => { supervisorPhone?: string };
}

const MODES: readonly MonitorMode[] = ['listen', 'whisper', 'join', 'takeover'];
const NO_ACTIONS = { listen: false, whisper: false, join: false, takeover: false };

export function registerQa(f: FastifyInstance, d: QaDeps): void {
  const { qa, calls } = d;

  const withWhom = (phase: Phase, agentName: string, by?: string) =>
    phase === 'savannah' ? 'Savannah' : phase === 'supervisor' ? `${by || 'supervisor'} (supervisor)` : agentName || 'an agent';

  const dto = (s: QaSession, full = false) => {
    const agentName = s.agentName || calls.get(s.guid)?.agentName || '';
    return {
      guid: s.guid,
      ani: s.ani,
      member: s.member,
      agentName,
      with: withWhom(s.phase, agentName, s.monitor?.by),
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      state: s.state,
      phase: s.phase,
      paused: s.paused,
      score: s.score,
      label: s.label,
      why: s.why,
      alert: s.alert ?? null,
      monitor: s.monitor ? { by: s.monitor.by, mode: s.monitor.mode, startedAt: s.monitor.startedAt } : null,
      monitorNote: s.monitorNote,
      transcription: s.transcription,
      scorer: s.scorer,
      controller: Boolean(s.legA),
      actions: qa.actions(s),
      turns: s.turns.length,
      lastMember: [...s.turns].reverse().find((t) => t.speaker === 'member')?.text ?? '',
      ...(full ? { transcript: s.turns, readings: s.readings } : {}),
    };
  };

  /** A call in progress the service knows only from its row (no controller session: the stream
   *  is off, or the member is with an agent after Savannah handed the call back). */
  const rowDto = (r: CallRow) => {
    const withAgent = Boolean(r.escalation) || r.journey.some((j) => j.step.startsWith('agent_'));
    const phase: Phase = withAgent ? 'agent' : 'savannah';
    return {
      guid: r.guid,
      ani: r.ani,
      member: r.memberName ?? 'Unknown caller',
      agentName: r.agentName ?? '',
      with: withAgent && !r.agentName && r.escalation ? (r.escalation.department === 'supervisor' ? 'on their way to the supervisor' : 'waiting for an agent') : withWhom(phase, r.agentName ?? ''),
      startedAt: r.startedAt,
      endedAt: null,
      state: 'live' as const,
      phase,
      paused: false,
      score: r.qa?.score ?? 0,
      label: r.qa?.label ?? r.sentiment ?? 'neutral',
      why: r.qa?.why ?? '',
      alert: r.qa?.alertAt ? { at: r.qa.alertAt, why: r.qa.why, acknowledgedBy: r.qa.acknowledgedBy } : null,
      monitor: null,
      monitorNote: r.qa?.takenOverBy ? `Taken over by ${r.qa.takenOverBy}.` : '',
      transcription: 'off' as const,
      scorer: r.qa?.scorer ?? qa.opts.scorerName,
      controller: false,
      actions: NO_ACTIONS,
      turns: r.qa?.turns.length ?? 0,
      lastMember: [...(r.qa?.turns ?? [])].reverse().find((t) => t.speaker === 'member')?.text ?? '',
      lastStep: r.journey.at(-1)?.detail ?? '',
    };
  };

  f.get('/api/qa/live', async () => {
    const live = qa.live();
    const liveGuids = new Set(live.map((s) => s.guid));
    const inProgress = calls
      .all()
      .filter((r) => !r.endedAt && r.channel === 'voice' && !liveGuids.has(r.guid) && Date.now() - Date.parse(r.startedAt) < 30 * 60_000 && (r.conversationId || r.journey.some((j) => j.step !== 'identified')))
      .map(rowDto);
    const all = [...live.map((s) => dto(s)), ...inProgress].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return {
      ...qa.status(),
      live: all.length,
      flagged: all.filter((c) => c.alert && !c.alert.acknowledgedBy).length,
      supervisorPhone: d.settings().supervisorPhone ?? '',
      calls: all,
      generatedAt: new Date().toISOString(),
    };
  });

  f.get('/api/qa/sessions/:guid', async (req, reply) => {
    const s = qa.get((req.params as { guid: string }).guid);
    return s ? dto(s, true) : reply.code(404).send({ error: 'No such call' });
  });

  f.post('/api/qa/sessions/:guid/monitor', async (req, reply) => {
    const guid = (req.params as { guid: string }).guid;
    const b = (req.body ?? {}) as { mode?: string; phone?: string; by?: string };
    const mode = MODES.find((m) => m === b.mode);
    if (!mode) return reply.code(400).send({ error: 'mode must be listen, whisper, join or takeover' });
    const phone = last10(b.phone || d.settings().supervisorPhone || '');
    try {
      return dto(await qa.monitor(guid, mode, String(b.by ?? 'supervisor').slice(0, 60), phone));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  f.post('/api/qa/sessions/:guid/monitor/stop', async (req, reply) => {
    const s = await qa.stopMonitor((req.params as { guid: string }).guid);
    return s ? dto(s) : reply.code(404).send({ error: 'No such call' });
  });

  f.post('/api/qa/sessions/:guid/ack', async (req, reply) => {
    const s = qa.acknowledge((req.params as { guid: string }).guid, String(((req.body ?? {}) as { by?: string }).by ?? 'supervisor').slice(0, 60));
    return s ? dto(s) : reply.code(404).send({ error: 'No such call' });
  });

  // API-fed sessions: a chat path, a test, or a demo without the controller.
  f.post('/api/qa/sessions', async (req, reply) => {
    const b = (req.body ?? {}) as { guid?: string; ani?: string; member?: string; agentName?: string; phase?: string };
    if (!b.guid) return reply.code(400).send({ error: 'guid required' });
    const phase = (['agent', 'savannah'] as const).find((p) => p === b.phase);
    return dto(qa.start({ guid: b.guid, ani: last10(b.ani ?? ''), ...(b.member ? { member: b.member } : {}), ...(b.agentName ? { agentName: b.agentName } : {}), ...(phase ? { phase } : {}) }));
  });
  f.post('/api/qa/sessions/:guid/turns', async (req, reply) => {
    const b = (req.body ?? {}) as { speaker?: string; text?: string };
    const speaker = (['member', 'agent', 'savannah', 'supervisor'] as const).find((s) => s === b.speaker) as Speaker | undefined;
    if (!speaker || !b.text) return reply.code(400).send({ error: 'speaker (member|agent|savannah|supervisor) and text required' });
    const t = qa.addTurn((req.params as { guid: string }).guid, speaker, String(b.text));
    return t ? { ok: true, turn: t } : reply.code(404).send({ error: 'No live session for that call' });
  });
  f.post('/api/qa/sessions/:guid/end', async (req, reply) => {
    const s = qa.end((req.params as { guid: string }).guid);
    return s ? dto(s) : reply.code(404).send({ error: 'No such call' });
  });

  // ---- the controller's audio ------------------------------------------------------------------
  // mod_audio_stream opens one socket per call: s16le stereo 8 kHz frames, channel 0 = member,
  // channel 1 = the other side. Socket close = the leg is gone.
  const wss = new WebSocketServer({ noServer: true });
  f.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.endsWith('/api/qa/stream')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onStream(ws, url));
  });

  function onStream(ws: WebSocket, url: URL): void {
    const guid = url.searchParams.get('guid') ?? '';
    const ani = url.searchParams.get('ani') ?? '';
    const s = qa.sessionForStream(guid, ani) ?? qa.start({ guid: guid || `stream-${Date.now()}`, ani });
    let stt: SttStream | undefined;
    let frames = 0;
    if (env.DEEPGRAM_API_KEY) {
      stt = openDeepgram(
        env.DEEPGRAM_API_KEY,
        env.DEEPGRAM_MODEL,
        (channel, text) => {
          const live = qa.get(s.guid);
          const speaker: Speaker = channel === 0 ? 'member' : live?.phase === 'savannah' ? 'savannah' : live?.phase === 'supervisor' ? 'supervisor' : 'agent';
          qa.addTurn(s.guid, speaker, text);
        },
        (err) => console.log(`HORRY QA ${s.guid.slice(0, 8)}: ${err}`),
      );
    }
    console.log(`HORRY QA ${s.guid.slice(0, 8)}: audio stream open (${stt ? 'transcribing' : 'no DEEPGRAM_API_KEY, audio ignored'})`);
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return; // mod_audio_stream's optional JSON metadata frame
      frames++;
      stt?.sendAudio(data as Buffer);
    });
    ws.on('close', () => {
      stt?.close();
      console.log(`HORRY QA ${s.guid.slice(0, 8)}: audio stream closed after ${frames} frames`);
      // The controller's hangup event closes the session; an API-fed one stays open.
    });
    ws.on('error', (err) => console.log(`HORRY QA ${s.guid.slice(0, 8)}: stream socket ${String(err)}`));
  }
}
