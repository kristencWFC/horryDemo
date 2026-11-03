// freeSWITCH inbound Event Socket client — TCP to :8021 on the same VM, auth, `api`/`bgapi`
// and JSON events. Copied from live-translate/packages/middleware/src/esl.ts (2026-09) so it
// stays fully typed with no dependency. The protocol is MIME-ish: header lines, blank line,
// optional body of Content-Length bytes.
//
// freeSWITCH answers commands in the order sent, so a FIFO of pending resolvers is enough.
// `api` blocks the socket until freeSWITCH replies, so anything slow (originate) goes
// through `bgapi` and resolves on its BACKGROUND_JOB event.
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';

export interface EslFrame {
  headers: Record<string, string>;
  body: string;
}

/** A JSON event as freeSWITCH sends it: flat string map, api output under `_body`. */
export type EslEvent = Record<string, string>;

export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      /* not URL-encoded */
    }
    out[key] = value;
  }
  return out;
}

/** Split every complete frame off the front of `buf`; the remainder waits for more bytes. */
export function extractFrames(buf: Buffer): { frames: EslFrame[]; rest: Buffer } {
  const frames: EslFrame[] = [];
  let rest = buf;
  for (;;) {
    const sep = rest.indexOf('\n\n');
    if (sep < 0) break;
    const headers = parseHeaders(rest.subarray(0, sep).toString('utf8'));
    const len = Number(headers['Content-Length'] ?? 0);
    const end = sep + 2 + len;
    if (rest.length < end) break;
    frames.push({ headers, body: rest.subarray(sep + 2, end).toString('utf8') });
    rest = rest.subarray(end);
  }
  return { frames, rest };
}

export interface EslOptions {
  host: string;
  port: number;
  password: string;
  /** Event names to subscribe to (plain names; CUSTOM subclasses as `CUSTOM sub::class`). */
  events: string[];
}

interface Pending {
  resolve: (f: EslFrame) => void;
  reject: (e: Error) => void;
}

/** What agent-first.ts needs from the socket; a fake stands in for it in tests. */
export interface EslLike extends EventEmitter {
  ready: boolean;
  api(cmd: string): Promise<string>;
  bgapi(cmd: string, timeoutMs?: number): Promise<string>;
}

export class EslClient extends EventEmitter implements EslLike {
  ready = false;
  private sock?: Socket;
  private buf: Buffer = Buffer.alloc(0);
  private pending: Pending[] = [];
  private jobs = new Map<string, (body: string) => void>();
  private stopped = false;
  private backoffMs = 1000;

  constructor(private readonly opts: EslOptions) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.sock?.destroy();
  }

  private connect(): void {
    const sock = new Socket();
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    sock.setNoDelay(true);
    sock.connect(this.opts.port, this.opts.host);
    sock.on('connect', () => {
      this.backoffMs = 1000;
    });
    sock.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      const { frames, rest } = extractFrames(this.buf);
      this.buf = rest;
      for (const f of frames) this.handle(f);
    });
    sock.on('error', (err) => console.log(`HORRY ESL socket error: ${String(err)}`));
    sock.on('close', () => {
      const wasReady = this.ready;
      this.ready = false;
      for (const p of this.pending.splice(0)) p.reject(new Error('esl disconnected'));
      this.jobs.clear();
      if (wasReady) {
        console.log('HORRY ESL disconnected');
        this.emit('disconnected');
      }
      if (!this.stopped) {
        setTimeout(() => this.connect(), this.backoffMs).unref();
        this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
      }
    });
  }

  private handle(f: EslFrame): void {
    switch (f.headers['Content-Type']) {
      case 'auth/request':
        void this.authenticate();
        return;
      case 'command/reply':
      case 'api/response':
        this.pending.shift()?.resolve(f);
        return;
      case 'text/event-json': {
        let ev: EslEvent;
        try {
          ev = JSON.parse(f.body) as EslEvent;
        } catch {
          return;
        }
        if (ev['Event-Name'] === 'BACKGROUND_JOB') {
          const id = ev['Job-UUID'] ?? '';
          const job = this.jobs.get(id);
          if (job) {
            this.jobs.delete(id);
            job(ev['_body'] ?? '');
          }
          return;
        }
        this.emit('event', ev);
        return;
      }
      default:
        return; // text/disconnect-notice, rude-rejection, …
    }
  }

  private async authenticate(): Promise<void> {
    try {
      const reply = await this.command(`auth ${this.opts.password}`);
      if (!(reply.headers['Reply-Text'] ?? '').startsWith('+OK')) {
        console.log(`HORRY ESL auth rejected: ${reply.headers['Reply-Text'] ?? ''}`);
        this.sock?.destroy();
        return;
      }
      await this.command(`event json ${this.opts.events.join(' ')}`);
      this.ready = true;
      console.log(`HORRY ESL connected ${this.opts.host}:${this.opts.port}`);
      this.emit('ready');
    } catch (err) {
      console.log(`HORRY ESL handshake failed: ${String(err)}`);
    }
  }

  private command(text: string): Promise<EslFrame> {
    return new Promise((resolve, reject) => {
      const sock = this.sock;
      if (!sock || sock.destroyed) {
        reject(new Error('esl not connected'));
        return;
      }
      this.pending.push({ resolve, reject });
      sock.write(`${text}\n\n`);
    });
  }

  /** Synchronous API command; resolves with freeSWITCH's text reply (`+OK …` / `-ERR …`). */
  async api(cmd: string): Promise<string> {
    if (!this.ready) throw new Error('esl not ready');
    const f = await this.command(`api ${cmd}`);
    return f.body.trim();
  }

  /** Background API command; resolves when its BACKGROUND_JOB event lands. */
  async bgapi(cmd: string, timeoutMs = 60_000): Promise<string> {
    if (!this.ready) throw new Error('esl not ready');
    const f = await this.command(`bgapi ${cmd}`);
    const jobId = f.headers['Job-UUID'];
    if (!jobId) throw new Error(`bgapi rejected: ${f.headers['Reply-Text'] ?? 'no Job-UUID'}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.jobs.delete(jobId);
        reject(new Error(`bgapi timeout: ${cmd.slice(0, 60)}`));
      }, timeoutMs);
      this.jobs.set(jobId, (body) => {
        clearTimeout(timer);
        resolve(body.trim());
      });
    });
  }
}
