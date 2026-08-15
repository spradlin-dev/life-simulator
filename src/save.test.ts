import { describe, expect, it } from 'vitest';
import { parseSave, serialize } from './save.ts';
import { FOUNDER } from './genes.ts';
import { FRESH_NEEDS } from './needs.ts';
import { FRESH_DISPOSITIONS, freshPlaces, PLACE_CELLS } from './dispositions.ts';

const someNeeds = { food: 0.4, rest: 0.8, fun: 0.6 };
const somePos = { x: 123, y: 456 };
const someDisp = { wariness: 0.3, attachment: 0.5 };
const somePlaces = (): number[] => {
  const s = freshPlaces();
  s[5] = -0.7;
  s[10] = 0.4;
  return s;
};

describe('save round-trip', () => {
  it('returns exactly what was stored', () => {
    const places = somePlaces();
    const json = serialize({
      genes: FOUNDER,
      trust: 0.73,
      needs: someNeeds,
      pos: somePos,
      disp: someDisp,
      places,
    });
    expect(parseSave(json)).toEqual({
      genes: FOUNDER,
      trust: 0.73,
      needs: someNeeds,
      pos: somePos,
      disp: someDisp,
      places,
    });
  });
});

describe('migrations keep the pip', () => {
  it('v1 fills fresh needs, unknown position, and a clean slate of memories', () => {
    const v1 = JSON.stringify({ v: 1, genes: FOUNDER, trust: 0.73 });
    expect(parseSave(v1)).toEqual({
      genes: FOUNDER,
      trust: 0.73,
      needs: FRESH_NEEDS,
      pos: null,
      disp: FRESH_DISPOSITIONS,
      places: freshPlaces(),
    });
  });

  it('v2 keeps needs and position, gains a clean slate of memories', () => {
    const v2 = JSON.stringify({ v: 2, genes: FOUNDER, trust: 0.73, needs: someNeeds, pos: somePos });
    expect(parseSave(v2)).toEqual({
      genes: FOUNDER,
      trust: 0.73,
      needs: someNeeds,
      pos: somePos,
      disp: FRESH_DISPOSITIONS,
      places: freshPlaces(),
    });
  });
});

describe('parseSave rejects broken saves', () => {
  it('garbage, wrong shapes, and unknown versions', () => {
    expect(parseSave('not json')).toBeNull();
    expect(parseSave('{}')).toBeNull();
    expect(parseSave('null')).toBeNull();
    expect(parseSave(JSON.stringify({ v: 4, genes: FOUNDER, trust: 0.5, needs: someNeeds, pos: somePos, disp: someDisp, places: freshPlaces() }))).toBeNull();
    expect(parseSave(JSON.stringify({ v: 2, genes: FOUNDER, trust: 0.5, pos: somePos }))).toBeNull();
    expect(parseSave(JSON.stringify({ v: 2, genes: FOUNDER, trust: 0.5, needs: { food: 1 }, pos: somePos }))).toBeNull();
    expect(parseSave(JSON.stringify({ v: 2, genes: FOUNDER, trust: 0.5, needs: someNeeds }))).toBeNull();
    expect(parseSave(JSON.stringify({ v: 3, genes: FOUNDER, trust: 0.5, needs: someNeeds, pos: somePos }))).toBeNull();
    expect(parseSave(JSON.stringify({ v: 3, genes: FOUNDER, trust: 0.5, needs: someNeeds, pos: somePos, disp: { wariness: 'high' }, places: freshPlaces() }))).toBeNull();
    expect(parseSave(JSON.stringify({ v: 3, genes: FOUNDER, trust: 0.5, needs: someNeeds, pos: somePos, disp: someDisp, places: freshPlaces().slice(1) }))).toBeNull();
    expect(parseSave(JSON.stringify({ v: 3, genes: FOUNDER, trust: 0.5, needs: someNeeds, pos: somePos, disp: someDisp, places: [...freshPlaces().slice(1), 'ow'] }))).toBeNull();
    expect(parseSave(JSON.stringify({ v: 1, trust: 0.5 }))).toBeNull();
    expect(parseSave(JSON.stringify({ v: 1, genes: { ...FOUNDER, boldness: 'high' }, trust: 0.5 }))).toBeNull();
    expect(parseSave(JSON.stringify({ v: 1, genes: FOUNDER, trust: 'lots' }))).toBeNull();
  });

  it('non-finite numbers that sneak past JSON', () => {
    const infinite = '{"v":1,"genes":{"boldness":1e999,"clinginess":0.5,"nosiness":0.5,"liveliness":0.5,"hue":159,"sat":53,"light":63},"trust":0.5}';
    expect(parseSave(infinite)).toBeNull();
  });
});

describe('parseSave clamps tampered values', () => {
  it('snaps out-of-range genes, trust, needs, and memories back into range', () => {
    const places = freshPlaces();
    places[0] = 9;
    places[1] = -9;
    const tampered = JSON.stringify({
      v: 3,
      genes: { ...FOUNDER, boldness: 9, hue: -30, sat: 200 },
      trust: 7,
      needs: { food: 5, rest: -2, fun: 0.5 },
      pos: somePos,
      disp: { wariness: 12, attachment: -4 },
      places,
    });
    const parsed = parseSave(tampered);
    expect(parsed).not.toBeNull();
    expect(parsed!.genes.boldness).toBe(1);
    expect(parsed!.genes.hue).toBe(330);
    expect(parsed!.genes.sat).toBe(85);
    expect(parsed!.trust).toBe(1);
    expect(parsed!.needs.food).toBe(1);
    expect(parsed!.needs.rest).toBe(0);
    expect(parsed!.disp.wariness).toBe(1);
    expect(parsed!.disp.attachment).toBe(0);
    expect(parsed!.places[0]).toBe(1);
    expect(parsed!.places[1]).toBe(-1);
  });

  it('holds the floors too', () => {
    const tampered = JSON.stringify({
      v: 3,
      genes: { ...FOUNDER, boldness: -5, sat: 10, light: 20 },
      trust: -3,
      needs: someNeeds,
      pos: somePos,
      disp: someDisp,
      places: freshPlaces(),
    });
    const parsed = parseSave(tampered);
    expect(parsed).not.toBeNull();
    expect(parsed!.genes.boldness).toBe(0);
    expect(parsed!.genes.sat).toBe(35);
    expect(parsed!.genes.light).toBe(48);
    expect(parsed!.trust).toBe(0);
  });
});

describe('place cell count contract', () => {
  it('rejects anything but the exact grid size', () => {
    const long = [...freshPlaces(), 0];
    expect(long).toHaveLength(PLACE_CELLS + 1);
    expect(parseSave(JSON.stringify({ v: 3, genes: FOUNDER, trust: 0.5, needs: someNeeds, pos: somePos, disp: someDisp, places: long }))).toBeNull();
  });
});
