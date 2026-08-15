import { clamp01, lerp } from './math.ts';
import type { Genes } from './genes.ts';

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

// how close it lets the watcher get; shrinks with trust, tighter for the bold
export function personalSpace(trust: number, genes: Genes): number {
  return lerp(120, 34, trust) * lerp(1.2, 0.8, genes.boldness);
}

export function startle(moods: Moods, genes: Genes, dist: number, strength: number): Moods {
  const nearness = Math.max(0, 1 - dist / 500);
  if (nearness === 0) return moods;
  const felt = strength * nearness * lerp(1.3, 0.7, genes.boldness);
  return {
    fear: clamp01(moods.fear + felt),
    trust: clamp01(moods.trust - 0.1 * felt),
    curiosity: clamp01(moods.curiosity * (1 - nearness)),
  };
}

// a click or tap is a knock on the glass: frightening up close, intriguing from afar
export function knock(moods: Moods, genes: Genes, dist: number, strength: number): Moods {
  const after = startle(moods, genes, dist, strength);
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

export function updateMoods(moods: Moods, genes: Genes, senses: Senses, dt: number): Moods {
  const { presence, dist, speed } = senses;
  const threat = menace(senses) * lerp(1.3, 0.7, genes.boldness);

  let fear = clamp01(moods.fear + threat * dt * 5);
  fear = clamp01(fear - dt * (0.1 + 0.15 * moods.trust));

  // a watcher sitting still nearby is interesting — even the fading ghost of one
  let curiosity: number;
  if (presence > 0 && dist < 480 && speed < 50 && fear < 0.2) {
    curiosity = clamp01(moods.curiosity + dt * 0.28 * presence * lerp(0.6, 1.4, genes.nosiness));
  } else {
    curiosity = clamp01(moods.curiosity - dt * 0.2);
  }

  // trust grows only while the watcher is mostly there — never from a faded ghost
  let trust = clamp01(moods.trust - threat * dt * 0.12);
  if (presence > 0.5 && dist < 180 && fear < 0.1 && speed < 160) {
    trust = clamp01(trust + dt * 0.015 * lerp(0.6, 1.4, genes.clinginess));
  }

  return { fear, curiosity, trust };
}

// The whole personality: a handful of if-statements, read top to bottom.
// Genes bend each threshold, so every individual draws its lines differently;
// a 0.5 gene sits exactly at the original tuning.
// The sleep→wake branch is the one place this also changes moods (the rude-awakening startle).
export function chooseState(current: CritterState, moods: Moods, genes: Genes, senses: Senses): Decision {
  const { presence, dist, speed, stillFor } = senses;
  const decide = (state: CritterState, next = moods, startled = false): Decision => ({
    state,
    moods: next,
    startled,
  });

  // this individual's character sheet
  const fleesAt = lerp(0.16, 0.4, genes.boldness);
  const cowersAt = lerp(0.65, 0.85, genes.boldness);
  const sleepsAfter = lerp(20, 40, genes.liveliness);
  const snugglesAt = lerp(0.82, 0.62, genes.clinginess);
  const followsAt = lerp(0.65, 0.45, genes.clinginess);
  const curiousAt = lerp(0.55, 0.35, genes.nosiness);

  if (moods.fear > cowersAt) return decide('cower');
  if (moods.fear > fleesAt) return decide('flee');

  if (current === 'sleep') {
    const disturbed = presence > 0.6 && (dist < 160 || speed > 450);
    if (!disturbed) return decide('sleep');
    return decide('wander', startle(moods, genes, dist, 0.4), true);
  }
  if (stillFor > sleepsAfter && (presence <= 0 || dist > 300)) return decide('sleep');

  if (presence <= 0) return decide('wander');
  if (dist < personalSpace(moods.trust, genes) + 30 && moods.trust > snugglesAt && speed < 70 && presence > 0.5) {
    return decide('snuggle');
  }
  if (moods.curiosity > curiousAt && dist < 480) return decide('curious');
  if (moods.trust > followsAt && dist < 620 && speed > 25 && speed < 430 && presence > 0.5) {
    return decide('follow');
  }
  return decide('wander');
}
