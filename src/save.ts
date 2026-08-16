import { clamp01 } from './math.ts';
import { GENE_FIELDS, sanitizeGenes, type Genes } from './genes.ts';
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
  trust: number;
  needs: Needs;
  pos: { x: number; y: number };
  disp: Dispositions;
  places: readonly number[];
  generation: number;
  name: string;
}

export interface PipSave {
  genes: Genes;
  trust: number;
  needs: Needs;
  pos: { x: number; y: number } | null;
  disp: Dispositions;
  places: number[];
  generation: number;
  name: string;
}

export interface WorldSave {
  pips: PipSave[];
}

const KEY = 'pip-save';
// one ceiling for both the save file and the live population (main.ts gates
// births on it): sharing the constant means the writer can never outgrow the
// reader, and a tampered file can't resurrect a million pips
export const MAX_SAVED_PIPS = 24;

export function serialize(pips: readonly LivePip[]): string {
  // the writer must never emit a roster its own reader would reject
  return JSON.stringify({ v: 6, pips: pips.slice(0, MAX_SAVED_PIPS) });
}

function allFiniteNumbers(obj: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(
    (field) => typeof obj[field] === 'number' && Number.isFinite(obj[field] as number),
  );
}

// the shared per-pip core: genes + trust, present in every version
// (saves written before a gene existed get its midpoint — a 0.5 dial IS the
// classic pip, so old friends come back looking exactly like themselves)
function parseCore(
  d: Record<string, unknown>,
  fillLegacyGenes: boolean,
): { genes: Genes; trust: number } | null {
  if (typeof d.genes !== 'object' || d.genes === null) return null;
  let g = d.genes as Record<string, unknown>;
  if (fillLegacyGenes) {
    const filled: Record<string, unknown> = { ...g };
    for (const field of GENE_FIELDS) {
      if (filled[field] === undefined) filled[field] = 0.5;
    }
    g = filled;
  }
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
function parseFullPip(
  entry: unknown,
  fillLegacyGenes: boolean,
): Omit<PipSave, 'generation' | 'name'> | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const d = entry as Record<string, unknown>;
  const core = parseCore(d, fillLegacyGenes);
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
  // roster, v4 the lineage, v5 names and looks); future versions must keep
  // MIGRATING — a pip must never be lost
  if (d.v === 6 || d.v === 5 || d.v === 4) {
    if (!Array.isArray(d.pips) || d.pips.length < 1 || d.pips.length > MAX_SAVED_PIPS) return null;
    const pips: PipSave[] = [];
    for (const entry of d.pips) {
      const pip = parseFullPip(entry, d.v !== 6);
      if (!pip) return null;
      let generation = 0;
      if (d.v !== 4) {
        const g = (entry as Record<string, unknown>).generation;
        if (typeof g !== 'number' || !Number.isFinite(g)) return null;
        generation = Math.min(9999, Math.max(0, Math.floor(g)));
      }
      // names are cosmetic: older saves and mangled entries get a fresh one
      const name = d.v === 6 ? sanitizeName((entry as Record<string, unknown>).name) : makeName();
      pips.push({ ...pip, generation, name });
    }
    return { pips };
  }
  if (d.v !== 1 && d.v !== 2 && d.v !== 3) return null;

  const core = parseCore(d, true);
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
  return { pips: [{ ...core, needs, pos, disp, places, generation: 0, name: makeName() }] };
}

export function loadSave(): WorldSave | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? null : parseSave(raw);
  } catch {
    return null;
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage unavailable — nothing to clear
  }
}

export function storeSave(pips: readonly LivePip[]): void {
  try {
    localStorage.setItem(KEY, serialize(pips));
  } catch {
    // storage unavailable (private mode, quota) — the pips just live for the session
  }
}
