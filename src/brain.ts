export type CritterState =
  | 'wander'
  | 'curious'
  | 'follow'
  | 'flee'
  | 'cower'
  | 'snuggle'
  | 'sleep';

export interface Moods {
  fear: number;
  curiosity: number;
  trust: number;
}

export interface Senses {
  presence: number; // 0 gone … 1 actively here; fades for a while after contact ends
  dist: number;
  speed: number;
  stillFor: number;
}

export interface Decision {
  state: CritterState;
  moods: Moods;
  startled: boolean;
}

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// how close it lets the watcher get; shrinks as it learns to trust you
export function personalSpace(trust: number): number {
  return lerp(120, 34, trust);
}

export function startle(moods: Moods, dist: number, strength: number): Moods {
  const nearness = Math.max(0, 1 - dist / 500);
  if (nearness === 0) return moods;
  return {
    fear: clamp01(moods.fear + strength * nearness),
    trust: clamp01(moods.trust - 0.1 * strength * nearness),
    curiosity: clamp01(moods.curiosity * (1 - nearness)),
  };
}

// a click or tap is a knock on the glass: frightening up close, intriguing from afar
export function knock(moods: Moods, dist: number, strength: number): Moods {
  const after = startle(moods, dist, strength);
  if (after.fear < 0.2 && dist < 900) {
    return { ...after, curiosity: clamp01(after.curiosity + 0.15) };
  }
  return after;
}

// a fast watcher bearing down on it is menacing; the closer and faster, the worse
function menace(senses: Senses): number {
  return (
    (Math.max(0, senses.speed - 500) / 1500) *
    Math.max(0, 1 - senses.dist / 380)
  );
}

export function updateMoods(moods: Moods, senses: Senses, dt: number): Moods {
  const { presence, dist, speed } = senses;
  const threat = menace(senses);

  let fear = clamp01(moods.fear + threat * dt * 5);
  fear = clamp01(fear - dt * (0.1 + 0.15 * moods.trust));

  // a watcher sitting still nearby is interesting — even the fading ghost of one
  let curiosity: number;
  if (presence > 0 && dist < 480 && speed < 50 && fear < 0.2) {
    curiosity = clamp01(moods.curiosity + dt * 0.28 * presence);
  } else {
    curiosity = clamp01(moods.curiosity - dt * 0.2);
  }

  // trust grows only while the watcher is mostly there — never from a faded ghost
  let trust = clamp01(moods.trust - threat * dt * 0.12);
  if (presence > 0.5 && dist < 180 && fear < 0.1 && speed < 160) {
    trust = clamp01(trust + dt * 0.015);
  }

  return { fear, curiosity, trust };
}

// The whole personality: a handful of if-statements, read top to bottom.
// The sleep→wake branch is the one place this also changes moods (the rude-awakening startle).
export function chooseState(current: CritterState, moods: Moods, senses: Senses): Decision {
  const { presence, dist, speed, stillFor } = senses;
  const decide = (state: CritterState, next = moods, startled = false): Decision => ({
    state,
    moods: next,
    startled,
  });

  if (moods.fear > 0.75) return decide('cower');
  if (moods.fear > 0.28) return decide('flee');

  if (current === 'sleep') {
    const disturbed = presence > 0.6 && (dist < 160 || speed > 450);
    if (!disturbed) return decide('sleep');
    return decide('wander', startle(moods, dist, 0.4), true);
  }
  if (stillFor > 30 && (presence <= 0 || dist > 300)) return decide('sleep');

  if (presence <= 0) return decide('wander');
  if (dist < personalSpace(moods.trust) + 30 && moods.trust > 0.72 && speed < 70 && presence > 0.5) {
    return decide('snuggle');
  }
  if (moods.curiosity > 0.45 && dist < 480) return decide('curious');
  if (moods.trust > 0.55 && dist < 620 && speed > 25 && speed < 430 && presence > 0.5) {
    return decide('follow');
  }
  return decide('wander');
}
