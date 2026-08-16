import { describe, expect, it } from 'vitest';
import { makeName, MAX_NAME_LENGTH, sanitizeName } from './names.ts';

describe('makeName', () => {
  it('always produces a short capitalized word of plain letters', () => {
    for (let i = 0; i < 200; i++) {
      const name = makeName();
      expect(name).toMatch(/^[A-Z][a-z]+$/);
      expect(name.length).toBeGreaterThanOrEqual(3);
      expect(name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    }
  });

  it('has variety', () => {
    const names = new Set(Array.from({ length: 50 }, () => makeName()));
    expect(names.size).toBeGreaterThan(5);
  });

  it('is deterministic under a fixed rand', () => {
    const fixed = (): number => 0.42;
    expect(makeName(fixed)).toBe(makeName(fixed));
  });
});

describe('sanitizeName', () => {
  it('keeps a good name as-is', () => {
    expect(sanitizeName('Bumble')).toBe('Bumble');
  });

  it('strips junk and clamps length', () => {
    expect(sanitizeName('Bu<script>mble!!')).toBe('Buscriptmble');
    expect(sanitizeName('a'.repeat(100))).toHaveLength(MAX_NAME_LENGTH);
  });

  it('replaces hopeless input with a fresh name', () => {
    expect(sanitizeName(42)).toMatch(/^[A-Z][a-z]+$/);
    expect(sanitizeName('!!!')).toMatch(/^[A-Z][a-z]+$/);
    expect(sanitizeName(null)).toMatch(/^[A-Z][a-z]+$/);
  });
});
