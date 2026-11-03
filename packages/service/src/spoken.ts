// Words for the voice agent. Text-to-speech reads "$174.99" badly ("one seventy-four point
// nine nine dollars" on the first hand-off test, Kristen 2026-11-03), so every amount that
// reaches Savannah — dynamic variables, her first message, tool results — is written the way
// a person says it: "174 dollars and 99 cents". Identifiers are spaced digits.

export function spokenMoney(n: number | null | undefined): string {
  const v = Math.round((n ?? 0) * 100) / 100;
  const dollars = Math.floor(Math.abs(v));
  const cents = Math.round((Math.abs(v) - dollars) * 100);
  const d = `${dollars.toLocaleString('en-US')} dollar${dollars === 1 ? '' : 's'}`;
  if (cents === 0) return d;
  if (dollars === 0) return `${cents} cent${cents === 1 ? '' : 's'}`;
  return `${d} and ${cents} cent${cents === 1 ? '' : 's'}`;
}

/** "482913" → "4 8 2 9 1 3": one digit at a time. */
export const spokenDigits = (s: string | number | null | undefined): string => String(s ?? '').replace(/\D/g, '').split('').join(' ');
