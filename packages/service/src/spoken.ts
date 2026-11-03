// Words for the voice agent. Text-to-speech reads "$174.99" badly, and even "194 dollars"
// came out as digits on the live test (Kristen 2026-11-03), so every amount that reaches
// Savannah — dynamic variables, her first message, tool results — is written out in full:
// "one hundred ninety-four dollars". Identifiers are spaced digits.

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0 … 999,999 in words ("one hundred ninety-four"). */
export function numberWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'zero';
  const under1000 = (x: number): string => {
    const parts: string[] = [];
    if (x >= 100) {
      parts.push(`${ONES[Math.floor(x / 100)]} hundred`);
      x %= 100;
    }
    if (x >= 20) parts.push(TENS[Math.floor(x / 10)] + (x % 10 ? `-${ONES[x % 10]}` : ''));
    else if (x > 0) parts.push(ONES[x]);
    return parts.join(' ');
  };
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  return [thousands ? `${under1000(thousands)} thousand` : '', rest ? under1000(rest) : ''].filter(Boolean).join(' ');
}

export function spokenMoney(n: number | null | undefined): string {
  const v = Math.round((n ?? 0) * 100) / 100;
  const dollars = Math.floor(Math.abs(v));
  const cents = Math.round((Math.abs(v) - dollars) * 100);
  const d = `${numberWords(dollars)} dollar${dollars === 1 ? '' : 's'}`;
  if (cents === 0) return d;
  const c = `${numberWords(cents)} cent${cents === 1 ? '' : 's'}`;
  if (dollars === 0) return c;
  return `${d} and ${c}`;
}

/** "482913" → "4 8 2 9 1 3": one digit at a time. */
export const spokenDigits = (s: string | number | null | undefined): string => String(s ?? '').replace(/\D/g, '').split('').join(' ');
