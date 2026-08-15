import { clamp01 } from './math.ts';
import { GENE_FIELDS, sanitizeGenes, type Genes } from './genes.ts';
import { FRESH_NEEDS, NEED_FIELDS, type Needs } from './needs.ts';

export interface SaveData {
  genes: Genes;
  trust: number;
  needs: Needs;
  pos: { x: number; y: number } | null;
}

const KEY = 'pip-save';

export function serialize(
  genes: Genes,
  trust: number,
  needs: Needs,
  pos: { x: number; y: number },
): string {
  return JSON.stringify({ v: 2, genes, trust, needs, pos });
}

function allFiniteNumbers(obj: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(
    (field) => typeof obj[field] === 'number' && Number.isFinite(obj[field] as number),
  );
}

// strict about shape, forgiving about values: a tampered save yields a clamped
// pip, a broken or future-versioned one yields null (fresh start), never a crash
export function parseSave(raw: string): SaveData | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  // known versions migrate forward (v1 predates needs); unknown versions reject.
  // future versions must keep MIGRATING old saves — a pip must never be lost to an upgrade
  if (d.v !== 1 && d.v !== 2) return null;
  if (typeof d.genes !== 'object' || d.genes === null) return null;
  const g = d.genes as Record<string, unknown>;
  if (!allFiniteNumbers(g, GENE_FIELDS)) return null;
  if (typeof d.trust !== 'number' || !Number.isFinite(d.trust)) return null;

  let needs: Needs = { ...FRESH_NEEDS };
  let pos: { x: number; y: number } | null = null;
  if (d.v === 2) {
    if (typeof d.needs !== 'object' || d.needs === null) return null;
    const n = d.needs as Record<string, unknown>;
    if (!allFiniteNumbers(n, NEED_FIELDS)) return null;
    const stored = d.needs as unknown as Needs;
    needs = { food: clamp01(stored.food), rest: clamp01(stored.rest), fun: clamp01(stored.fun) };
    // position is viewport-dependent, so it is validated but not range-clamped here;
    // the restore path clamps into whatever viewport the pip wakes up in
    if (typeof d.pos !== 'object' || d.pos === null) return null;
    const p = d.pos as Record<string, unknown>;
    if (!allFiniteNumbers(p, ['x', 'y'])) return null;
    pos = { x: p.x as number, y: p.y as number };
  }

  return {
    genes: sanitizeGenes(d.genes as unknown as Genes),
    trust: clamp01(d.trust),
    needs,
    pos,
  };
}

export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? null : parseSave(raw);
  } catch {
    return null;
  }
}

export function storeSave(
  genes: Genes,
  trust: number,
  needs: Needs,
  pos: { x: number; y: number },
): void {
  try {
    localStorage.setItem(KEY, serialize(genes, trust, needs, pos));
  } catch {
    // storage unavailable (private mode, quota) — the pip just lives for the session
  }
}
