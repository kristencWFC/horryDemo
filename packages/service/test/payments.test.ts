// A card read to Savannah by voice: what the demo gateway accepts and refuses.
import { describe, expect, it } from 'vitest';
import { cardBrandOf, luhnOk, spokenCardProblem } from '../src/payments.js';

const good = { number: '4242424242424242', expMonth: 12, expYear: 2028, cvc: '123', zip: '29526' };

describe('spoken card checks', () => {
  it('accepts the Visa test card', () => {
    expect(luhnOk(good.number)).toBe(true);
    expect(cardBrandOf(good.number)).toBe('Visa');
    expect(spokenCardProblem(good, new Date('2026-11-03'))).toBe('');
  });
  it('names the item to ask again', () => {
    expect(spokenCardProblem({ ...good, number: '4242424242424241' }, new Date('2026-11-03'))).toBe('card_number_invalid');
    expect(spokenCardProblem({ ...good, expMonth: 13 }, new Date('2026-11-03'))).toBe('expiration_invalid');
    expect(spokenCardProblem({ ...good, expYear: 2025 }, new Date('2026-11-03'))).toBe('card_expired');
    expect(spokenCardProblem({ ...good, expMonth: 10, expYear: 2026 }, new Date('2026-11-03'))).toBe('card_expired');
    expect(spokenCardProblem({ ...good, cvc: '12' }, new Date('2026-11-03'))).toBe('security_code_invalid');
    expect(spokenCardProblem({ ...good, zip: '2952' }, new Date('2026-11-03'))).toBe('zip_invalid');
  });
  it('takes a two-digit year and spoken digits with spaces', () => {
    expect(spokenCardProblem({ ...good, number: '4242 4242 4242 4242', expYear: 28 }, new Date('2026-11-03'))).toBe('');
    expect(cardBrandOf('5555555555554444')).toBe('Mastercard');
    expect(cardBrandOf('378282246310005')).toBe('American Express');
  });
});
