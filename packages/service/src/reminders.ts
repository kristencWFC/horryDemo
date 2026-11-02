// Payment reminders (demo use case 3, Kristen 2026-11-02): the supervisor uploads a list of
// past-due accounts and Savannah calls each member (outbound through the Twilio number
// attached to her) or a secure pay link goes out by text. Every reminder also lands on
// Customer Review as an outbound call or a text with its outcome.
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { JsonStore } from './store.js';
import { last10 } from './env.js';

export type ReminderStatus = 'queued' | 'calling' | 'sent' | 'paid' | 'promised' | 'no_answer' | 'completed' | 'declined' | 'failed';

export interface ReminderRow {
  id: string;
  account: string;
  name: string;
  phone: string;
  amount: number;
  dueDate: string;
  memberSep?: string;
  status: ReminderStatus;
  /** One line for the list: "Paid $194.00 on Visa 4242", "No answer", "Promised to pay by Friday"… */
  outcome?: string;
  callGuid: string;
  conversationId?: string;
  paymentId?: string;
  updatedAt: string;
}

export interface ReminderBatch {
  id: string;
  createdAt: string;
  by: string;
  channel: 'voice' | 'sms';
  rows: ReminderRow[];
  done: boolean;
}

export class ReminderStore extends EventEmitter {
  private rows: ReminderBatch[];
  private store: JsonStore<ReminderBatch[]>;

  constructor(dataDir: string) {
    super();
    this.store = new JsonStore<ReminderBatch[]>(join(dataDir, 'reminders.json'));
    this.rows = this.store.load() ?? [];
    // A batch mid-flight when the service restarted is over.
    for (const b of this.rows) if (!b.done) { for (const r of b.rows) if (r.status === 'queued' || r.status === 'calling') r.status = 'failed'; b.done = true; }
  }

  private save(): void {
    if (this.rows.length > 50) this.rows = this.rows.slice(-50);
    this.store.save(this.rows);
    this.emit('change');
  }

  reset(): void {
    this.rows = [];
    this.save();
  }

  all(): ReminderBatch[] {
    return [...this.rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): ReminderBatch | undefined {
    return this.rows.find((b) => b.id === id);
  }

  create(p: { by: string; channel: 'voice' | 'sms'; rows: Omit<ReminderRow, 'id' | 'status' | 'callGuid' | 'updatedAt'>[] }): ReminderBatch {
    const id = `rb-${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const b: ReminderBatch = {
      id,
      createdAt: now,
      by: p.by,
      channel: p.channel,
      done: false,
      rows: p.rows.map((r, i) => ({ ...r, phone: last10(r.phone), id: `${id}-${i + 1}`, callGuid: `rem-${id}-${i + 1}`, status: 'queued', updatedAt: now })),
    };
    this.rows.push(b);
    this.save();
    return b;
  }

  patchRow(row: ReminderRow, p: Partial<ReminderRow>): void {
    Object.assign(row, p, { updatedAt: new Date().toISOString() });
    this.save();
  }

  finish(b: ReminderBatch): void {
    b.done = true;
    this.save();
  }

  /** The reminder behind a call row (outbound call guid) — how the post-call webhook finds it. */
  byCallGuid(guid: string): { batch: ReminderBatch; row: ReminderRow } | undefined {
    for (const batch of this.rows) {
      const row = batch.rows.find((r) => r.callGuid === guid);
      if (row) return { batch, row };
    }
    return undefined;
  }

  /** The reminder call in progress to this number (Savannah's initiation webhook sees only the numbers). */
  callingTo(phone: string): { batch: ReminderBatch; row: ReminderRow } | undefined {
    const p = last10(phone);
    for (const batch of this.all()) {
      const row = batch.rows.find((r) => r.phone === p && r.status === 'calling');
      if (row) return { batch, row };
    }
    return undefined;
  }
}

/** Parse the uploaded list: a header row with account / name / phone / amount / due (any order, any case). */
export function parseReminderCsv(text: string): { rows: Omit<ReminderRow, 'id' | 'status' | 'callGuid' | 'updatedAt'>[]; errors: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errors: string[] = [];
  if (lines.length < 2) return { rows: [], errors: ['The file needs a header row and at least one account.'] };
  const split = (l: string) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim()).filter((_, i, a) => i < a.length - 1 || _ !== '');
  const head = split(lines[0]!).map((h) => h.toLowerCase());
  // First name that matches wins, so "due date" is found before "amount past due" ("due") is.
  const col = (...names: string[]) => {
    for (const n of names) {
      const i = head.findIndex((h) => h.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };
  const ci = { account: col('account', 'member', 'sep'), name: col('name'), phone: col('phone', 'cell', 'mobile'), amount: col('amount', 'past due', 'balance', 'due amount'), due: col('due date', 'due') };
  if (ci.phone < 0 || ci.amount < 0) return { rows: [], errors: ['The header row needs at least a phone column and an amount column.'] };
  const rows = [] as ReturnType<typeof parseReminderCsv>['rows'];
  lines.slice(1).forEach((l, i) => {
    const c = split(l);
    const phone = last10(c[ci.phone] ?? '');
    const amount = Math.round(Number(String(c[ci.amount] ?? '').replace(/[$,\s]/g, '')) * 100) / 100;
    if (phone.length !== 10) return errors.push(`Row ${i + 2}: no 10-digit phone number.`);
    if (!(amount > 0)) return errors.push(`Row ${i + 2}: no amount.`);
    rows.push({ account: ci.account >= 0 ? c[ci.account] ?? '' : '', name: ci.name >= 0 ? c[ci.name] ?? '' : '', phone, amount, dueDate: ci.due >= 0 ? c[ci.due] ?? '' : '' });
  });
  return { rows, errors };
}
