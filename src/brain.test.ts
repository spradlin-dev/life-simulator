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
import type { Genes } from './genes.ts';
import { FRESH_NEEDS, type Needs } from './needs.ts';
import { effectiveGenes } from './dispositions.ts';

const calm: Moods = { fear: 0, curiosity: 0, trust: 0.5 };
const fed: Needs = FRESH_NEEDS;

// every trait at its midpoint reproduces the original, pre-genetics tuning
const plain: Genes = {
  boldness: 0.5,
  clinginess: 0.5,
  nosiness: 0.5,
  liveliness: 0.5,
  hue: 159,
  sat: 53,
  light: 63,
  size: 0.5,
  roundness: 0.5,
  antLength: 0.5,
  antTip: 0.5,
  eyeSize: 0.5,
  eyeGap: 0.5,
  freckles: 0.5,
  metabolism: 0.5,
  stamina: 0.5,
  playfulness: 0.5,
};

function senses(overrides: Partial<Senses> = {}): Senses {
  return {
    presence: 1,
    dist: 300,
    speed: 0,
    stillFor: 0,
    treatDist: Infinity,
    place: 0,
    alarm: 0,
    ...overrides,
  };
}

function runMoods(moods: Moods, s: Senses, seconds: number, dt = 0.1, genes: Genes = plain): Moods {
  let out = moods;
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) out = updateMoods(out, genes, s, dt);
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

  it('a statue stops earning trust', () => {
    const parked = senses({ dist: 100, stillFor: 30 });
    expect(runMoods(calm, parked, 5).trust).toBe(calm.trust);
  });

  it('dreaded ground makes the skin crawl', () => {
    const badPlace = senses({ presence: 0, place: -0.8 });
    const fine = senses({ presence: 0 });
    expect(runMoods(calm, badPlace, 5).fear).toBeGreaterThan(runMoods(calm, fine, 5).fear);
  });

  it('dread only ever raises fear, never soothes a terrified pip', () => {
    const terrified: Moods = { ...calm, fear: 0.9 };
    const onDread = runMoods(terrified, senses({ presence: 0, place: -0.4 }), 1);
    const offDread = runMoods(terrified, senses({ presence: 0 }), 1);
    expect(onDread.fear).toBeGreaterThanOrEqual(offDread.fear);
  });

  it('dread cannot overshoot its floor even in one giant time step', () => {
    const after = updateMoods(calm, plain, senses({ presence: 0, place: -1 }), 10);
    expect(after.fear).toBeLessThanOrEqual(0.6);
  });

  it('beloved ground soothes faster than neutral ground', () => {
    const shaken: Moods = { ...calm, fear: 0.5 };
    const home = runMoods(shaken, senses({ presence: 0, place: 0.9 }), 2);
    const nowhere = runMoods(shaken, senses({ presence: 0 }), 2);
    expect(home.fear).toBeLessThan(nowhere.fear);
  });

  it('panic is contagious: a fleeing neighbor spreads fear', () => {
    const nearPanic = runMoods(calm, senses({ presence: 0, alarm: 0.6 }), 2);
    const alone = runMoods(calm, senses({ presence: 0 }), 2);
    expect(nearPanic.fear).toBeGreaterThan(alone.fear);
  });

  it('the bold catch panic more slowly than the timid', () => {
    const panicky = senses({ presence: 0, alarm: 0.6 });
    const bold = runMoods(calm, panicky, 2, 0.1, { ...plain, boldness: 1 });
    const timid = runMoods(calm, panicky, 2, 0.1, { ...plain, boldness: 0 });
    expect(bold.fear).toBeLessThan(timid.fear);
  });

  it('a once-scarred pip startles at what a fresh pip shrugs off', () => {
    const scarred = effectiveGenes(plain, { wariness: 0.8, attachment: 0 });
    expect(startle(calm, scarred, 250, 0.5).fear).toBeGreaterThan(
      startle(calm, plain, 250, 0.5).fear,
    );
  });

  it('curiosity about a statue wears off instead of building', () => {
    const parked = senses({ dist: 200, stillFor: 30 });
    const after = runMoods({ ...calm, curiosity: 0.5 }, parked, 3);
    expect(after.curiosity).toBeLessThan(0.5);
  });

  it('a nosy pip warms to curiosity faster', () => {
    const still = senses({ dist: 200 });
    const nosy = runMoods(calm, still, 2, 0.1, { ...plain, nosiness: 1 });
    const meh = runMoods(calm, still, 2, 0.1, { ...plain, nosiness: 0 });
    expect(nosy.curiosity).toBeGreaterThan(meh.curiosity);
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
    const after = startle(calm, plain, 50, 1.0);
    expect(after.fear).toBeGreaterThan(0.75);
    expect(after.trust).toBeLessThan(calm.trust);
  });

  it('a click across the room goes unnoticed', () => {
    expect(startle(calm, plain, 600, 1.0)).toEqual(calm);
  });

  it('a distant click barely dents curiosity; a close one wipes it', () => {
    const nosy: Moods = { ...calm, curiosity: 0.9 };
    expect(startle(nosy, plain, 490, 1.0).curiosity).toBeGreaterThan(0.8);
    expect(startle(nosy, plain, 50, 1.0).curiosity).toBeLessThan(0.15);
  });

  it('a knock right on top of it is terrifying', () => {
    expect(knock(calm, plain, 50, 1.0).fear).toBeGreaterThan(0.75);
  });

  it('a knock across the room piques curiosity instead', () => {
    const after = knock(calm, plain, 600, 1.0);
    expect(after.fear).toBe(0);
    expect(after.curiosity).toBeGreaterThan(0);
  });

  it('a knock far beyond earshot changes nothing', () => {
    expect(knock(calm, plain, 950, 1.0)).toEqual(calm);
  });
});

describe('chooseState', () => {
  it('falls asleep when nothing has happened for a long while', () => {
    const s = senses({ presence: 0, stillFor: 40 });
    expect(chooseState('wander', calm, fed, plain, s).state).toBe('sleep');
  });

  it('sleeps through distant gentle movement', () => {
    const s = senses({ dist: 400, speed: 100 });
    expect(chooseState('sleep', calm, { ...fed, rest: 0.5 }, plain, s).state).toBe('sleep');
  });

  it('a lingering ghost does not wake it', () => {
    const s = senses({ presence: 0.4, dist: 100 });
    expect(chooseState('sleep', calm, { ...fed, rest: 0.5 }, plain, s).state).toBe('sleep');
  });

  it('wakes with a startle when the watcher barges in close', () => {
    const decision = chooseState('sleep', calm, { ...fed, rest: 0.5 }, plain, senses({ dist: 100 }));
    expect(decision.state).not.toBe('sleep');
    expect(decision.startled).toBe(true);
    expect(decision.moods.fear).toBeGreaterThan(0);
  });

  it('exhaustion forces a nap even in company', () => {
    const s = senses({ dist: 300 });
    expect(chooseState('wander', calm, { ...fed, rest: 0.1 }, plain, s).state).toBe('sleep');
  });

  it('wakes on its own once rested — if something is happening', () => {
    const active = senses({ dist: 300, stillFor: 5 });
    expect(chooseState('sleep', calm, { ...fed, rest: 0.96 }, plain, active).state).toBe('wander');
  });

  it('a rested pip left alone sleeps on peacefully', () => {
    const alone = senses({ presence: 0, stillFor: 100 });
    expect(chooseState('sleep', calm, { ...fed, rest: 0.96 }, plain, alone).state).toBe('sleep');
  });

  it('too exhausted to be disturbed by mere closeness', () => {
    const looming = senses({ dist: 100 });
    expect(chooseState('sleep', calm, { ...fed, rest: 0.1 }, plain, looming).state).toBe('sleep');
  });

  it('a tired-but-not-exhausted pip stays awake in company', () => {
    const s = senses({ dist: 100 });
    expect(chooseState('wander', calm, { ...fed, rest: 0.3 }, plain, s).state).not.toBe('sleep');
  });

  it('a hungry pip goes for the treat', () => {
    const s = senses({ treatDist: 200 });
    expect(chooseState('wander', calm, { ...fed, food: 0.3 }, plain, s).state).toBe('snack');
  });

  it('a starving pip is too desperate to sleep, however tired', () => {
    const alone = senses({ presence: 0, stillFor: 100 });
    const d = chooseState('wander', calm, { food: 0, rest: 0.05, fun: 0.5 }, plain, alone);
    expect(d.state).not.toBe('sleep');
  });

  it('until the body gives out: a starving pip passes out at empty', () => {
    const d = chooseState('wander', calm, { food: 0, rest: 0, fun: 0.5 }, plain, senses());
    expect(d.state).toBe('sleep');
  });

  it('a berry laid beside a passed-out pip rouses it to nibble', () => {
    const close = chooseState('sleep', calm, { food: 0, rest: 0.05, fun: 0.5 }, plain, senses({ treatDist: 80 }));
    expect(close.state).toBe('snack');
    const far = chooseState('sleep', calm, { food: 0, rest: 0.05, fun: 0.5 }, plain, senses({ treatDist: 400, presence: 0 }));
    expect(far.state).toBe('sleep');
  });

  it('hunger pangs wake a sleeper who still has the strength', () => {
    const strong = chooseState('sleep', calm, { food: 0, rest: 0.6, fun: 0.5 }, plain, senses({ presence: 0 }));
    expect(strong.state).toBe('wander');
    const atLine = chooseState('sleep', calm, { food: 0, rest: 0.4, fun: 0.5 }, plain, senses({ presence: 0 }));
    expect(atLine.state).toBe('wander');
    const justUnder = chooseState('sleep', calm, { food: 0, rest: 0.39, fun: 0.5 }, plain, senses({ presence: 0 }));
    expect(justUnder.state).toBe('sleep');
    // below the strength line the collapse holds — no flickering back up
    const spent = chooseState('sleep', calm, { food: 0, rest: 0.3, fun: 0.5 }, plain, senses({ presence: 0 }));
    expect(spent.state).toBe('sleep');
  });

  it('a hovering rescuer cannot startle a collapsed pip awake', () => {
    const d = chooseState('sleep', calm, { food: 0, rest: 0.2, fun: 0.5 }, plain, senses({ presence: 1, dist: 100 }));
    expect(d.state).toBe('sleep');
    expect(d.startled).toBe(false);
  });

  it('collapse waits for the bite: a nibbling pip at zero rest keeps eating', () => {
    const d = chooseState('snack', calm, { food: 0, rest: 0, fun: 0.5 }, plain, senses({ treatDist: 50 }));
    expect(d.state).toBe('snack');
  });

  it('a fed pip still naps exactly as before', () => {
    expect(chooseState('wander', calm, { food: 0.5, rest: 0.1, fun: 0.5 }, plain, senses()).state).toBe('sleep');
  });

  it('a full pip ignores treats', () => {
    const s = senses({ treatDist: 200 });
    expect(chooseState('wander', calm, fed, plain, s).state).toBe('wander');
  });

  it('a hungry pip with no treat in range does not snack', () => {
    expect(chooseState('wander', calm, { ...fed, food: 0.3 }, plain, senses({ treatDist: 800 })).state).not.toBe('snack');
    expect(chooseState('wander', calm, { ...fed, food: 0.3 }, plain, senses()).state).toBe('wander');
  });

  it('hunger sharpens the nose: a starving pip notices what a peckish one misses', () => {
    const distant = senses({ treatDist: 600 });
    expect(chooseState('wander', calm, { ...fed, food: 0.8 }, plain, distant).state).not.toBe('snack');
    expect(chooseState('wander', calm, { ...fed, food: 0.05 }, plain, distant).state).toBe('snack');
  });

  it('hunger makes it braver', () => {
    const uneasy: Moods = { ...calm, fear: 0.31 };
    expect(chooseState('wander', uneasy, { ...fed, food: 0.1 }, plain, senses()).state).not.toBe('flee');
    expect(chooseState('wander', uneasy, fed, plain, senses()).state).toBe('flee');
  });

  it('flees when frightened, cowers when terrified', () => {
    expect(chooseState('wander', { ...calm, fear: 0.5 }, fed, plain, senses()).state).toBe('flee');
    expect(chooseState('wander', { ...calm, fear: 0.9 }, fed, plain, senses()).state).toBe('cower');
  });

  it('a bold pip holds its ground where a timid one bolts', () => {
    const uneasy: Moods = { ...calm, fear: 0.3 };
    const bold: Genes = { ...plain, boldness: 0.9 };
    const timid: Genes = { ...plain, boldness: 0.1 };
    expect(chooseState('wander', uneasy, fed, bold, senses()).state).toBe('wander');
    expect(chooseState('wander', uneasy, fed, timid, senses()).state).toBe('flee');
  });

  it('a timid pip cowers where a bold one merely flees', () => {
    const terrified: Moods = { ...calm, fear: 0.78 };
    const bold: Genes = { ...plain, boldness: 0.9 };
    const timid: Genes = { ...plain, boldness: 0.1 };
    expect(chooseState('wander', terrified, fed, timid, senses()).state).toBe('cower');
    expect(chooseState('wander', terrified, fed, bold, senses()).state).toBe('flee');
  });

  it('approaches out of curiosity', () => {
    const nosy: Moods = { ...calm, curiosity: 0.8 };
    expect(chooseState('wander', nosy, fed, plain, senses({ dist: 200 })).state).toBe('curious');
  });

  it('an indifferent pip needs more of an itch to investigate', () => {
    const itch: Moods = { ...calm, curiosity: 0.5 };
    const indifferent: Genes = { ...plain, nosiness: 0.1 };
    expect(chooseState('wander', itch, fed, plain, senses({ dist: 200 })).state).toBe('curious');
    expect(chooseState('wander', itch, fed, indifferent, senses({ dist: 200 })).state).toBe('wander');
  });

  it('tags along only once trust is earned', () => {
    const moving = senses({ dist: 400, speed: 200 });
    expect(chooseState('wander', { ...calm, trust: 0.7 }, fed, plain, moving).state).toBe('follow');
    expect(chooseState('wander', { ...calm, trust: 0.4 }, fed, plain, moving).state).toBe('wander');
  });

  it('an aloof pip needs more trust to tag along', () => {
    const moving = senses({ dist: 400, speed: 200 });
    const fond: Moods = { ...calm, trust: 0.6 };
    const clingy: Genes = { ...plain, clinginess: 0.9 };
    const aloof: Genes = { ...plain, clinginess: 0.1 };
    expect(chooseState('wander', fond, fed, clingy, moving).state).toBe('follow');
    expect(chooseState('wander', fond, fed, aloof, moving).state).toBe('wander');
  });

  it('will not chase a watcher moving too fast to follow', () => {
    const racing = senses({ dist: 400, speed: 600 });
    expect(chooseState('wander', { ...calm, trust: 0.7 }, fed, plain, racing).state).toBe('wander');
  });

  it('does not chase a ghost', () => {
    const s = senses({ presence: 0.4, dist: 400, speed: 200 });
    expect(chooseState('wander', { ...calm, trust: 0.7 }, fed, plain, s).state).toBe('wander');
  });

  it('snuggles only a trusted, gentle watcher', () => {
    const close = senses({ dist: 40 });
    expect(chooseState('wander', { ...calm, trust: 0.8 }, fed, plain, close).state).toBe('snuggle');
    expect(chooseState('wander', { ...calm, trust: 0.5 }, fed, plain, close).state).toBe('wander');
  });

  it('a clingy pip snuggles on thinner trust', () => {
    const close = senses({ dist: 40 });
    const fond: Moods = { ...calm, trust: 0.66 };
    const clingy: Genes = { ...plain, clinginess: 0.9 };
    expect(chooseState('wander', fond, fed, clingy, close).state).toBe('snuggle');
    expect(chooseState('wander', fond, fed, plain, close).state).toBe('wander');
  });

  it('a lively pip stays up later', () => {
    const idle = senses({ presence: 0, stillFor: 35 });
    const zippy: Genes = { ...plain, liveliness: 1 };
    expect(chooseState('wander', calm, fed, zippy, idle).state).toBe('wander');
    expect(chooseState('wander', calm, fed, plain, idle).state).toBe('sleep');
  });

  it('does not snuggle a ghost', () => {
    const s = senses({ presence: 0.4, dist: 40 });
    expect(chooseState('wander', { ...calm, trust: 0.8 }, fed, plain, s).state).toBe('wander');
  });

  it('trust shrinks its personal space', () => {
    expect(personalSpace(1, plain)).toBeLessThan(personalSpace(0, plain));
  });

  it('boldness shrinks it too', () => {
    expect(personalSpace(0.5, { ...plain, boldness: 1 })).toBeLessThan(
      personalSpace(0.5, { ...plain, boldness: 0 }),
    );
  });
});
