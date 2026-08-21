// Contract 2 (docs/PARALLEL-PLAN.md): Agent A writes, Agent B reads.
//
// Tracks which paragraphs changed since the last layout pass, and gives every
// paragraph a monotonic version that layout can use as a cache key.
//
// Step 0 behaviour: every mutation calls markAllDirty(), so relayout() keeps doing
// a full pass and nothing changes. A1 narrows the calls to markParagraphDirty();
// B3 starts honouring takeDirty() instead of always re-laying everything out.

export type DirtyRange = { from: number; to: number } | 'all' | null

/** Monotonic clock so a version can never repeat, even after markAllDirty. */
let clock = 0
let allChangedAt = 0
const lastChangedAt = new Map<number, number>()

let pending: DirtyRange = 'all'

/** The version of a paragraph's text + styles. Changes whenever it is marked dirty. */
export function paragraphVersion(index: number): number {
  return Math.max(lastChangedAt.get(index) ?? 0, allChangedAt)
}

export function markParagraphDirty(index: number): void {
  lastChangedAt.set(index, ++clock)
  if (pending === 'all') return
  if (pending === null) pending = { from: index, to: index }
  else {
    pending.from = Math.min(pending.from, index)
    pending.to = Math.max(pending.to, index)
  }
}

/**
 * Invalidates every paragraph. Required whenever paragraph *indices* shift —
 * a split, a merge, an import — because cached layout is keyed by index.
 */
export function markAllDirty(): void {
  allChangedAt = ++clock
  lastChangedAt.clear()
  pending = 'all'
}

/** Returns and clears the pending dirty range. */
export function takeDirty(): DirtyRange {
  const p = pending
  pending = null
  return p
}
