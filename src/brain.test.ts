import { describe, expect, it } from 'vitest';
import {
  chooseState,
  knock,
  personalSpace,
  startle,
  updateMoods,
  type Moods,
  type Senses,
} from './brain.ts';

const calm: Moods = { fear: 0, curiosity: 0, trust: 0.5 };

function senses(overrides: Partial<Senses> = {}): Senses {
  return {
    presence: 1,
    dist: 300,
    speed: 0,
    stillFor: 0,
    ...overrides,
  };
}

function runMoods(moods: Moods, s: Senses, seconds: number, dt = 0.1): Moods {
  let out = moods;
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) out = updateMoods(out, s, dt);
  return out;
}

describe('moods', () => {
  it('a still watcher nearby makes it curious', () => {
    const after = runMoods(calm, senses({ dist: 200 }), 3);
    expect(after.curiosity).toBeGreaterThan(0.45);
  });

  it('the fading ghost of a touch still draws curiosity, more weakly', () => {
    const ghost = runMoods(calm, senses({ presence: 0.5, dist: 200 }), 3);
    const full = runMoods(calm, senses({ dist: 200 }), 3);
    expect(ghost.curiosity).toBeGreaterThan(0.3);
    expect(ghost.curiosity).toBeLessThan(full.curiosity);
  });

  it('a fast lunge builds fear and erodes trust', () => {
    const lunge = senses({ dist: 100, speed: 2000 });
    const after = runMoods(calm, lunge, 0.2, 0.05);
    expect(after.fear).toBeGreaterThan(0.28);
    expect(after.trust).toBeLessThan(calm.trust);
  });

  it('calm closeness slowly builds trust', () => {
    const after = runMoods(calm, senses({ dist: 100 }), 5);
    expect(after.trust).toBeGreaterThan(calm.trust);
  });

  it('ghosts do not build trust', () => {
    const after = runMoods(calm, senses({ presence: 0.4, dist: 100 }), 5);
    expect(after.trust).toBe(calm.trust);
  });

  it('a fresh ghost still warms trust for a moment', () => {
    const after = runMoods(calm, senses({ presence: 0.6, dist: 100 }), 5);
    expect(after.trust).toBeGreaterThan(calm.trust);
  });

  it('moods stay clamped to [0, 1]', () => {
    const panic = runMoods(calm, senses({ dist: 10, speed: 10000 }), 10);
    expect(panic.fear).toBeLessThanOrEqual(1);
    expect(panic.trust).toBeGreaterThanOrEqual(0);
    const bored = runMoods(
      { fear: 0, curiosity: 1, trust: 1 },
      senses({ presence: 0 }),
      60,
    );
    expect(bored.curiosity).toBeGreaterThanOrEqual(0);
  });
});

describe('startle and knocks', () => {
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

  it('a knock right on top of it is terrifying', () => {
    expect(knock(calm, 50, 1.0).fear).toBeGreaterThan(0.75);
  });

  it('a knock across the room piques curiosity instead', () => {
    const after = knock(calm, 600, 1.0);
    expect(after.fear).toBe(0);
    expect(after.curiosity).toBeGreaterThan(0);
  });

  it('a knock far beyond earshot changes nothing', () => {
    expect(knock(calm, 950, 1.0)).toEqual(calm);
  });
});

describe('chooseState', () => {
  it('falls asleep when nothing has happened for a long while', () => {
    const s = senses({ presence: 0, stillFor: 40 });
    expect(chooseState('wander', calm, s).state).toBe('sleep');
  });

  it('sleeps through distant gentle movement', () => {
    const s = senses({ dist: 400, speed: 100 });
    expect(chooseState('sleep', calm, s).state).toBe('sleep');
  });

  it('a lingering ghost does not wake it', () => {
    const s = senses({ presence: 0.4, dist: 100 });
    expect(chooseState('sleep', calm, s).state).toBe('sleep');
  });

  it('wakes with a startle when the watcher barges in close', () => {
    const decision = chooseState('sleep', calm, senses({ dist: 100 }));
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
    expect(chooseState('wander', nosy, senses({ dist: 200 })).state).toBe('curious');
  });

  it('tags along only once trust is earned', () => {
    const moving = senses({ dist: 400, speed: 200 });
    expect(chooseState('wander', { ...calm, trust: 0.7 }, moving).state).toBe('follow');
    expect(chooseState('wander', { ...calm, trust: 0.4 }, moving).state).toBe('wander');
  });

  it('will not chase a watcher moving too fast to follow', () => {
    const racing = senses({ dist: 400, speed: 600 });
    expect(chooseState('wander', { ...calm, trust: 0.7 }, racing).state).toBe('wander');
  });

  it('does not chase a ghost', () => {
    const s = senses({ presence: 0.4, dist: 400, speed: 200 });
    expect(chooseState('wander', { ...calm, trust: 0.7 }, s).state).toBe('wander');
  });

  it('snuggles only a trusted, gentle watcher', () => {
    const close = senses({ dist: 40 });
    expect(chooseState('wander', { ...calm, trust: 0.8 }, close).state).toBe('snuggle');
    expect(chooseState('wander', { ...calm, trust: 0.5 }, close).state).toBe('wander');
  });

  it('does not snuggle a ghost', () => {
    const s = senses({ presence: 0.4, dist: 40 });
    expect(chooseState('wander', { ...calm, trust: 0.8 }, s).state).toBe('wander');
  });

  it('trust shrinks its personal space', () => {
    expect(personalSpace(1)).toBeLessThan(personalSpace(0));
  });
});
