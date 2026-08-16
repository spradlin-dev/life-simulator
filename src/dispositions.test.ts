import { describe, expect, it } from 'vitest';
import {
  effectiveGenes,
  fadePlaces,
  freshPlaces,
  FRESH_DISPOSITIONS,
  isHealing,
  learn,
  markPlace,
  PLACE_CELLS,
  placeAt,
  type Dispositions,
} from './dispositions.ts';
import { FOUNDER } from './genes.ts';

function live(disp: Dispositions, fear: number, happiness: number, seconds: number): Dispositions {
  let out = disp;
  for (let elapsed = 0; elapsed < seconds; elapsed += 0.1) out = learn(out, fear, happiness, 0.1);
  return out;
}

describe('learn', () => {
  it('terror etches wariness far faster than good times heal it', () => {
    const afterTerror = live(FRESH_DISPOSITIONS, 0.9, 0, 10);
    expect(afterTerror.wariness).toBeGreaterThan(0.05);
    const afterHealing = live(afterTerror, 0, 0.9, 10);
    const healed = afterTerror.wariness - afterHealing.wariness;
    const etched = afterTerror.wariness;
    expect(healed).toBeGreaterThan(0);
    expect(healed).toBeLessThan(etched / 5);
  });

  it('nothing moves in unhappy calm', () => {
    const shaped: Dispositions = { wariness: 0.4, attachment: 0.4 };
    const later = live(shaped, 0, 0.3, 60);
    expect(later.wariness).toBe(shaped.wariness);
    expect(later.attachment).toBe(shaped.attachment);
  });

  it('a merely-okay life reshapes nothing either', () => {
    const shaped: Dispositions = { wariness: 0.4, attachment: 0.4 };
    const later = live(shaped, 0, 0.69, 60);
    expect(later).toEqual(shaped);
  });

  it('devotion builds over happy time and terror damages it', () => {
    const devoted = live(FRESH_DISPOSITIONS, 0, 0.9, 300);
    expect(devoted.attachment).toBeGreaterThan(0.3);
    const betrayed = live(devoted, 0.9, 0, 10);
    expect(betrayed.attachment).toBeLessThan(devoted.attachment);
  });

  it('a moderate scare frightens without betraying', () => {
    const devoted: Dispositions = { wariness: 0, attachment: 0.5 };
    const scared = live(devoted, 0.7, 0, 10);
    expect(scared.wariness).toBeGreaterThan(0);
    expect(scared.attachment).toBe(devoted.attachment);
  });

  it('stays clamped to [0, 1]', () => {
    const extreme = live(FRESH_DISPOSITIONS, 1, 0, 3600);
    expect(extreme.wariness).toBeLessThanOrEqual(1);
    expect(extreme.attachment).toBeGreaterThanOrEqual(0);
  });
});

describe('isHealing', () => {
  it('is visible exactly when good times meet a visibly wary pip', () => {
    expect(isHealing({ wariness: 0.5, attachment: 0 }, 0.8)).toBe(true);
    expect(isHealing({ wariness: 0.5, attachment: 0 }, 0.6)).toBe(false);
    expect(isHealing({ wariness: 0.2, attachment: 0 }, 0.9)).toBe(false);
    expect(isHealing({ wariness: 0, attachment: 0 }, 0.9)).toBe(false);
  });
});

describe('effectiveGenes', () => {
  it('a fresh pip expresses its genome unchanged', () => {
    expect(effectiveGenes(FOUNDER, FRESH_DISPOSITIONS)).toEqual(FOUNDER);
  });

  it('scars read as timidity, devotion as clinginess; everything else is untouched', () => {
    const shaped = effectiveGenes(FOUNDER, { wariness: 0.8, attachment: 0.6 });
    expect(shaped.boldness).toBeLessThan(FOUNDER.boldness);
    expect(shaped.clinginess).toBeGreaterThan(FOUNDER.clinginess);
    expect(shaped.nosiness).toBe(FOUNDER.nosiness);
    expect(shaped.liveliness).toBe(FOUNDER.liveliness);
    expect(shaped.hue).toBe(FOUNDER.hue);
    expect(shaped.sat).toBe(FOUNDER.sat);
    expect(shaped.light).toBe(FOUNDER.light);
  });
});

describe('place memory', () => {
  it('remembers where it happened, not everywhere', () => {
    const places = markPlace(freshPlaces(), 0.1, 0.1, -0.34);
    expect(placeAt(places, 0.1, 0.1)).toBeLessThan(0);
    expect(placeAt(places, 0.9, 0.9)).toBe(0);
  });

  it('repeat scares deepen the same dread, clamped at -1', () => {
    let places = freshPlaces();
    for (let i = 0; i < 5; i++) places = markPlace(places, 0.5, 0.5, -0.34);
    expect(placeAt(places, 0.5, 0.5)).toBe(-1);
  });

  it('warmth writes over dread — counter-conditioning is arithmetic', () => {
    let places = markPlace(freshPlaces(), 0.5, 0.5, -0.34);
    for (let i = 0; i < 4; i++) places = markPlace(places, 0.5, 0.5, 0.2);
    expect(placeAt(places, 0.5, 0.5)).toBeGreaterThan(0);
  });

  it('fondness accumulates and clamps at +1', () => {
    let places = freshPlaces();
    for (let i = 0; i < 8; i++) places = markPlace(places, 0.2, 0.8, 0.2);
    expect(placeAt(places, 0.2, 0.8)).toBe(1);
  });

  it('coordinates outside the viewport clamp to edge cells', () => {
    const places = markPlace(freshPlaces(), 1.5, -0.5, -0.34);
    expect(places).toHaveLength(PLACE_CELLS);
    expect(placeAt(places, 0.99, 0.01)).toBeLessThan(0);
  });

  it('both poles fade toward neutral, slowly, and never overshoot', () => {
    let places = markPlace(freshPlaces(), 0.1, 0.1, -1);
    places = markPlace(places, 0.9, 0.9, 1);
    const later = fadePlaces(places, 300);
    expect(later[0]).toBeGreaterThan(-1);
    expect(later[0]).toBeLessThan(0);
    const gone = fadePlaces(places, 10000);
    expect(placeAt(gone, 0.1, 0.1)).toBe(0);
    expect(placeAt(gone, 0.9, 0.9)).toBe(0);
  });
});
