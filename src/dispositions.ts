import { clamp01 } from './math.ts';
import type { Genes } from './genes.ts';

// the lifetime layer: moods pass in seconds, needs in minutes — dispositions
// are what a pip has LEARNED, and they outlive everything but the pip itself
export interface Dispositions {
  wariness: number; // accumulated terror; reads as timidity
  attachment: number; // accumulated devotion; reads as clinginess
}

export const FRESH_DISPOSITIONS: Dispositions = { wariness: 0, attachment: 0 };

// the boundary where wariness becomes visible ('wary') and where the
// forgiveness celebration fires — one constant so they can never desync
export const WARY_AT = 0.4;
// the happiness band where good times reshape a soul (learn) and where the
// player is told repair is underway (isHealing)
export const GOOD_TIMES_AT = 0.7;

// every disposition, checked complete at compile time (save validation walks this)
const DISP_FIELD_SET: Record<keyof Dispositions, true> = { wariness: true, attachment: true };
export const DISP_FIELDS = Object.keys(DISP_FIELD_SET) as readonly (keyof Dispositions)[];

// asymmetric on purpose: terror etches in seconds, healing takes minutes of
// good times; devotion builds across whole sessions and real fright damages it.
// the bands are deliberate too: fear 0.6-0.8 frightens without betraying, and
// a merely-okay life (happiness <= 0.7) reshapes nothing — ordinary days don't
// reshape a soul
export function learn(disp: Dispositions, fear: number, happiness: number, dt: number): Dispositions {
  let wariness = disp.wariness;
  if (fear > 0.6) wariness += (fear - 0.6) * dt * 0.02;
  else if (happiness > GOOD_TIMES_AT) wariness -= dt * 0.0008;
  let attachment = disp.attachment;
  if (fear > 0.8) attachment -= dt * 0.01;
  else if (happiness > GOOD_TIMES_AT) attachment += dt * 0.0015;
  return { wariness: clamp01(wariness), attachment: clamp01(attachment) };
}

// lived experience bends how the genome is expressed: the true genes are
// untouched (inheritance reads those), but behavior flows through these.
// deliberately reads only wariness/attachment — a future disposition must
// opt into expression here
export function effectiveGenes(genes: Genes, disp: Dispositions): Genes {
  return {
    ...genes,
    boldness: clamp01(genes.boldness - disp.wariness * 0.35),
    clinginess: clamp01(genes.clinginess + disp.attachment * 0.3),
  };
}

// true while good times are softening a VISIBLY wary pip — the display
// contract: 'healing' always appears beside the label it explains
export function isHealing(disp: Dispositions, happiness: number): boolean {
  return happiness > GOOD_TIMES_AT && disp.wariness > WARY_AT;
}

// ------------------------------------------------------------------ place memory
// a coarse, viewport-relative grid of what happened where: -1 dreaded … +1 beloved.
// counter-conditioning is plain arithmetic — warmth at a dreaded spot writes over it

export const PLACE_COLS = 6;
export const PLACE_ROWS = 4;
export const PLACE_CELLS = PLACE_COLS * PLACE_ROWS;

export const clampPlace = (v: number): number => Math.min(1, Math.max(-1, v));

export function freshPlaces(): number[] {
  return new Array<number>(PLACE_CELLS).fill(0);
}

function cellIndex(nx: number, ny: number): number {
  const col = Math.min(PLACE_COLS - 1, Math.max(0, Math.floor(nx * PLACE_COLS)));
  const row = Math.min(PLACE_ROWS - 1, Math.max(0, Math.floor(ny * PLACE_ROWS)));
  return row * PLACE_COLS + col;
}

export function placeAt(places: readonly number[], nx: number, ny: number): number {
  return places[cellIndex(nx, ny)] ?? 0;
}

export function markPlace(places: readonly number[], nx: number, ny: number, delta: number): number[] {
  const next = [...places];
  const i = cellIndex(nx, ny);
  next[i] = clampPlace(next[i] + delta);
  return next;
}

// unattended memories of both kinds dim toward neutral, very slowly — grudges
// and fondness alike need occasional renewal
export function fadePlaces(places: readonly number[], dt: number): number[] {
  return places.map((cell) => cell - Math.sign(cell) * Math.min(Math.abs(cell), dt * 0.0003));
}
