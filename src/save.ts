import { clamp01 } from './math.ts';
import { GENE_FIELDS, sanitizeGenes, type Genes } from './genes.ts';

export interface SaveData {
  genes: Genes;
  trust: number;
}

const KEY = 'pip-save';

export function serialize(genes: Genes, trust: number): string {
  return JSON.stringify({ v: 1, genes, trust });
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
  // v1 is the only version today; future versions must MIGRATE old saves
  // (fill new fields with defaults) — a pip must never be lost to an upgrade
  if (d.v !== 1) return null;
  if (typeof d.genes !== 'object' || d.genes === null) return null;
  const g = d.genes as Record<string, unknown>;
  for (const field of GENE_FIELDS) {
    const value = g[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  }
  if (typeof d.trust !== 'number' || !Number.isFinite(d.trust)) return null;
  return {
    genes: sanitizeGenes(d.genes as unknown as Genes),
    trust: clamp01(d.trust),
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

export function storeSave(genes: Genes, trust: number): void {
  try {
    localStorage.setItem(KEY, serialize(genes, trust));
  } catch {
    // storage unavailable (private mode, quota) — the pip just lives for the session
  }
}
