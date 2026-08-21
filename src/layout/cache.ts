import type { CharRun, LineInfo } from '../types/layout'

// Layout-side caches (ARCHITECTURE.md §4.2, docs/PARALLEL-PLAN.md B3).
// Both are owned by Agent B and live here instead of view state so relayout can
// prune and key them freely.

/** Per-paragraph measured style runs (char widths + prefix sums), keyed by paragraph index. */
export const runCache: { [para: number]: CharRun[] } = {}

/** A paragraph's laid-out lines, reusable when its inputs are unchanged. */
export interface ParaCacheEntry {
  version: number
  docWidth: number
  yStart: number
  page: number
  obstructionKey: string
  lines: LineInfo[]
  height: number
}

export const paraCache: { [para: number]: ParaCacheEntry } = {}

/**
 * Re-key both caches after a paragraph splice (model/dirty.ts): entries for
 * removed paragraphs are dropped, everything below moves by the delta. Applied
 * before a layout pass reads them — an entry left at a stale index hands a
 * paragraph the cached lines and character widths of a different one.
 */
export function shiftCaches(at: number, removed: number, inserted: number): void {
  const delta = inserted - removed
  for (const store of [paraCache, runCache] as Array<Record<number, any>>) {
    const keys = Object.keys(store)
      .map(Number)
      .filter((k) => k >= at)
      // Walk in the direction that always writes into a slot already vacated,
      // otherwise a move overwrites an entry that has not been moved yet.
      .sort((a, b) => (delta > 0 ? b - a : a - b))
    for (const key of keys) {
      const value = store[key]
      delete store[key]
      if (key < at + removed) continue
      store[key + delta] = value
    }
  }
  // A cached line carries the index of the paragraph it belongs to, and every
  // consumer slices `doc.paragraphs[line.paraIndex]` with it. Re-keying the
  // entry without re-stamping its lines makes a paragraph paint another one's
  // text — found by the fuzz in docs/DIAGNOSTICS.md on its first step.
  for (const key of Object.keys(paraCache).map(Number)) {
    const entry = paraCache[key]
    for (const line of entry.lines) line.paraIndex = key
  }
}
