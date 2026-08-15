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
  cursorPresent: boolean;
  cursorDist: number;
  cursorSpeed: number;
  cursorStillFor: number;
}

export interface Decision {
  state: CritterState;
  moods: Moods;
  startled: boolean;
}

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// how close it lets the cursor get; shrinks as it learns to trust you
export function personalSpace(trust: number): number {
  return lerp(120, 34, trust);
}

export function startle(moods: Moods, cursorDist: number, strength: number): Moods {
  const nearness = Math.max(0, 1 - cursorDist / 500);
  if (nearness === 0) return moods;
  return {
    fear: clamp01(moods.fear + strength * nearness),
    trust: clamp01(moods.trust - 0.1 * strength * nearness),
    curiosity: clamp01(moods.curiosity * (1 - nearness)),
  };
}

// a fast cursor bearing down on it is menacing; the closer and faster, the worse
function menace(senses: Senses): number {
  if (!senses.cursorPresent) return 0;
  return (
    (Math.max(0, senses.cursorSpeed - 500) / 1500) *
    Math.max(0, 1 - senses.cursorDist / 380)
  );
}

export function updateMoods(moods: Moods, senses: Senses, dt: number): Moods {
  const { cursorPresent, cursorDist, cursorSpeed } = senses;
  const threat = menace(senses);

  let fear = clamp01(moods.fear + threat * dt * 5);
  fear = clamp01(fear - dt * (0.1 + 0.15 * moods.trust));

  // a cursor that sits still nearby is interesting
  let curiosity: number;
  if (cursorPresent && cursorDist < 480 && cursorSpeed < 50 && fear < 0.2) {
    curiosity = clamp01(moods.curiosity + dt * 0.28);
  } else {
    curiosity = clamp01(moods.curiosity - dt * 0.2);
  }

  // calm time spent up close slowly builds trust
  let trust = clamp01(moods.trust - threat * dt * 0.12);
  if (cursorPresent && cursorDist < 180 && fear < 0.1 && cursorSpeed < 160) {
    trust = clamp01(trust + dt * 0.015);
  }

  return { fear, curiosity, trust };
}

// The whole personality: a handful of if-statements, read top to bottom.
// The sleep→wake branch is the one place this also changes moods (the rude-awakening startle).
export function chooseState(current: CritterState, moods: Moods, senses: Senses): Decision {
  const { cursorPresent, cursorDist, cursorSpeed, cursorStillFor } = senses;
  const decide = (state: CritterState, next = moods, startled = false): Decision => ({
    state,
    moods: next,
    startled,
  });

  if (moods.fear > 0.75) return decide('cower');
  if (moods.fear > 0.28) return decide('flee');

  if (current === 'sleep') {
    const disturbed = cursorPresent && (cursorDist < 160 || cursorSpeed > 450);
    if (!disturbed) return decide('sleep');
    return decide('wander', startle(moods, cursorDist, 0.4), true);
  }
  if (cursorStillFor > 30 && (!cursorPresent || cursorDist > 300)) return decide('sleep');

  if (!cursorPresent) return decide('wander');
  if (cursorDist < personalSpace(moods.trust) + 30 && moods.trust > 0.72 && cursorSpeed < 70) {
    return decide('snuggle');
  }
  if (moods.curiosity > 0.45 && cursorDist < 480) return decide('curious');
  if (moods.trust > 0.55 && cursorDist < 620 && cursorSpeed > 25 && cursorSpeed < 430) {
    return decide('follow');
  }
  return decide('wander');
}
