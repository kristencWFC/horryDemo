// The demo's UPN member records — the data behind the mock NextGen CIS API
// (nextgen-mock.ts). Seeds are committed; payments, notes and extensions made during
// a demo persist to data/members.json (gitignored) so a restart keeps the story.
// Delete data/members.json to reset.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonStore } from './store.js';
import { last10 } from './env.js';

export interface Member {
  MemberSep: string;
  Name: string;
  FirstName: string;
  ServAddr: string;
  City: string;
  Zip: string;
  CellPhone: string | null;
  Telephone: string | null;
  EmailAddr: string | null;
  AcctStatus: string;
  Rate: string;
  Meter: string;
  Location: string;
  SubStation: number;
  Circuit: number;
  PrioritySvc: number;
  CurrentBalance: number;
  AmountDue: number;
  PastDueAmount: number;
  DueDate: string;
  CutOffDate: string | null;
  LastPayment: number;
  PaymentDate: string;
  BillDate: string;
  OnCutOffList: boolean;
  AllowArrangementFlag: boolean;
  CardProfileExists: boolean;
  Last4CcDigits: string | null;
  CardBrand: string | null;
  BankDraft: boolean;
  LevelizedBillAmount: number;
  Paperless: boolean;
  KwhLast30: number;
  KwhPriorMonth: number;
  KwhSameMonthLastYear: number;
  Notes?: { at: string; type: string; text: string }[];
  Extensions?: { confirmation: string; payBy: string; at: string }[];
}

type Overlay = Record<string, Partial<Member>>;

export class MemberStore {
  private members = new Map<string, Member>();
  private overlay: Overlay;
  private store: JsonStore<Overlay>;

  constructor(dataDir: string) {
    const seed = JSON.parse(readFileSync(join(dataDir, 'members.seed.json'), 'utf8')) as { members: Member[] };
    this.store = new JsonStore<Overlay>(join(dataDir, 'members.json'));
    this.overlay = this.store.load() ?? {};
    for (const m of seed.members) this.members.set(m.MemberSep, { ...m, ...(this.overlay[m.MemberSep] ?? {}) });
  }

  all(): Member[] {
    return [...this.members.values()];
  }

  bySep(sep: string): Member | undefined {
    const digits = String(sep).replace(/\D/g, '');
    return this.members.get(digits.padStart(11, '0'));
  }

  byPhone(phone: string): Member[] {
    const p = last10(phone);
    if (p.length !== 10) return [];
    return this.all().filter((m) => [m.CellPhone, m.Telephone].some((x) => last10(x) === p));
  }

  byEmail(email: string): Member[] {
    const e = email.trim().toLowerCase();
    return this.all().filter((m) => (m.EmailAddr ?? '').toLowerCase() === e);
  }

  /** Spoken addresses are messy ("1420 Cultra Road") — match on house number + first street word. */
  byAddress(spoken: string): Member[] {
    const norm = (s: string) =>
      s
        .toUpperCase()
        .replace(/\bROAD\b/g, 'RD')
        .replace(/\bHIGHWAY\b/g, 'HWY')
        .replace(/\bBUSINESS\b/g, 'BUS')
        .replace(/[^A-Z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const q = norm(spoken);
    const num = q.match(/^\d+/)?.[0];
    const words = q.replace(/^\d+\s*/, '').split(' ').filter((w) => w.length > 1);
    return this.all().filter((m) => {
      const a = norm(m.ServAddr);
      if (num && !a.startsWith(num + ' ')) return false;
      return words.length === 0 || a.includes(words[0]!);
    });
  }

  patch(sep: string, p: Partial<Member>): Member | undefined {
    const m = this.bySep(sep);
    if (!m) return undefined;
    Object.assign(m, p);
    this.overlay[m.MemberSep] = { ...(this.overlay[m.MemberSep] ?? {}), ...p };
    this.store.save(this.overlay);
    return m;
  }

  applyPayment(sep: string, amount: number, date: string): Member | undefined {
    const m = this.bySep(sep);
    if (!m) return undefined;
    const round = (n: number) => Math.round(n * 100) / 100;
    const pastDue = round(Math.max(0, m.PastDueAmount - amount));
    const due = round(Math.max(0, m.AmountDue - amount));
    return this.patch(sep, {
      AmountDue: due,
      CurrentBalance: round(Math.max(0, m.CurrentBalance - Math.max(0, amount - m.PastDueAmount))),
      PastDueAmount: pastDue,
      OnCutOffList: m.OnCutOffList && pastDue > 0,
      CutOffDate: pastDue > 0 ? m.CutOffDate : null,
      LastPayment: amount,
      PaymentDate: date,
    });
  }

  addNote(sep: string, type: string, text: string): void {
    const m = this.bySep(sep);
    if (!m) return;
    this.patch(sep, { Notes: [...(m.Notes ?? []), { at: new Date().toISOString(), type, text }] });
  }

  reset(): void {
    this.overlay = {};
    this.store.save(this.overlay);
  }
}

/** "HARDEE LINDA" → "Linda Hardee" */
export function displayName(m: Member): string {
  const [last, ...rest] = m.Name.trim().split(/\s+/);
  const cap = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
  return [...rest.map(cap), cap(last ?? '')].join(' ').trim();
}

export function displayAddress(m: Member): string {
  const cap = (s: string) => s.replace(/\b([A-Z])([A-Z]*)\b/g, (_, a: string, b: string) => a + b.toLowerCase());
  return `${cap(m.ServAddr).replace(/\bRd\b/, 'Road').replace(/\bHwy\b/, 'Highway')}, ${cap(m.City)}`;
}
