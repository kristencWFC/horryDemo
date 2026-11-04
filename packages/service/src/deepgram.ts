// Realtime speech-to-text for the live quality view (live-qa.ts): the WFC AI Controller streams
// the member leg as s16le stereo 8 kHz (channel 0 = member, channel 1 = whoever they are
// talking to); Deepgram multichannel gives per-channel finals, so speaker attribution is free.
// Adapted from agentLiveAssist/packages/middleware/src/stt/deepgram.ts (same key family).
import WebSocket from 'ws';

export type SttFinal = (channel: 0 | 1, text: string, atMs: number) => void;

export interface SttStream {
  sendAudio(buf: Buffer): void;
  close(): void;
}

export function deepgramUrl(model: string): string {
  return (
    'wss://api.deepgram.com/v1/listen' +
    `?model=${encodeURIComponent(model)}&encoding=linear16&sample_rate=8000&channels=2&multichannel=true` +
    '&smart_format=true&interim_results=false&endpointing=400&vad_events=false'
  );
}

export function openDeepgram(apiKey: string, model: string, onFinal: SttFinal, onError: (err: string) => void): SttStream {
  const ws = new WebSocket(deepgramUrl(model), { headers: { Authorization: `Token ${apiKey}` } });
  const queue: Buffer[] = [];
  let open = false;
  let closed = false;

  ws.on('open', () => {
    open = true;
    for (const b of queue.splice(0)) ws.send(b);
  });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString()) as {
        type?: string;
        is_final?: boolean;
        start?: number;
        channel_index?: [number, number];
        channel?: { alternatives?: { transcript?: string }[] };
      };
      if (msg.type !== 'Results' || !msg.is_final) return;
      const text = msg.channel?.alternatives?.[0]?.transcript ?? '';
      if (!text.trim()) return;
      onFinal((msg.channel_index?.[0] ?? 0) === 0 ? 0 : 1, text, Math.round((msg.start ?? 0) * 1000));
    } catch (err) {
      onError(`deepgram parse: ${String(err)}`);
    }
  });
  ws.on('error', (err) => onError(`deepgram socket: ${String(err)}`));
  ws.on('close', (code, reason) => {
    if (!closed) onError(`deepgram closed ${code} ${reason.toString()}`);
  });

  return {
    sendAudio(buf) {
      if (closed) return;
      if (open) ws.send(buf);
      else if (queue.length < 200) queue.push(buf); // a few seconds of pre-open audio
    },
    close() {
      closed = true;
      try {
        if (open) ws.send(JSON.stringify({ type: 'CloseStream' }));
        ws.close();
      } catch {
        /* already gone */
      }
    },
  };
}
