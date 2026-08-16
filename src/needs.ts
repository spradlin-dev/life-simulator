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

// all rates are per second of sim time; a hidden tab pauses the loop, so a pip
// is only ever hungry or tired because of time actually spent together.
// tempo genes bend each drain — a 0.5 dial reproduces the original rates, so
// no two pips need keep the same hours
export function tickNeeds(needs: Needs, state: CritterState, speed: number, dt: number, genes: Genes): Needs {
  const asleep = state === 'sleep';
  const engaged = ENGAGING[state];
  const appetite = lerp(0.6, 1.4, genes.metabolism);
  const weariness = lerp(1.4, 0.6, genes.stamina);
  const boredom = lerp(0.6, 1.4, genes.playfulness);
  const delight = lerp(0.75, 1.25, genes.playfulness);
  return {
    food: clamp01(needs.food - (dt / 480) * appetite),
    rest: clamp01(asleep ? needs.rest + dt / 45 : needs.rest - (dt / 300) * (1 + speed / 300) * weariness),
    fun: clamp01(needs.fun + (engaged ? (dt / 25) * delight : -(dt / 360) * boredom)),
  };
}

export function eat(needs: Needs): Needs {
  return { ...needs, food: clamp01(needs.food + 0.4) };
}

// happiness is derived, never stored: met needs, amplified by trust, crushed by fear
export function happinessOf(needs: Needs, trust: number, fear: number): number {
  const met = NEED_FIELDS.reduce((sum, field) => sum + needs[field], 0) / NEED_FIELDS.length;
  return clamp01(met * lerp(0.6, 1.2, trust) * (1 - fear * 0.7));
}
