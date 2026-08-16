import { clamp01 } from './math.ts';
import { copyStrand, decode } from './dna.ts';
import type { Genes } from './genes.ts';
import type { Needs } from './needs.ts';

// how often a blissful pip divides: expected once per 10 minutes at happiness 1.
// The births dial multiplies this
export const SPLIT_MAX_RATE = 1 / 600;
// seconds to FULL readiness after a division; recovery is a smooth ramp, never a cliff
export const SPLIT_COOLDOWN = 90;

// probability of dividing during this tick — a hazard rate, not a timer.
// happiness^4 makes it super-linear: misery never splits, bliss often does.
// recovery since the last division scales the rate continuously — with no
// eligibility moment to share, a flock can never phase-lock into waves
export function splitChance(happiness: number, sinceSplit: number, dt: number, births = 1): number {
  const readiness = Math.min(1, Math.max(0, sinceSplit) / SPLIT_COOLDOWN) ** 2;
  return Math.min(1, SPLIT_MAX_RATE * births * clamp01(happiness) ** 4 * readiness * dt);
}

// what the split conserves; lifetime scars are deliberately absent — a
// division is a fresh start, and only the genome carries forward
export interface PipCore {
  genes: Genes;
  strand: string;
  needs: Needs;
  generation: number;
}

// one pip becomes two: each daughter's strand is copied by the trembling
// copyist against the comfort the parent felt across the swell, and her
// stats are read fresh from it — heredity IS the genome, so the parent's
// genes are not even accepted here — and the meal that fueled the division
// is shared between them. Both daughters ride the same trace: sisters of a
// warm moment share correlated wildness
export function splitOutcome(
  core: Omit<PipCore, 'genes'>,
  comfort: readonly number[],
  rand: () => number = Math.random,
  wildness = 1,
): [PipCore, PipCore] {
  const daughter = (): PipCore => {
    const strand = copyStrand(core.strand, comfort, rand, wildness);
    return {
      genes: decode(strand),
      strand,
      needs: { ...core.needs, food: core.needs.food * 0.5 },
      generation: core.generation + 1,
    };
  };
  return [daughter(), daughter()];
}
