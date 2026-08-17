import { lerp } from './math.ts';
import type { Genes } from './genes.ts';

// a pip's whole life, in meadow-seconds, bent by the rate of living: a high
// metabolism burns bright and brief, a slow one lingers. The midpoint IS the
// base lifespan, so the classic pip lives exactly LIFESPAN_S
export const LIFESPAN_S = 3600;
export function lifespanOf(genes: Genes): number {
  return LIFESPAN_S * lerp(1.15, 0.85, genes.metabolism);
}

// how deep into old age a pip is: 0 through most of life, then a long,
// legible climb to 1 at the very end — the silver, the bun, the glasses are
// all warning, never surprise
export const ELDER_AT = 0.72;
export function eldernessOf(age: number, lifespan: number): number {
  if (lifespan <= 0) return 1;
  return Math.min(1, Math.max(0, (age / lifespan - ELDER_AT) / (1 - ELDER_AT)));
}
