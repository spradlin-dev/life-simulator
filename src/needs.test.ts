import { describe, expect, it } from 'vitest';
import { eat, FRESH_NEEDS, happinessOf, tickNeeds, type Needs } from './needs.ts';

function run(needs: Needs, state: Parameters<typeof tickNeeds>[1], speed: number, seconds: number): Needs {
  let out = needs;
  for (let elapsed = 0; elapsed < seconds; elapsed += 0.1) out = tickNeeds(out, state, speed, 0.1);
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
    for (const s of ['follow', 'curious', 'snuggle', 'snack'] as const) {
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
});

describe('eat', () => {
  it('tops food up, capped at full', () => {
    expect(eat({ ...FRESH_NEEDS, food: 0.3 }).food).toBeCloseTo(0.7);
    expect(eat(FRESH_NEEDS).food).toBe(1);
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
