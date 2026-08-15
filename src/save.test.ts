import { describe, expect, it } from 'vitest';
import { parseSave, serialize } from './save.ts';
import { FOUNDER } from './genes.ts';

describe('save round-trip', () => {
  it('returns exactly what was stored', () => {
    const json = serialize(FOUNDER, 0.73);
    expect(parseSave(json)).toEqual({ genes: FOUNDER, trust: 0.73 });
  });
});

describe('parseSave rejects broken saves', () => {
  it('garbage, wrong shapes, and unknown versions', () => {
    expect(parseSave('not json')).toBeNull();
    expect(parseSave('{}')).toBeNull();
    expect(parseSave('null')).toBeNull();
    expect(parseSave(JSON.stringify({ v: 2, genes: FOUNDER, trust: 0.5 }))).toBeNull();
    expect(parseSave(JSON.stringify({ v: 1, trust: 0.5 }))).toBeNull();
    expect(parseSave(JSON.stringify({ v: 1, genes: { ...FOUNDER, boldness: 'high' }, trust: 0.5 }))).toBeNull();
    expect(parseSave(JSON.stringify({ v: 1, genes: { ...FOUNDER, hue: null }, trust: 0.5 }))).toBeNull();
    expect(parseSave(JSON.stringify({ v: 1, genes: FOUNDER, trust: 'lots' }))).toBeNull();
  });

  it('non-finite numbers that sneak past JSON', () => {
    const infinite = '{"v":1,"genes":{"boldness":1e999,"clinginess":0.5,"nosiness":0.5,"liveliness":0.5,"hue":159,"sat":53,"light":63},"trust":0.5}';
    expect(parseSave(infinite)).toBeNull();
  });
});

describe('parseSave clamps tampered values', () => {
  it('snaps out-of-range genes and trust back into range', () => {
    const tampered = JSON.stringify({
      v: 1,
      genes: { ...FOUNDER, boldness: 9, hue: -30, sat: 200 },
      trust: 7,
    });
    const parsed = parseSave(tampered);
    expect(parsed).not.toBeNull();
    expect(parsed!.genes.boldness).toBe(1);
    expect(parsed!.genes.hue).toBe(330);
    expect(parsed!.genes.sat).toBe(85);
    expect(parsed!.trust).toBe(1);
  });

  it('holds the floors too', () => {
    const tampered = JSON.stringify({
      v: 1,
      genes: { ...FOUNDER, boldness: -5, sat: 10, light: 20 },
      trust: -3,
    });
    const parsed = parseSave(tampered);
    expect(parsed).not.toBeNull();
    expect(parsed!.genes.boldness).toBe(0);
    expect(parsed!.genes.sat).toBe(35);
    expect(parsed!.genes.light).toBe(48);
    expect(parsed!.trust).toBe(0);
  });
});
