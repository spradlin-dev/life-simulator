import { describe, expect, it } from 'vitest';
import { MAX_SAVED_PIPS, parseSave, serialize, type LivePip } from './save.ts';
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

function somePip(overrides: Partial<LivePip> = {}): LivePip {
  return {
    genes: FOUNDER,
    trust: 0.73,
    needs: someNeeds,
    pos: somePos,
    disp: someDisp,
    places: somePlaces(),
    generation: 3,
    ...overrides,
  };
}

describe('save round-trip', () => {
  it('returns exactly the roster that was stored', () => {
    const a = somePip();
    const b = somePip({
      genes: { ...FOUNDER, hue: 280 },
      trust: 0.2,
      pos: { x: 900, y: 40 },
      places: freshPlaces(),
      generation: 0,
    });
    expect(parseSave(serialize([a, b]))).toEqual({ pips: [a, b] });
  });
});

describe('migrations keep the pip', () => {
  it('v1 becomes a population of one with fresh needs, unknown position, and a clean slate', () => {
    const v1 = JSON.stringify({ v: 1, genes: FOUNDER, trust: 0.73 });
    expect(parseSave(v1)).toEqual({
      pips: [{
        genes: FOUNDER,
        trust: 0.73,
        needs: FRESH_NEEDS,
        pos: null,
        disp: FRESH_DISPOSITIONS,
        places: freshPlaces(),
        generation: 0,
      }],
    });
  });

  it('v2 keeps needs and position, gains a clean slate of memories', () => {
    const v2 = JSON.stringify({ v: 2, genes: FOUNDER, trust: 0.73, needs: someNeeds, pos: somePos });
    expect(parseSave(v2)).toEqual({
      pips: [{
        genes: FOUNDER,
        trust: 0.73,
        needs: someNeeds,
        pos: somePos,
        disp: FRESH_DISPOSITIONS,
        places: freshPlaces(),
        generation: 0,
      }],
    });
  });

  it('v3 keeps everything it had', () => {
    const places = somePlaces();
    const v3 = JSON.stringify({
      v: 3, genes: FOUNDER, trust: 0.73, needs: someNeeds, pos: somePos, disp: someDisp, places,
    });
    expect(parseSave(v3)).toEqual({
      pips: [{ genes: FOUNDER, trust: 0.73, needs: someNeeds, pos: somePos, disp: someDisp, places, generation: 0 }],
    });
  });

  it('v4 rosters gain generation zero', () => {
    const v4 = JSON.stringify({ v: 4, pips: [somePip(), somePip()] });
    const parsed = parseSave(v4);
    expect(parsed).not.toBeNull();
    expect(parsed!.pips.map((p) => p.generation)).toEqual([0, 0]);
  });
});

describe('parseSave rejects broken saves', () => {
  it('garbage, wrong shapes, and unknown versions', () => {
    expect(parseSave('not json')).toBeNull();
    expect(parseSave('{}')).toBeNull();
    expect(parseSave('null')).toBeNull();
    expect(parseSave(JSON.stringify({ v: 6, pips: [somePip()] }))).toBeNull();
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

  it('roster problems: missing, empty, oversized, or one bad entry', () => {
    expect(parseSave(JSON.stringify({ v: 4 }))).toBeNull();
    expect(parseSave(JSON.stringify({ v: 5 }))).toBeNull();
    expect(parseSave(JSON.stringify({ v: 4, pips: [] }))).toBeNull();
    const horde = Array.from({ length: MAX_SAVED_PIPS + 1 }, () => somePip());
    expect(parseSave(JSON.stringify({ v: 4, pips: horde }))).toBeNull();
    expect(parseSave(JSON.stringify({ v: 4, pips: Array.from({ length: MAX_SAVED_PIPS }, () => somePip()) }))).not.toBeNull();
    // the writer clamps, so a serialize round-trip survives any population
    const overgrown = parseSave(serialize(Array.from({ length: MAX_SAVED_PIPS + 3 }, () => somePip())));
    expect(overgrown).not.toBeNull();
    expect(overgrown!.pips).toHaveLength(MAX_SAVED_PIPS);
    // one rotten entry spoils the save — a partial roster would silently lose pips
    expect(parseSave(JSON.stringify({ v: 4, pips: [somePip(), { genes: FOUNDER, trust: 0.5 }] }))).toBeNull();
    // v4 entries carry positions always; a v4 pip without one is malformed, not migratable
    expect(parseSave(JSON.stringify({ v: 4, pips: [{ ...somePip(), pos: null }] }))).toBeNull();
  });

  it('v5 lineage problems: missing, wrong-typed, or non-finite generation', () => {
    expect(parseSave(JSON.stringify({ v: 5, pips: [{ ...somePip(), generation: undefined }] }))).toBeNull();
    expect(parseSave(JSON.stringify({ v: 5, pips: [{ ...somePip(), generation: 'seven' }] }))).toBeNull();
    expect(parseSave('{"v":5,"pips":[' + JSON.stringify(somePip()).replace('"generation":3', '"generation":1e999') + ']}')).toBeNull();
  });

  it('v5 tampered generations clamp and floor', () => {
    const low = parseSave(JSON.stringify({ v: 5, pips: [{ ...somePip(), generation: -5 }] }));
    expect(low!.pips[0].generation).toBe(0);
    const frac = parseSave(JSON.stringify({ v: 5, pips: [{ ...somePip(), generation: 6.9 }] }));
    expect(frac!.pips[0].generation).toBe(6);
    const vast = parseSave(JSON.stringify({ v: 5, pips: [{ ...somePip(), generation: 123456 }] }));
    expect(vast!.pips[0].generation).toBe(9999);
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
      v: 4,
      pips: [{
        genes: { ...FOUNDER, boldness: 9, hue: -30, sat: 200 },
        trust: 7,
        needs: { food: 5, rest: -2, fun: 0.5 },
        pos: somePos,
        disp: { wariness: 12, attachment: -4 },
        places,
      }],
    });
    const parsed = parseSave(tampered);
    expect(parsed).not.toBeNull();
    const pip = parsed!.pips[0];
    expect(pip.genes.boldness).toBe(1);
    expect(pip.genes.hue).toBe(330);
    expect(pip.genes.sat).toBe(85);
    expect(pip.trust).toBe(1);
    expect(pip.needs.food).toBe(1);
    expect(pip.needs.rest).toBe(0);
    expect(pip.disp.wariness).toBe(1);
    expect(pip.disp.attachment).toBe(0);
    expect(pip.places[0]).toBe(1);
    expect(pip.places[1]).toBe(-1);
  });

  it('holds the floors too', () => {
    const tampered = JSON.stringify({
      v: 4,
      pips: [{
        genes: { ...FOUNDER, boldness: -5, sat: 10, light: 20 },
        trust: -3,
        needs: someNeeds,
        pos: somePos,
        disp: someDisp,
        places: freshPlaces(),
      }],
    });
    const parsed = parseSave(tampered);
    expect(parsed).not.toBeNull();
    const pip = parsed!.pips[0];
    expect(pip.genes.boldness).toBe(0);
    expect(pip.genes.sat).toBe(35);
    expect(pip.genes.light).toBe(48);
    expect(pip.trust).toBe(0);
  });
});

describe('place cell count contract', () => {
  it('rejects anything but the exact grid size', () => {
    const long = [...freshPlaces(), 0];
    expect(long).toHaveLength(PLACE_CELLS + 1);
    expect(parseSave(JSON.stringify({ v: 3, genes: FOUNDER, trust: 0.5, needs: someNeeds, pos: somePos, disp: someDisp, places: long }))).toBeNull();
  });
});
