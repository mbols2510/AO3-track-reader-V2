import type { WorkChapter } from './types.ts';

/**
 * Location encoding (unchanged from the original so synced positions stay valid):
 *   start of chapter        -> 0
 *   end of chapter          -> null
 *   start of paragraph p    -> p * 1_000_000_000
 *   part-way through p      -> p * 1_000_000_000 + frac * 479_001_600   (frac in [0,1))
 *   end of paragraph p      -> p * 1_000_000_000 + 500_000_000
 */
export const LOC_PARA_MULTIPLIER = 1_000_000_000;
export const LOC_PARA_BOTTOM = 500_000_000;
export const LOC_PARA_FRAC_MULTIPLIER = 479_001_600;

type Comparable = Pick<WorkChapter, 'number' | 'location'> & { seq: number | null };

/** True when `next` is strictly further along than `cur`. */
export function isAhead(cur: Comparable, next: Comparable): boolean {
  if (next.seq !== null && next.seq !== undefined) {
    if (next.seq > (cur.seq ?? 0)) return true;
    if (next.seq < (cur.seq ?? 0)) return false;
  }
  if (next.number > cur.number) return true;
  if (next.number < cur.number) return false;
  if (cur.location === null) return false;
  if (next.location === null) return true;
  return next.location > cur.location;
}

/** True when `next` is at least as far along as `cur`. */
export function isAheadOrEqual(cur: Comparable, next: Comparable): boolean {
  if (next.seq !== null && next.seq !== undefined) {
    if (next.seq > (cur.seq ?? 0)) return true;
    if (next.seq < (cur.seq ?? 0)) return false;
  }
  if (next.number > cur.number) return true;
  if (next.number < cur.number) return false;
  if (next.location === null) return true;
  if (cur.location === null) return false;
  return next.location >= cur.location;
}

/** Chapters fully read, as shown on blurbs ("3/10"). */
export function chaptersFinished(wc: Pick<WorkChapter, 'number' | 'location'>): number {
  return wc.location === null ? wc.number : wc.number - 1;
}

/** Percentage through the current paragraph, 0..100 (for display). */
export function paragraphPercent(location: number | null): number {
  if (location === null) return 100;
  const offset = location % LOC_PARA_MULTIPLIER;
  if (offset === LOC_PARA_BOTTOM) return 100;
  return Math.floor((offset * 100) / LOC_PARA_FRAC_MULTIPLIER);
}
