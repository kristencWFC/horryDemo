// Debounced JSON snapshot persistence (tmp+rename per house conventions).
// Deliberate divergence from the donor repos' SQLite: zero native deps means
// `npm ci` needs no toolchain anywhere. Demo state is small and ephemeral.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class JsonStore<T> {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly debounceMs = 500
  ) {}

  load(): T | undefined {
    try {
      if (!existsSync(this.file)) return undefined;
      return JSON.parse(readFileSync(this.file, 'utf8')) as T;
    } catch (err) {
      console.warn(`HORRY: could not load ${this.file}: ${String(err)}`);
      return undefined;
    }
  }

  save(data: T): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(data, null, 2));
        renameSync(tmp, this.file);
      } catch (err) {
        console.warn(`HORRY: could not save ${this.file}: ${String(err)}`);
      }
    }, this.debounceMs);
    this.timer.unref();
  }

  flushPath(): string {
    return this.file;
  }
}

export function dataPath(dataDir: string, file: string): string {
  return join(dataDir, file);
}
