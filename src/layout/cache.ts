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
