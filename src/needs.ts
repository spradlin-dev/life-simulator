import { clamp01, lerp } from './math.ts';
import type { CritterState } from './brain.ts';
import type { Genes } from './genes.ts';

export interface Needs {
  food: number;
  rest: number;
  fun: number;
}

export const FRESH_NEEDS: Needs = { food: 1, rest: 1, fun: 0.7 };

// every need, checked complete at compile time (save validation walks this list)
const NEED_FIELD_SET: Record<keyof Needs, true> = { food: true, rest: true, fun: true };
export const NEED_FIELDS = Object.keys(NEED_FIELD_SET) as readonly (keyof Needs)[];

// every state declares whether it counts as engaged play — adding a state
// without classifying it here is a build error
const ENGAGING: Record<CritterState, boolean> = {
  wander: false,
  curious: true,
  follow: true,
  flee: false,
  cower: false,
  snuggle: true,
  play: true,
  snack: true,
  sleep: false,
};

// a classic pip at its full wandering pace (60 px/s, the wander speed cap)
// empties a belly in the original 480s — the identity (1 + 60/600) / 528
// = 1/480 re-anchors the food economy now that movement burns belly too
const FOOD_DRAIN_S = 528;

// all rates are per second of sim time; a hidden tab pauses the loop, so a pip
// is only ever hungry or tired because of time actually spent together.
// tempo genes bend each drain — a 0.5 dial reproduces the original rates, so
// no two pips need keep the same hours. hungerScale and tirednessScale are
// the meadow dials (appetite, weariness): straight multipliers on the drains,
// 1 on an ordinary day, and neither touches sleep's recovery
export function tickNeeds(
  needs: Needs,
  state: CritterState,
  speed: number,
  dt: number,
  genes: Genes,
  hungerScale = 1,
  tirednessScale = 1,
): Needs {
  const asleep = state === 'sleep';
  const engaged = ENGAGING[state];
  const appetite = lerp(0.6, 1.4, genes.metabolism);
  const weariness = lerp(1.4, 0.6, genes.stamina);
  const boredom = lerp(0.6, 1.4, genes.playfulness);
  const delight = lerp(0.75, 1.25, genes.playfulness);
  // the cascade: a worn body plays half-heartedly, a brimming one overflows
  // (neutral at rest 0.5); an empty belly wears the body down faster, but
  // only once food actually runs low — above 0.35 nothing changes
  const verve = lerp(0.5, 1.5, needs.rest);
  const famished = lerp(1.75, 1, clamp01(needs.food / 0.35));
  return {
    food: clamp01(needs.food - (dt / FOOD_DRAIN_S) * (1 + speed / 600) * appetite * hungerScale),
    rest: clamp01(
      asleep
        ? needs.rest + dt / 45
        : needs.rest - (dt / 300) * (1 + speed / 300) * weariness * famished * tirednessScale,
    ),
    fun: clamp01(needs.fun + (engaged ? (dt / 25) * delight * verve : -(dt / 360) * boredom)),
  };
}

// potency is how well this body digests what it just ate (1 for the
// watcher's honey and for a signature-perfect enzyme); the little rest perk
// stays flat — rousing a collapsed pip is about the act of eating, not the
// calories extracted
export function eat(needs: Needs, potency = 1): Needs {
  return { ...needs, food: clamp01(needs.food + 0.4 * potency), rest: clamp01(needs.rest + 0.05) };
}

// happiness is derived, never stored: met needs, amplified by trust, crushed by fear
export function happinessOf(needs: Needs, trust: number, fear: number): number {
  const met = NEED_FIELDS.reduce((sum, field) => sum + needs[field], 0) / NEED_FIELDS.length;
  return clamp01(met * lerp(0.6, 1.2, trust) * (1 - fear * 0.7));
}
