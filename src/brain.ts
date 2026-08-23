import { clamp01, lerp } from './math.ts';
import type { Genes } from './genes.ts';
import type { Needs } from './needs.ts';

export type CritterState =
  | 'wander'
  | 'curious'
  | 'follow'
  | 'flee'
  | 'cower'
  | 'snuggle'
  | 'play'
  | 'snack'
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
  treatDist: number; // Infinity when no treat is down
  place: number; // memory of the ground it stands on: -1 dreaded … +1 beloved
  alarm: number; // 0..1 panic radiating from nearby fleeing pips — fear is contagious
  torpor: number; // 0 hale … 1 at the end of a hunger fade — how far gone the body is
  friendDist: number; // nearest calm flockmate; Infinity in an empty or frightened meadow
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
  const { presence, dist, speed, stillFor, place, alarm } = senses;
  const threat = menace(senses) * lerp(1.3, 0.7, genes.boldness);
  const dreadHere = Math.max(0, -place);
  const comfortHere = Math.max(0, place);

  const felt = alarm * lerp(1.3, 0.7, genes.boldness);
  let fear = clamp01(moods.fear + threat * dt * 5 + felt * dt * 1.2);
  // beloved ground soothes: fear drains faster on it
  fear = clamp01(fear - dt * (0.1 + 0.15 * moods.trust + comfortHere * 0.1));
  // dreaded ground drags fear up toward a floor — deep memories push past the
  // flee threshold, so the place itself repels. the coefficient clamp keeps
  // this a convex step for ANY dt, so dread can never overshoot its floor
  fear = clamp01(fear + Math.max(0, dreadHere * 0.6 - fear) * Math.min(1, dt * 0.6));

  // a watcher sitting still nearby is interesting — even the fading ghost of one —
  // but a statue that never moves at all fades from attention (a parked cursor
  // at the screen edge must not farm curiosity or trust)
  let curiosity: number;
  if (presence > 0 && dist < 480 && speed < 50 && fear < 0.2 && stillFor < 20) {
    curiosity = clamp01(moods.curiosity + dt * 0.28 * presence * lerp(0.6, 1.4, genes.nosiness));
  } else {
    curiosity = clamp01(moods.curiosity - dt * 0.2);
  }

  // trust grows only while the watcher is mostly there — never from a faded ghost
  let trust = clamp01(moods.trust - threat * dt * 0.12);
  if (presence > 0.5 && dist < 180 && fear < 0.1 && speed < 160 && stillFor < 20) {
    trust = clamp01(trust + dt * 0.015 * lerp(0.6, 1.4, genes.clinginess));
  }

  return { fear, curiosity, trust };
}

// a classic antenna's base sniff range: the antLength reach scales it,
// hunger stretches it, torpor closes it
const NOSE_REACH = 480;

// The whole personality: a handful of if-statements, read top to bottom.
// Genes bend each threshold, so every individual draws its lines differently;
// a 0.5 gene sits exactly at the original tuning.
// The sleep→wake branch is the one place this also changes moods (the rude-awakening startle).
export function chooseState(
  current: CritterState,
  moods: Moods,
  needs: Needs,
  genes: Genes,
  senses: Senses,
  // the world's promise under every rescue (see laws.ts); the meadow's
  // bedside 120 is the default world, the lab passes 0
  rescueFloor = 120,
): Decision {
  const { presence, dist, speed, stillFor, treatDist, torpor, friendDist } = senses;
  const decide = (state: CritterState, next = moods, startled = false): Decision => ({
    state,
    moods: next,
    startled,
  });

  // this individual's character sheet (an empty belly makes anyone braver)
  const fleesAt = lerp(0.16, 0.4, genes.boldness) + (1 - needs.food) * 0.06;
  const cowersAt = lerp(0.65, 0.85, genes.boldness);
  const sleepsAfter = lerp(20, 40, genes.liveliness);
  const snugglesAt = lerp(0.82, 0.62, genes.clinginess);
  const followsAt = lerp(0.65, 0.45, genes.clinginess);
  const curiousAt = lerp(0.55, 0.35, genes.nosiness);
  // the antennae are the nose: length sets how far berries register
  const reach = lerp(0.7, 1.3, genes.antLength);

  if (moods.fear > cowersAt) return decide('cower');
  if (moods.fear > fleesAt) return decide('flee');

  const starving = needs.food <= 0;
  if (current === 'sleep') {
    // torpor shrinks a collapsed body's rousable reach toward its own face;
    // the world's rescueFloor is the promise beneath it — the meadow holds a
    // bedside 120 to the very end, the lab holds nothing, so there the point
    // of no return arrives when the reach closes, never by decree
    if (starving && treatDist < Math.max(rescueFloor, NOSE_REACH * reach * (1 - torpor))) return decide('snack');
    // hunger pangs wake a sleeper with real strength left; a collapsed body
    // stays down until it has clawed some back, so the end-game reads as slow
    // stagger-and-fall, not flicker
    if (starving && needs.rest >= 0.4) return decide('wander');
    // a genuinely hungry (but not collapsed) sleeper wakes for food within
    // easy reach, so a fed meadow grazes in gentle cycles instead of sleeping
    // into starvation; the collapsed keep their close-reach rescue rule above
    if (!starving && needs.food < 0.3 && treatDist < NOSE_REACH * reach) return decide('snack');
    // exhausted sleep is deep sleep: proximity can't break it (a real scare
    // still does — the fear checks above outrank sleep entirely). A collapsed
    // starving pip can't be nudged awake at all: a rescuer hovering close
    // must never startle-flicker the pip they are trying to save
    const disturbed =
      !starving && needs.rest >= 0.15 && presence > 0.6 && (dist < 160 || speed > 450);
    if (disturbed) return decide('wander', startle(moods, genes, dist, 0.4), true);
    // rested pips only get up if something is happening; an alone pip sleeps on
    if (needs.rest > 0.95 && stillFor <= sleepsAfter) return decide('wander');
    return decide('sleep');
  }
  // a starving pip cannot settle into sleep, however tired — it stays
  // desperately awake until the body simply gives out. And EVERY sleep pull
  // waits for a bite in progress: interrupting the chew resets it each tick,
  // which deadlocked rescue at zero rest and flickered grazers into
  // starvation while they looked busy eating
  const midBite = current === 'snack';
  // the meadow entertains itself: a bored pip romps with a calm flockmate,
  // a romp underway runs until joy is genuinely topped up (the wide exit
  // stops flicker at the boredom line), and the starving never romp — the
  // endgame stays a slow stagger, never a dance
  const rompOn =
    !starving &&
    ((current === 'play' && needs.fun < 0.8 && friendDist < 300) ||
      (needs.fun < 0.45 && friendDist < 240));
  if (needs.rest <= 0 && !midBite) return decide('sleep');
  if (!starving && needs.rest < 0.15 && !midBite) return decide('sleep');
  // hunger sharpens the nose: notice starts at a classic antenna's base
  // reach and stretches as the belly empties. This check sits ABOVE the
  // idle pull on purpose — a peckish body eats before it naps and before
  // it dances, or an unattended romp could waltz a pip straight past the
  // berry that would have kept the music going
  const noticeRange = lerp(NOSE_REACH, 700, clamp01((0.85 - needs.food) / 0.85)) * reach;
  if (treatDist < noticeRange && needs.food < 0.85) return decide('snack');

  // the idle nap yields to a friend in reach: the flock is company even
  // when the hand has been gone for hours
  if (!starving && !midBite && stillFor > sleepsAfter && (presence <= 0 || dist > 300)) {
    return decide(rompOn ? 'play' : 'sleep');
  }

  // the romp never outranks the watcher's own games below: attention is
  // the extra, and the flock is what remains when the hand is elsewhere
  if (presence <= 0) return decide(rompOn ? 'play' : 'wander');
  if (dist < personalSpace(moods.trust, genes) + 30 && moods.trust > snugglesAt && speed < 70 && presence > 0.5) {
    return decide('snuggle');
  }
  if (moods.curiosity > curiousAt && dist < 480) return decide('curious');
  if (moods.trust > followsAt && dist < 620 && speed > 25 && speed < 430 && presence > 0.5) {
    return decide('follow');
  }
  return decide(rompOn ? 'play' : 'wander');
}
