import { clamp01 } from './math.ts';
import { dietOf, GENE_FIELDS, sanitizeGenes, type BerryKind, type Genes } from './genes.ts';
import {
  DECODER_VERSION,
  encode,
  forceAppendGrant,
  isValidStrand,
  needsEnzymeGrant,
  STRAND_MAX,
  tryAppendGrant,
} from './dna.ts';
import { makeName, sanitizeName } from './names.ts';
import { FRESH_NEEDS, NEED_FIELDS, type Needs } from './needs.ts';
import {
  clampPlace,
  DISP_FIELDS,
  FRESH_DISPOSITIONS,
  freshPlaces,
  PLACE_CELLS,
  type Dispositions,
} from './dispositions.ts';

// one pip, as the running game hands it to the save layer
export interface LivePip {
  genes: Genes;
  strand: string;
  trust: number;
  needs: Needs;
  pos: { x: number; y: number };
  disp: Dispositions;
  places: readonly number[];
  generation: number;
  name: string;
  age: number;
}

export interface PipSave {
  genes: Genes;
  strand: string;
  trust: number;
  needs: Needs;
  pos: { x: number; y: number } | null;
  disp: Dispositions;
  places: number[];
  generation: number;
  name: string;
  age: number;
}

export interface WorldSave {
  pips: PipSave[];
  // the ground itself: ambient berries and growing sprouts. null marks a
  // pre-flora save — the game warm-starts a settled meadow instead
  flora: FloraSave[] | null;
}

export interface FloraSave {
  kind: BerryKind; // ambient colors only — a gift is never flora
  x: number;
  y: number;
  age: number;
  sprout: boolean;
}

// one storage slot per world: the meadow is the real game, the terrarium is
// the sandbox. The keys live here so no other module can invent a third
// world or point one world's writer at the other's slot
export const SAVE_KEYS = { meadow: 'pip-save', terrarium: 'pip-terrarium' } as const;
export type SaveKey = (typeof SAVE_KEYS)[keyof typeof SAVE_KEYS];
// one ceiling for both the save file and the live population (main.ts gates
// births on it): sharing the constant means the writer can never outgrow the
// reader, and a tampered file can't resurrect a million pips. Since the food
// economy became the real population limit this sits far above any reachable
// flock — it is a tamper belt, not a gameplay wall
export const MAX_SAVED_PIPS = 3000;
// tamper belt for the ground: real meadows hold a few hundred plants at most
export const MAX_FLORA = 1000;

export function serialize(pips: readonly LivePip[], flora: readonly FloraSave[] = []): string {
  // the writer must never emit a roster its own reader would reject
  return JSON.stringify({
    v: 13,
    decoder: DECODER_VERSION,
    pips: pips.slice(0, MAX_SAVED_PIPS),
    flora: flora.slice(0, MAX_FLORA),
  });
}

const BERRY_KIND_SET: Record<BerryKind, true> = { red: true, gold: true, blue: true };

// the ground is forgiving where pips are strict: flora regrows, so a bad
// entry is dropped rather than sinking the save it rode in on
function parseFlora(raw: unknown): FloraSave[] {
  if (!Array.isArray(raw)) return [];
  const out: FloraSave[] = [];
  for (const e of raw.slice(0, MAX_FLORA)) {
    if (typeof e !== 'object' || e === null) continue;
    const f = e as Record<string, unknown>;
    if (typeof f.kind !== 'string' || !(f.kind in BERRY_KIND_SET)) continue;
    if (typeof f.x !== 'number' || !Number.isFinite(f.x)) continue;
    if (typeof f.y !== 'number' || !Number.isFinite(f.y)) continue;
    if (typeof f.age !== 'number' || !Number.isFinite(f.age)) continue;
    out.push({
      kind: f.kind as BerryKind,
      x: f.x,
      y: f.y,
      age: Math.min(600, Math.max(0, f.age)),
      sprout: f.sprout === true,
    });
  }
  return out;
}

function allFiniteNumbers(obj: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(
    (field) => typeof obj[field] === 'number' && Number.isFinite(obj[field] as number),
  );
}

// the shared per-pip core: genes + trust, present in every version. Any
// gene missing from the entry fills at its midpoint, whatever the version:
// a save is always older than the genes added after it was written, and a
// 0.5 dial IS the classic pip — old friends come back looking exactly like
// themselves, never rejected for predating a trait
function parseCore(d: Record<string, unknown>): { genes: Genes; trust: number } | null {
  if (typeof d.genes !== 'object' || d.genes === null) return null;
  const filled: Record<string, unknown> = { ...(d.genes as Record<string, unknown>) };
  for (const field of GENE_FIELDS) {
    if (filled[field] === undefined) filled[field] = 0.5;
  }
  const g = filled;
  if (!allFiniteNumbers(g, GENE_FIELDS)) return null;
  if (typeof d.trust !== 'number' || !Number.isFinite(d.trust)) return null;
  return { genes: sanitizeGenes(g as unknown as Genes), trust: clamp01(d.trust) };
}

function parseNeedsAndPos(
  d: Record<string, unknown>,
): { needs: Needs; pos: { x: number; y: number } } | null {
  if (typeof d.needs !== 'object' || d.needs === null) return null;
  const n = d.needs as Record<string, unknown>;
  if (!allFiniteNumbers(n, NEED_FIELDS)) return null;
  const stored = d.needs as unknown as Needs;
  // position is viewport-dependent, so it is validated but not range-clamped here;
  // the restore path clamps into whatever viewport the pip wakes up in
  if (typeof d.pos !== 'object' || d.pos === null) return null;
  const p = d.pos as Record<string, unknown>;
  if (!allFiniteNumbers(p, ['x', 'y'])) return null;
  return {
    needs: { food: clamp01(stored.food), rest: clamp01(stored.rest), fun: clamp01(stored.fun) },
    pos: { x: p.x as number, y: p.y as number },
  };
}

function parseMemories(
  d: Record<string, unknown>,
): { disp: Dispositions; places: number[] } | null {
  if (typeof d.disp !== 'object' || d.disp === null) return null;
  const dd = d.disp as Record<string, unknown>;
  if (!allFiniteNumbers(dd, DISP_FIELDS)) return null;
  const stored = d.disp as unknown as Dispositions;
  if (!Array.isArray(d.places) || d.places.length !== PLACE_CELLS) return null;
  if (!d.places.every((cell) => typeof cell === 'number' && Number.isFinite(cell))) return null;
  return {
    disp: { wariness: clamp01(stored.wariness), attachment: clamp01(stored.attachment) },
    places: (d.places as number[]).map(clampPlace),
  };
}

// a complete modern pip entry (roster entries carry every structural field;
// generation and name are versioned separately)
function parseFullPip(entry: unknown): Omit<PipSave, 'generation' | 'name' | 'strand' | 'age'> | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const d = entry as Record<string, unknown>;
  const core = parseCore(d);
  if (!core) return null;
  const np = parseNeedsAndPos(d);
  if (!np) return null;
  const mem = parseMemories(d);
  if (!mem) return null;
  return { ...core, ...np, ...mem };
}

// strict about shape, forgiving about values: a tampered save yields clamped
// pips, a broken or future-versioned one yields null (fresh start), never a crash
export function parseSave(raw: string): WorldSave | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  // known versions migrate forward (v1 predates needs/pos, v2 memories, v3 the
  // roster, v4 the lineage, v5 names and looks, v6 the tempo genes, v7 the
  // genome, v8 the feeder lock, v9 stored the lock, v10 retired it, v11 the
  // age, v12 the ground, v13 the enzyme grant); future versions must keep
  // MIGRATING — a pip must never be lost
  if (d.v === 13 || d.v === 12 || d.v === 11 || d.v === 10 || d.v === 9 || d.v === 8 || d.v === 7 || d.v === 6 || d.v === 5 || d.v === 4) {
    // an empty flock is a legal world: the terrarium's extinctions must
    // survive the reload (the meadow's laws reseed an empty boot instead)
    if (!Array.isArray(d.pips) || d.pips.length > MAX_SAVED_PIPS) return null;
    const pips: PipSave[] = [];
    for (const entry of d.pips) {
      const pip = parseFullPip(entry);
      if (!pip) return null;
      let generation = 0;
      if (d.v !== 4) {
        const g = (entry as Record<string, unknown>).generation;
        if (typeof g !== 'number' || !Number.isFinite(g)) return null;
        generation = Math.min(9999, Math.max(0, Math.floor(g)));
      }
      // names are cosmetic: older saves and mangled entries get a fresh one
      const name = d.v >= 6 ? sanitizeName((entry as Record<string, unknown>).name) : makeName();
      // a healthy same-decoder strand is kept verbatim (it carries junk DNA and
      // lineage structure no re-encode could recover); anything else — older
      // saves, mangled strands, foreign decoder versions — is respelled from
      // the cached stats, so the pip itself never changes and is never lost
      const raw = (entry as Record<string, unknown>).strand;
      const verbatim =
        d.v >= 8 && d.decoder === DECODER_VERSION && isValidStrand(raw) ? raw : null;
      let strand = verbatim ?? encode(pip.genes);
      // the enzyme-era grant: every pre-enzyme save gets one, and so does
      // any strand this migration had to respell from stats — a rebuild can
      // never carry enzymes, whatever its version, and losing them to the
      // MACHINERY is not losing them to evolution. Enzyme-era strands are
      // otherwise honored as they lie: what evolution lost, no reload wins
      // back. When the tail forbids a clean join (a loaded tag, no room),
      // the strand is respelled — decode-exact either way; junk pays there
      if ((d.v <= 12 || verbatim === null) && needsEnzymeGrant(strand)) {
        const kind = dietOf(pip.genes);
        const joined = strand.length + 36 <= STRAND_MAX ? tryAppendGrant(strand, kind) : null;
        strand = joined ?? tryAppendGrant(encode(pip.genes), kind) ?? forceAppendGrant(encode(pip.genes), kind);
      }
      // age arrived in v11; older saves and mangled values get a scattered
      // midlife jitter so a migrated flock never ages out in one wave
      const rawAge = (entry as Record<string, unknown>).age;
      const age =
        d.v >= 11 && typeof rawAge === 'number' && Number.isFinite(rawAge) && rawAge >= 0
          ? rawAge
          : Math.random() * 1440;
      pips.push({ ...pip, strand, generation, name, age });
    }
    // v9's feeder lock is retired: whatever a save says about it is ignored
    // flora arrived in v12; older worlds get null and a warm-started ground
    return { pips, flora: d.v >= 12 ? parseFlora(d.flora) : null };
  }
  if (d.v !== 1 && d.v !== 2 && d.v !== 3) return null;

  const core = parseCore(d);
  if (!core) return null;
  let needs: Needs = { ...FRESH_NEEDS };
  let pos: { x: number; y: number } | null = null;
  if (d.v !== 1) {
    const np = parseNeedsAndPos(d);
    if (!np) return null;
    needs = np.needs;
    pos = np.pos;
  }
  let disp: Dispositions = { ...FRESH_DISPOSITIONS };
  let places: number[] = freshPlaces();
  if (d.v === 3) {
    const mem = parseMemories(d);
    if (!mem) return null;
    disp = mem.disp;
    places = mem.places;
  }
  return {
    pips: [
      {
        ...core,
        // the ancient branch predates enzymes by definition: grant here too
        strand:
          tryAppendGrant(encode(core.genes), dietOf(core.genes)) ??
          forceAppendGrant(encode(core.genes), dietOf(core.genes)),
        needs,
        pos,
        disp,
        places,
        generation: 0,
        name: makeName(),
        age: Math.random() * 1440,
      },
    ],
    flora: null,
  };
}

export function loadSave(key: SaveKey): WorldSave | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : parseSave(raw);
  } catch {
    return null;
  }
}

export function clearSave(key: SaveKey): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // storage unavailable — nothing to clear
  }
}

export function storeSave(pips: readonly LivePip[], key: SaveKey, flora: readonly FloraSave[] = []): void {
  try {
    localStorage.setItem(key, serialize(pips, flora));
  } catch {
    // storage unavailable (private mode, quota) — the pips just live for the session
  }
}
