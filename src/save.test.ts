import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSave,
  loadSave,
  MAX_SAVED_PIPS,
  parseSave,
  SAVE_KEYS,
  serialize,
  storeSave,
  type LivePip,
} from './save.ts';
import { dietOf, FOUNDER } from './genes.ts';
import { DECODER_VERSION, FOUNDER_STRAND } from './dna.ts';
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
    strand: FOUNDER_STRAND,
    trust: 0.73,
    needs: someNeeds,
    pos: somePos,
    disp: someDisp,
    places: somePlaces(),
    generation: 3,
    name: 'Tester',
    age: 777,
    ...overrides,
  };
}

// a v7 entry: everything a modern pip has except the strand
function v7Pip(): Omit<LivePip, 'strand'> {
  const { strand: _s, ...rest } = somePip();
  return rest;
}

// a genome as saves wrote it before the visual traits existed
const OLD_GENES = {
  boldness: 0.5, clinginess: 0.5, nosiness: 0.5, liveliness: 0.5,
  hue: 159, sat: 53, light: 63,
};
const NAME_SHAPE = /^[A-Za-z]+$/;

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

  it('stamps the current version and decoder on every save it writes', () => {
    const written = JSON.parse(serialize([somePip()]));
    expect(written.v).toBe(11);
    expect(written.decoder).toBe(DECODER_VERSION);
    expect('lock' in written).toBe(false);
  });

  it('age survives the round-trip exactly, and mangled ages scatter into midlife', () => {
    expect(parseSave(serialize([somePip({ age: 2500.5 })]))!.pips[0].age).toBe(2500.5);
    const negative = parseSave(JSON.stringify({ v: 11, decoder: DECODER_VERSION, pips: [somePip({ age: -40 })] }));
    expect(negative!.pips[0].age).toBeGreaterThanOrEqual(0);
    expect(negative!.pips[0].age).toBeLessThanOrEqual(1440);
  });

  it('pre-age saves scatter every pip into midlife, never a synchronized wave', () => {
    const { age: _a, ...aged } = somePip();
    const parsed = parseSave(JSON.stringify({ v: 10, decoder: DECODER_VERSION, pips: [aged, aged, aged] }));
    for (const pip of parsed!.pips) {
      expect(pip.age).toBeGreaterThanOrEqual(0);
      expect(pip.age).toBeLessThanOrEqual(1440);
    }
  });

  it('age is a v11 field: a pre-v11 save that somehow carries one still scatters', () => {
    const parsed = parseSave(JSON.stringify({ v: 10, decoder: DECODER_VERSION, pips: [somePip({ age: 999 })] }));
    expect(parsed!.pips[0].age).not.toBe(999);
    expect(parsed!.pips[0].age).toBeLessThanOrEqual(1440);
  });
});

// the two-world firewall: the meadow and the terrarium each sleep in their
// own slot, and neither can ever see or erase the other's
describe('two worlds, two slots', () => {
  const slots = new Map<string, string>();
  const fakeStorage = {
    getItem: (k: string) => slots.get(k) ?? null,
    setItem: (k: string, v: string) => void slots.set(k, v),
    removeItem: (k: string) => void slots.delete(k),
  };

  afterEach(() => {
    slots.clear();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('a stored meadow is invisible to the terrarium, and vice versa', () => {
    (globalThis as { localStorage?: unknown }).localStorage = fakeStorage;
    storeSave([somePip()], SAVE_KEYS.meadow);
    expect(loadSave(SAVE_KEYS.terrarium)).toBeNull();
    const meadow = loadSave(SAVE_KEYS.meadow);
    expect(meadow!.pips).toHaveLength(1);
    expect(meadow!.pips[0].name).toBe('Tester');
  });

  it('clearing one world never touches the other', () => {
    (globalThis as { localStorage?: unknown }).localStorage = fakeStorage;
    storeSave([somePip()], SAVE_KEYS.meadow);
    storeSave([somePip({ name: 'Labby' })], SAVE_KEYS.terrarium);
    clearSave(SAVE_KEYS.terrarium);
    expect(loadSave(SAVE_KEYS.terrarium)).toBeNull();
    expect(loadSave(SAVE_KEYS.meadow)!.pips[0].name).toBe('Tester');
    clearSave(SAVE_KEYS.meadow);
    expect(loadSave(SAVE_KEYS.meadow)).toBeNull();
  });
});

describe('migrations keep the pip', () => {
  it('v1 becomes a population of one with fresh needs, unknown position, and a clean slate', () => {
    const v1 = JSON.stringify({ v: 1, genes: OLD_GENES, trust: 0.73 });
    const parsed = parseSave(v1);
    expect(parsed).not.toBeNull();
    expect(parsed!.pips).toHaveLength(1);
    expect(parsed!.pips[0]).toMatchObject({
      genes: FOUNDER,
      trust: 0.73,
      needs: FRESH_NEEDS,
      pos: null,
      disp: FRESH_DISPOSITIONS,
      places: freshPlaces(),
      generation: 0,
    });
    expect(parsed!.pips[0].name).toMatch(NAME_SHAPE);
  });

  it('v2 keeps needs and position, gains a clean slate of memories', () => {
    const v2 = JSON.stringify({ v: 2, genes: OLD_GENES, trust: 0.73, needs: someNeeds, pos: somePos });
    const parsed = parseSave(v2);
    expect(parsed).not.toBeNull();
    expect(parsed!.pips[0]).toMatchObject({
      genes: FOUNDER,
      trust: 0.73,
      needs: someNeeds,
      pos: somePos,
      disp: FRESH_DISPOSITIONS,
      places: freshPlaces(),
      generation: 0,
    });
    expect(parsed!.pips[0].name).toMatch(NAME_SHAPE);
  });

  it('v3 keeps everything it had', () => {
    const places = somePlaces();
    const v3 = JSON.stringify({
      v: 3, genes: OLD_GENES, trust: 0.73, needs: someNeeds, pos: somePos, disp: someDisp, places,
    });
    const parsed = parseSave(v3);
    expect(parsed).not.toBeNull();
    expect(parsed!.pips[0]).toMatchObject({
      genes: FOUNDER, trust: 0.73, needs: someNeeds, pos: somePos, disp: someDisp, places, generation: 0,
    });
    expect(parsed!.pips[0].name).toMatch(NAME_SHAPE);
  });

  it('v4 rosters gain generation zero', () => {
    const v4 = JSON.stringify({ v: 4, pips: [somePip(), somePip()] });
    const parsed = parseSave(v4);
    expect(parsed).not.toBeNull();
    expect(parsed!.pips.map((p) => p.generation)).toEqual([0, 0]);
    expect(parsed!.pips.map((p) => p.name).every((n) => NAME_SHAPE.test(n))).toBe(true);
  });

  it('pre-visual genomes come back looking exactly like themselves', () => {
    const v5 = JSON.stringify({ v: 5, pips: [{ ...somePip(), genes: OLD_GENES }] });
    const parsed = parseSave(v5);
    expect(parsed).not.toBeNull();
    expect(parsed!.pips[0].genes).toEqual(FOUNDER);
  });

  it('v7 keeps names, salvages mangled ones, and fills genes it predates', () => {
    const kept = parseSave(JSON.stringify({ v: 7, pips: [v7Pip()] }));
    expect(kept!.pips[0].name).toBe('Tester');
    const mangled = parseSave(JSON.stringify({ v: 7, pips: [{ ...v7Pip(), name: 1234 }] }));
    expect(mangled!.pips[0].name).toMatch(NAME_SHAPE);
    // a save can never carry genes added after it was written, so missing
    // fields fill at the classic midpoint instead of costing the pip its life
    const sparse = parseSave(JSON.stringify({ v: 7, pips: [{ ...v7Pip(), genes: OLD_GENES }] }));
    expect(sparse!.pips[0].genes).toEqual({ ...FOUNDER, hue: 159, sat: 53, light: 63 });
  });

  it('v6 genomes gain the tempo genes at their midpoints, names intact', () => {
    const preTempo = { ...FOUNDER } as Record<string, number>;
    delete preTempo.metabolism;
    delete preTempo.stamina;
    delete preTempo.playfulness;
    const parsed = parseSave(JSON.stringify({ v: 6, pips: [{ ...somePip(), genes: preTempo }] }));
    expect(parsed).not.toBeNull();
    expect(parsed!.pips[0].genes).toEqual(FOUNDER);
    expect(parsed!.pips[0].name).toBe('Tester');
  });
});

describe('parseSave rejects broken saves', () => {
  it('garbage, wrong shapes, and unknown versions', () => {
    expect(parseSave('not json')).toBeNull();
    expect(parseSave('{}')).toBeNull();
    expect(parseSave('null')).toBeNull();
    expect(parseSave(JSON.stringify({ v: 12, pips: [somePip()] }))).toBeNull();
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

describe('the genome rides the save', () => {
  const DECODER = DECODER_VERSION;

  it('a healthy same-decoder strand is kept verbatim, junk DNA and all', () => {
    const grown = FOUNDER_STRAND + 'AAAA';
    const parsed = parseSave(JSON.stringify({ v: 9, decoder: DECODER, pips: [somePip({ strand: grown })] }));
    expect(parsed!.pips[0].strand).toBe(grown);
  });

  it('v7 pips grow a strand spelled from their stats, stats untouched', () => {
    const parsed = parseSave(JSON.stringify({ v: 7, pips: [v7Pip()] }));
    expect(parsed).not.toBeNull();
    expect(parsed!.pips[0].genes).toEqual(FOUNDER);
    expect(parsed!.pips[0].strand).toBe(FOUNDER_STRAND);
  });

  it('rollback insurance: stats alone reconstruct a working pip', () => {
    const parsed = parseSave(JSON.stringify({ v: 9, decoder: DECODER, pips: [v7Pip()] }));
    expect(parsed).not.toBeNull();
    expect(parsed!.pips[0].genes).toEqual(FOUNDER);
    expect(parsed!.pips[0].strand).toBe(FOUNDER_STRAND);
  });

  it('a mangled strand is respelled from the stats, never fatal', () => {
    for (const bad of ['ACGU'.repeat(30), 'ACGT', 42, null]) {
      const parsed = parseSave(JSON.stringify({ v: 9, decoder: DECODER, pips: [somePip({ strand: bad as unknown as string })] }));
      expect(parsed).not.toBeNull();
      expect(parsed!.pips[0].strand).toBe(FOUNDER_STRAND);
      expect(parsed!.pips[0].genes).toEqual(FOUNDER);
    }
  });

  it('a foreign decoder version respells every strand from the stats', () => {
    const grown = FOUNDER_STRAND + 'AAAA';
    const parsed = parseSave(JSON.stringify({ v: 9, decoder: 999, pips: [somePip({ strand: grown })] }));
    expect(parsed).not.toBeNull();
    expect(parsed!.pips[0].strand).toBe(FOUNDER_STRAND);
    expect(parsed!.pips[0].genes).toEqual(FOUNDER);
  });

  it('the retired feeder lock is ignored wherever an old save carries it', () => {
    const on = parseSave(JSON.stringify({ v: 9, decoder: DECODER, lock: true, pips: [somePip()] }));
    expect(on).not.toBeNull();
    expect('lock' in on!).toBe(false);
    expect(on!.pips).toHaveLength(1);
  });

  it('a pre-diet save fills the new gene at its midpoint: no pip is lost to a new trait', () => {
    const { diet: _d, ...oldGenes } = FOUNDER;
    const entry = { ...somePip(), genes: oldGenes };
    // decoder 2 is what every real v9 save carries, so the strand respells too
    const parsed = parseSave(JSON.stringify({ v: 9, decoder: 2, pips: [entry] }));
    expect(parsed).not.toBeNull();
    expect(parsed!.pips[0].genes).toEqual(FOUNDER);
    expect(dietOf(parsed!.pips[0].genes)).toBe('red');
  });
});
