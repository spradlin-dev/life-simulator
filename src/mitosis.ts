import { clamp01 } from './math.ts';
import { decode, mutateGenome } from './dna.ts';
import type { Genes } from './genes.ts';
import type { Needs } from './needs.ts';

// how often a blissful pip divides: expected once per 10 minutes at happiness 1.
// ?fecund=N multiplies this for mutation review on a live tab
export const SPLIT_MAX_RATE = 1 / 600;
// seconds to FULL readiness after a division; recovery is a smooth ramp, never a cliff
export const SPLIT_COOLDOWN = 90;

// probability of dividing during this tick — a hazard rate, not a timer.
// happiness^4 makes it super-linear: misery never splits, bliss often does.
// recovery since the last division scales the rate continuously — with no
// eligibility moment to share, a flock can never phase-lock into waves
export function splitChance(happiness: number, sinceSplit: number, dt: number, fecund = 1): number {
  const readiness = Math.min(1, Math.max(0, sinceSplit) / SPLIT_COOLDOWN) ** 2;
  return Math.min(1, SPLIT_MAX_RATE * fecund * clamp01(happiness) ** 4 * readiness * dt);
}

// what the split conserves; lifetime scars are deliberately absent — a
// division is a fresh start, and only the genome carries forward
export interface PipCore {
  genes: Genes;
  strand: string;
  needs: Needs;
  generation: number;
}

// one pip becomes two: each daughter's strand drifts independently from the
// parent's and her stats are read fresh from it — heredity IS the genome, so
// the parent's genes are not even accepted here — and the meal that fueled
// the division is shared between them
export function splitOutcome(
  core: Omit<PipCore, 'genes'>,
  rand: () => number = Math.random,
): [PipCore, PipCore] {
  const daughter = (): PipCore => {
    const strand = mutateGenome(core.strand, rand);
    return {
      genes: decode(strand),
      strand,
      needs: { ...core.needs, food: core.needs.food * 0.5 },
      generation: core.generation + 1,
    };
  };
  return [daughter(), daughter()];
}
