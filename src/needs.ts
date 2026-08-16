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
  snack: true,
  sleep: false,
};

// seconds for a classic pip's full belly to empty
const FOOD_DRAIN_S = 480;

// all rates are per second of sim time; a hidden tab pauses the loop, so a pip
// is only ever hungry or tired because of time actually spent together.
// tempo genes bend each drain — a 0.5 dial reproduces the original rates, so
// no two pips need keep the same hours. famine is the ?famine dev knob: a
// straight multiplier on belly drain, 1 in real play
export function tickNeeds(
  needs: Needs,
  state: CritterState,
  speed: number,
  dt: number,
  genes: Genes,
  famine = 1,
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
    food: clamp01(needs.food - (dt / FOOD_DRAIN_S) * appetite * famine),
    rest: clamp01(
      asleep ? needs.rest + dt / 45 : needs.rest - (dt / 300) * (1 + speed / 300) * weariness * famished,
    ),
    fun: clamp01(needs.fun + (engaged ? (dt / 25) * delight * verve : -(dt / 360) * boredom)),
  };
}

export function eat(needs: Needs): Needs {
  // a snack also perks the body a little — enough to rouse a collapsed pip
  return { ...needs, food: clamp01(needs.food + 0.4), rest: clamp01(needs.rest + 0.05) };
}

// happiness is derived, never stored: met needs, amplified by trust, crushed by fear
export function happinessOf(needs: Needs, trust: number, fear: number): number {
  const met = NEED_FIELDS.reduce((sum, field) => sum + needs[field], 0) / NEED_FIELDS.length;
  return clamp01(met * lerp(0.6, 1.2, trust) * (1 - fear * 0.7));
}
