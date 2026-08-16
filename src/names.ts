// tiny soft names, assigned at birth — the recognition anchor that turns
// "pip 7" into somebody

const OPENERS = ['b', 'p', 'm', 't', 'n', 'k', 'd', 'w', 'f', 'pl', 'br', 'fl', 'sn', 'kw'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'oo', 'ee', 'ai'];
const MIDDLES = ['b', 'p', 'm', 'n', 'k', 'd', 'l', 'r', 'z', 'v', 'nn', 'mm', 'bb'];
const ENDERS = ['', '', 'n', 'p', 'sh', 'bit', 'kin', 'pip', 'let'];

const pick = <T>(list: readonly T[], rand: () => number): T =>
  list[Math.min(list.length - 1, Math.floor(rand() * list.length))];

export const MAX_NAME_LENGTH = 24;

export function makeName(rand: () => number = Math.random): string {
  const raw =
    pick(OPENERS, rand) + pick(VOWELS, rand) + pick(MIDDLES, rand) + pick(VOWELS, rand) + pick(ENDERS, rand);
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// names are cosmetic, so a broken one is replaced rather than costing the pip:
// trims, strips anything but letters, clamps length, regenerates if nothing is left
export function sanitizeName(raw: unknown, rand: () => number = Math.random): string {
  if (typeof raw !== 'string') return makeName(rand);
  const cleaned = raw.replace(/[^a-zA-Z]/g, '').slice(0, MAX_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : makeName(rand);
}
