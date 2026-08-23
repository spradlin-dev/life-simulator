import { describe, expect, it } from 'vitest';
import { eat, FRESH_NEEDS, happinessOf, tickNeeds, type Needs } from './needs.ts';
import { FOUNDER, type Genes } from './genes.ts';

function run(
  needs: Needs,
  state: Parameters<typeof tickNeeds>[1],
  speed: number,
  seconds: number,
  genes: Genes = FOUNDER,
): Needs {
  let out = needs;
  for (let elapsed = 0; elapsed < seconds; elapsed += 0.1) out = tickNeeds(out, state, speed, 0.1, genes);
  return out;
}

describe('tickNeeds', () => {
  it('food dwindles with time regardless of state', () => {
    expect(run(FRESH_NEEDS, 'wander', 0, 60).food).toBeLessThan(FRESH_NEEDS.food);
    expect(run(FRESH_NEEDS, 'sleep', 0, 60).food).toBeLessThan(FRESH_NEEDS.food);
  });

  it('rest drains awake — faster at speed — and recovers asleep', () => {
    const idle = run(FRESH_NEEDS, 'wander', 0, 60);
    const running = run(FRESH_NEEDS, 'flee', 300, 60);
    expect(idle.rest).toBeLessThan(FRESH_NEEDS.rest);
    expect(running.rest).toBeLessThan(idle.rest);
    const napped = run({ ...FRESH_NEEDS, rest: 0.2 }, 'sleep', 0, 45);
    expect(napped.rest).toBeGreaterThan(0.9);
  });

  it('fun grows while engaged and fades in idleness', () => {
    const bored = run(FRESH_NEEDS, 'wander', 0, 120);
    expect(bored.fun).toBeLessThan(FRESH_NEEDS.fun);
    for (const s of ['follow', 'curious', 'snuggle', 'play', 'snack'] as const) {
      expect(run({ ...FRESH_NEEDS, fun: 0.2 }, s, 100, 20).fun).toBeGreaterThan(0.9);
    }
  });

  it('fun stays clamped at both ends', () => {
    expect(run(FRESH_NEEDS, 'follow', 0, 60).fun).toBeLessThanOrEqual(1);
    expect(run({ ...FRESH_NEEDS, fun: 0.01 }, 'wander', 0, 600).fun).toBeGreaterThanOrEqual(0);
  });

  it('everything stays clamped to [0, 1]', () => {
    const starved = run(FRESH_NEEDS, 'wander', 500, 3600);
    expect(starved.food).toBeGreaterThanOrEqual(0);
    expect(starved.rest).toBeGreaterThanOrEqual(0);
    const rested = run(FRESH_NEEDS, 'sleep', 0, 3600);
    expect(rested.rest).toBeLessThanOrEqual(1);
  });

  it('midpoint tempo genes reproduce the original rates exactly', () => {
    // the food anchor moved from stillness to the wander speed cap when
    // movement began burning belly: at 60 px/s the identity
    // (1 + 60/600)/528 = 1/480 reproduces the pre-movement-cost drain
    const ambling = tickNeeds(FRESH_NEEDS, 'wander', 60, 1, FOUNDER);
    expect(ambling.food).toBeCloseTo(1 - 1 / 480, 10);
    const after = tickNeeds(FRESH_NEEDS, 'wander', 0, 1, FOUNDER);
    expect(after.food).toBeCloseTo(1 - 1 / 528, 10);
    expect(after.rest).toBeCloseTo(1 - 1 / 300, 10);
    expect(after.fun).toBeCloseTo(0.7 - 1 / 360, 10);
    // mid rest keeps the cascade's verve factor neutral, so this pin still
    // means "midpoint reproduces the original refill"
    const engaged = tickNeeds({ ...FRESH_NEEDS, rest: 0.5, fun: 0.5 }, 'follow', 0, 1, FOUNDER);
    expect(engaged.fun).toBeCloseTo(0.5 + 1 / 25, 10);
  });

  it('the cascade: rest sets how richly play refills', () => {
    const refill = (rest: number) =>
      tickNeeds({ food: 1, rest, fun: 0.5 }, 'follow', 0, 1, FOUNDER).fun - 0.5;
    expect(refill(0.5)).toBeCloseTo(1 / 25, 10);
    expect(refill(1)).toBeCloseTo(1.5 / 25, 10);
    expect(refill(0)).toBeCloseTo(0.5 / 25, 10);
  });

  it('movement burns food like it burns rest', () => {
    const still = run(FRESH_NEEDS, 'wander', 0, 60);
    const dashing = run(FRESH_NEEDS, 'flee', 300, 60);
    expect(dashing.food).toBeLessThan(still.food);
    // sleep sits at zero speed: a night costs no more belly than a still day
    expect(run(FRESH_NEEDS, 'sleep', 0, 60).food).toBeCloseTo(still.food, 10);
  });

  it('the cascade: hunger wears the body down faster, but only real hunger', () => {
    const drained = (food: number) =>
      1 - tickNeeds({ food, rest: 1, fun: 0.7 }, 'wander', 0, 1, FOUNDER).rest;
    expect(drained(1)).toBeCloseTo(1 / 300, 10);
    expect(drained(0.35)).toBeCloseTo(1 / 300, 10);
    expect(drained(0)).toBeCloseTo(1.75 / 300, 10);
  });

  it('the appetite dial multiplies belly drain exactly and touches nothing else', () => {
    const lean = tickNeeds(FRESH_NEEDS, 'wander', 0, 1, FOUNDER, 10);
    expect(lean.food).toBeCloseTo(1 - 10 / 528, 10);
    expect(lean.rest).toBeCloseTo(1 - 1 / 300, 10);
    expect(lean.fun).toBeCloseTo(0.7 - 1 / 360, 10);
    expect(tickNeeds(FRESH_NEEDS, 'wander', 0, 1, FOUNDER, 1)).toEqual(
      tickNeeds(FRESH_NEEDS, 'wander', 0, 1, FOUNDER),
    );
  });

  it('the weariness dial multiplies tiring exactly, and never sleep recovery', () => {
    const worn = tickNeeds(FRESH_NEEDS, 'wander', 0, 1, FOUNDER, 1, 10);
    expect(worn.rest).toBeCloseTo(1 - 10 / 300, 10);
    expect(worn.food).toBeCloseTo(1 - 1 / 528, 10);
    expect(worn.fun).toBeCloseTo(0.7 - 1 / 360, 10);
    const asleep = { food: 1, rest: 0.5, fun: 0.7 };
    expect(tickNeeds(asleep, 'sleep', 0, 1, FOUNDER, 1, 10).rest).toEqual(
      tickNeeds(asleep, 'sleep', 0, 1, FOUNDER).rest,
    );
    expect(tickNeeds(FRESH_NEEDS, 'wander', 0, 1, FOUNDER, 1, 1)).toEqual(
      tickNeeds(FRESH_NEEDS, 'wander', 0, 1, FOUNDER),
    );
  });

  it('metabolism sets the table: high burns food faster than low', () => {
    const glutton = run(FRESH_NEEDS, 'wander', 0, 120, { ...FOUNDER, metabolism: 1 });
    const grazer = run(FRESH_NEEDS, 'wander', 0, 120, { ...FOUNDER, metabolism: 0 });
    expect(glutton.food).toBeLessThan(grazer.food);
  });

  it('stamina keeps the lights on: high outlasts low awake', () => {
    const nightOwl = run(FRESH_NEEDS, 'wander', 0, 120, { ...FOUNDER, stamina: 1 });
    const napper = run(FRESH_NEEDS, 'wander', 0, 120, { ...FOUNDER, stamina: 0 });
    expect(nightOwl.rest).toBeGreaterThan(napper.rest);
  });

  it('playfulness cuts both ways: bores faster idle, refills richer engaged', () => {
    const eager = run(FRESH_NEEDS, 'wander', 0, 120, { ...FOUNDER, playfulness: 1 });
    const mellow = run(FRESH_NEEDS, 'wander', 0, 120, { ...FOUNDER, playfulness: 0 });
    expect(eager.fun).toBeLessThan(mellow.fun);
    const eagerPlay = run({ ...FRESH_NEEDS, fun: 0.2 }, 'follow', 100, 5, { ...FOUNDER, playfulness: 1 });
    const mellowPlay = run({ ...FRESH_NEEDS, fun: 0.2 }, 'follow', 100, 5, { ...FOUNDER, playfulness: 0 });
    expect(eagerPlay.fun).toBeGreaterThan(mellowPlay.fun);
  });
});

describe('eat', () => {
  it('tops food up, capped at full', () => {
    expect(eat({ ...FRESH_NEEDS, food: 0.3 }).food).toBeCloseTo(0.7);
    expect(eat(FRESH_NEEDS).food).toBe(1);
  });

  it('the meal is worth what the body can digest', () => {
    expect(eat({ ...FRESH_NEEDS, food: 0.3 }, 0.5).food).toBeCloseTo(0.5);
    // even an indigestible mouthful still perks the body a little
    expect(eat({ ...FRESH_NEEDS, food: 0.3, rest: 0.3 }, 0).food).toBeCloseTo(0.3);
    expect(eat({ ...FRESH_NEEDS, food: 0.3, rest: 0.3 }, 0).rest).toBeCloseTo(0.35);
  });

  it('perks the body a little, capped at full', () => {
    const after = eat({ food: 0.2, rest: 0.3, fun: 0.5 });
    expect(after.rest).toBeCloseTo(0.35);
    expect(eat(FRESH_NEEDS).rest).toBe(1);
  });
});

describe('happinessOf', () => {
  it('is high for a fed, trusted, calm pip and low for a neglected one', () => {
    expect(happinessOf(FRESH_NEEDS, 0.9, 0)).toBeGreaterThan(0.7);
    expect(happinessOf({ food: 0.1, rest: 0.2, fun: 0.1 }, 0.5, 0)).toBeLessThan(0.2);
  });

  it('fear crushes it', () => {
    expect(happinessOf(FRESH_NEEDS, 0.9, 1)).toBeLessThan(happinessOf(FRESH_NEEDS, 0.9, 0) / 2);
  });

  it('more fun means more happiness, all else equal', () => {
    expect(happinessOf({ food: 0.5, rest: 0.5, fun: 0.9 }, 0.5, 0)).toBeGreaterThan(
      happinessOf({ food: 0.5, rest: 0.5, fun: 0.1 }, 0.5, 0),
    );
  });

  it('more trust means more happiness, all else equal', () => {
    expect(happinessOf(FRESH_NEEDS, 0.9, 0)).toBeGreaterThan(happinessOf(FRESH_NEEDS, 0.3, 0));
  });
});
