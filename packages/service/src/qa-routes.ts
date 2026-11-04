// HTTP + WebSocket surface for live quality management (live-qa.ts).
//
//   GET  api/qa/live                        → live calls with sentiment, alerts, monitor state
//   GET  api/qa/sessions/:guid              → one session with its transcript and timeline
//   POST api/qa/sessions/:guid/monitor      {mode: listen|whisper|join, phone, by}
//   POST api/qa/sessions/:guid/monitor/stop
//   POST api/qa/sessions/:guid/ack          {by}
//   POST api/qa/sessions                    {guid, ani, member?, agentName?}   (API-fed session)
//   POST api/qa/sessions/:guid/turns        {speaker, text}                     (API-fed turn)
//   POST api/qa/sessions/:guid/end
//   WS   api/qa/stream?guid=&ani=           the controller's stereo audio (mod_audio_stream)
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CallStore } from './calls.js';
import { openDeepgram, type SttStream } from './deepgram.js';
import { env, last10 } from './env.js';
import type { LiveQa, MonitorMode, Speaker } from './live-qa.js';

export interface QaDeps {
  qa: LiveQa;
  calls: CallStore;
  settings: () => { supervisorPhone?: string };
}

export function registerQa(f: FastifyInstance, d: QaDeps): void {
  const { qa, calls } = d;

  const dto = (s: ReturnType<LiveQa['all']>[number], full = false) => ({
    guid: s.guid,
    ani: s.ani,
    member: s.member,
    agentName: s.agentName || calls.get(s.guid)?.agentName || '',
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? null,
    state: s.state,
    phase: s.phase,
    score: s.score,
    label: s.label,
    why: s.why,
    alert: s.alert ?? null,
    monitor: s.monitor ? { by: s.monitor.by, mode: s.monitor.mode, startedAt: s.monitor.startedAt } : null,
    monitorNote: s.monitorNote,
    transcription: s.transcription,
    scorer: s.scorer,
    controller: Boolean(s.legA),
    turns: s.turns.length,
    lastMember: [...s.turns].reverse().find((t) => t.speaker === 'member')?.text ?? '',
    ...(full ? { transcript: s.turns, readings: s.readings } : {}),
  });

  f.get('/api/qa/live', async () => {
    // Savannah's in-progress calls too, so the supervisor sees every live conversation in one place.
    const liveGuids = new Set(qa.live().map((s) => s.guid));
    const savannah = calls
      .all()
      .filter((r) => !r.endedAt && r.channel === 'voice' && !liveGuids.has(r.guid) && Date.now() - Date.parse(r.startedAt) < 30 * 60_000 && (r.conversationId || r.journey.some((j) => !j.step.startsWith('agent_') && j.step !== 'identified')))
      .map((r) => ({ guid: r.guid, member: r.memberName ?? 'Unknown caller', startedAt: r.startedAt, with: 'Savannah', lastStep: r.journey.at(-1)?.detail ?? '' }));
    return { ...qa.status(), supervisorPhone: d.settings().supervisorPhone ?? '', sessions: qa.live().map((s) => dto(s)), savannah, generatedAt: new Date().toISOString() };
  });

  f.get('/api/qa/sessions/:guid', async (req, reply) => {
    const s = qa.get((req.params as { guid: string }).guid);
    return s ? dto(s, true) : reply.code(404).send({ error: 'No such call' });
  });

  f.post('/api/qa/sessions/:guid/monitor', async (req, reply) => {
    const guid = (req.params as { guid: string }).guid;
    const b = (req.body ?? {}) as { mode?: string; phone?: string; by?: string };
    const mode = (['listen', 'whisper', 'join'] as const).find((m) => m === b.mode) as MonitorMode | undefined;
    if (!mode) return reply.code(400).send({ error: 'mode must be listen, whisper or join' });
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
    const b = (req.body ?? {}) as { guid?: string; ani?: string; member?: string; agentName?: string };
    if (!b.guid) return reply.code(400).send({ error: 'guid required' });
    return dto(qa.start({ guid: b.guid, ani: last10(b.ani ?? ''), ...(b.member ? { member: b.member } : {}), ...(b.agentName ? { agentName: b.agentName } : {}) }));
  });
  f.post('/api/qa/sessions/:guid/turns', async (req, reply) => {
    const b = (req.body ?? {}) as { speaker?: string; text?: string };
    const speaker = (['member', 'agent', 'savannah'] as const).find((s) => s === b.speaker) as Speaker | undefined;
    if (!speaker || !b.text) return reply.code(400).send({ error: 'speaker (member|agent|savannah) and text required' });
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
          const speaker: Speaker = channel === 0 ? 'member' : live?.phase === 'savannah' ? 'savannah' : 'agent';
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
      // The controller's 'ended' event closes the session; an API-fed one stays open.
    });
    ws.on('error', (err) => console.log(`HORRY QA ${s.guid.slice(0, 8)}: stream socket ${String(err)}`));
  }
}
