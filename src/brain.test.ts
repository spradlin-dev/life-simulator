import { describe, expect, it } from 'vitest';
import {
  chooseState,
  personalSpace,
  startle,
  updateMoods,
  type Moods,
  type Senses,
} from './brain.ts';

const calm: Moods = { fear: 0, curiosity: 0, trust: 0.5 };

function senses(overrides: Partial<Senses> = {}): Senses {
  return {
    cursorPresent: true,
    cursorDist: 300,
    cursorSpeed: 0,
    cursorStillFor: 0,
    ...overrides,
  };
}

function runMoods(moods: Moods, s: Senses, seconds: number, dt = 0.1): Moods {
  let out = moods;
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) out = updateMoods(out, s, dt);
  return out;
}

describe('moods', () => {
  it('a still cursor nearby makes it curious', () => {
    const after = runMoods(calm, senses({ cursorDist: 200 }), 3);
    expect(after.curiosity).toBeGreaterThan(0.45);
  });

  it('a fast lunge builds fear and erodes trust', () => {
    const lunge = senses({ cursorDist: 100, cursorSpeed: 2000 });
    const after = runMoods(calm, lunge, 0.2, 0.05);
    expect(after.fear).toBeGreaterThan(0.28);
    expect(after.trust).toBeLessThan(calm.trust);
  });

  it('calm closeness slowly builds trust', () => {
    const after = runMoods(calm, senses({ cursorDist: 100 }), 5);
    expect(after.trust).toBeGreaterThan(calm.trust);
  });

  it('moods stay clamped to [0, 1]', () => {
    const panic = runMoods(calm, senses({ cursorDist: 10, cursorSpeed: 10000 }), 10);
    expect(panic.fear).toBeLessThanOrEqual(1);
    expect(panic.trust).toBeGreaterThanOrEqual(0);
    const bored = runMoods(
      { fear: 0, curiosity: 1, trust: 1 },
      senses({ cursorPresent: false }),
      60,
    );
    expect(bored.curiosity).toBeGreaterThanOrEqual(0);
  });
});

describe('startle', () => {
  it('a click right next to it is terrifying', () => {
    const after = startle(calm, 50, 1.0);
    expect(after.fear).toBeGreaterThan(0.75);
    expect(after.trust).toBeLessThan(calm.trust);
  });

  it('a click across the room goes unnoticed', () => {
    expect(startle(calm, 600, 1.0)).toEqual(calm);
  });

  it('a distant click barely dents curiosity; a close one wipes it', () => {
    const nosy: Moods = { ...calm, curiosity: 0.9 };
    expect(startle(nosy, 490, 1.0).curiosity).toBeGreaterThan(0.8);
    expect(startle(nosy, 50, 1.0).curiosity).toBeLessThan(0.15);
  });
});

describe('chooseState', () => {
  it('falls asleep when nothing has happened for a long while', () => {
    const s = senses({ cursorPresent: false, cursorStillFor: 40 });
    expect(chooseState('wander', calm, s).state).toBe('sleep');
  });

  it('sleeps through distant gentle movement', () => {
    const s = senses({ cursorDist: 400, cursorSpeed: 100 });
    expect(chooseState('sleep', calm, s).state).toBe('sleep');
  });

  it('wakes with a startle when the cursor barges in close', () => {
    const decision = chooseState('sleep', calm, senses({ cursorDist: 100 }));
    expect(decision.state).not.toBe('sleep');
    expect(decision.startled).toBe(true);
    expect(decision.moods.fear).toBeGreaterThan(0);
  });

  it('flees when frightened, cowers when terrified', () => {
    expect(chooseState('wander', { ...calm, fear: 0.5 }, senses()).state).toBe('flee');
    expect(chooseState('wander', { ...calm, fear: 0.9 }, senses()).state).toBe('cower');
  });

  it('approaches out of curiosity', () => {
    const nosy: Moods = { ...calm, curiosity: 0.8 };
    expect(chooseState('wander', nosy, senses({ cursorDist: 200 })).state).toBe('curious');
  });

  it('tags along only once trust is earned', () => {
    const moving = senses({ cursorDist: 400, cursorSpeed: 200 });
    expect(chooseState('wander', { ...calm, trust: 0.7 }, moving).state).toBe('follow');
    expect(chooseState('wander', { ...calm, trust: 0.4 }, moving).state).toBe('wander');
  });

  it('will not chase a cursor moving too fast to follow', () => {
    const racing = senses({ cursorDist: 400, cursorSpeed: 600 });
    expect(chooseState('wander', { ...calm, trust: 0.7 }, racing).state).toBe('wander');
  });

  it('snuggles only a trusted, gentle cursor', () => {
    const close = senses({ cursorDist: 40 });
    expect(chooseState('wander', { ...calm, trust: 0.8 }, close).state).toBe('snuggle');
    expect(chooseState('wander', { ...calm, trust: 0.5 }, close).state).toBe('wander');
  });

  it('trust shrinks its personal space', () => {
    expect(personalSpace(1)).toBeLessThan(personalSpace(0));
  });
});
