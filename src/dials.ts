// The meadow dials: player-set levers that bend how the whole world runs —
// its pace, its birth rate, how hungry and strange it is. Dials are
// preferences, not creatures, so they live under their own storage key and
// never touch the world save. Every multiplier dial is anchored so its fresh
// value IS the meadow exactly as tuned (the same midpoint law the genes obey).

export interface Dials {
  pace: number; // meadow-seconds per real second
  births: number; // multiplies the mitosis hazard
  wildness: number; // multiplies the copyist's tremble
  appetite: number; // multiplies belly drain
  weariness: number; // multiplies how fast awake bodies tire
  feeder: number; // multiplies the seed drift arriving from beyond the world
  longevity: number; // multiplies every lifespan
  strangeness: number; // drift generations a wander-in arrives with
}

export interface DialSpec {
  min: number;
  max: number;
  fresh: number;
  log: boolean; // the slider glides in octaves rather than steps
  whole: boolean; // the dial holds a count, not a multiplier
}

// ratcheted: a new dial fails the build until it declares its range here
export const DIAL_SPECS: Record<keyof Dials, DialSpec> = {
  pace: { min: 0.5, max: 4, fresh: 1, log: true, whole: false },
  births: { min: 0.25, max: 16, fresh: 1, log: true, whole: false },
  wildness: { min: 0.25, max: 4, fresh: 1, log: true, whole: false },
  appetite: { min: 0.25, max: 4, fresh: 1, log: true, whole: false },
  weariness: { min: 0.25, max: 4, fresh: 1, log: true, whole: false },
  feeder: { min: 0.25, max: 4, fresh: 1, log: true, whole: false },
  longevity: { min: 0.25, max: 4, fresh: 1, log: true, whole: false },
  strangeness: { min: 0, max: 60, fresh: 6, log: false, whole: true },
};

export const DIAL_FIELDS = Object.keys(DIAL_SPECS) as readonly (keyof Dials)[];

export function freshDials(): Dials {
  const dials = {} as Dials;
  for (const field of DIAL_FIELDS) dials[field] = DIAL_SPECS[field].fresh;
  return dials;
}

// strict about type, forgiving about value: a broken or missing dial returns
// to its fresh setting, a wild one clamps into range — never a crash
export function sanitizeDials(raw: unknown): Dials {
  const dials = freshDials();
  if (typeof raw !== 'object' || raw === null) return dials;
  const d = raw as Record<string, unknown>;
  for (const field of DIAL_FIELDS) {
    const v = d[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const spec = DIAL_SPECS[field];
    const clamped = Math.min(spec.max, Math.max(spec.min, v));
    dials[field] = spec.whole ? Math.round(clamped) : clamped;
  }
  return dials;
}

const KEY = 'pip-dials';

export function loadDials(): Dials {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? freshDials() : sanitizeDials(JSON.parse(raw));
  } catch {
    return freshDials();
  }
}

export function storeDials(dials: Dials): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(dials));
  } catch {
    // storage unavailable — the dials just live for the session
  }
}
