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
 * A paragraph splice, in the shape Array.prototype.splice takes: at `at`,
 * `removed` paragraphs disappeared and `inserted` appeared.
 */
export interface IndexSplice {
  at: number
  removed: number
  inserted: number
}

const pendingShifts: IndexSplice[] = []

/**
 * Paragraph indices moved. Everything keyed by index — the versions here, and
 * the layout caches that read them — must be re-keyed the same way, or a
 * paragraph inherits the cached lines and character widths of whatever used to
 * sit at its index.
 *
 * This replaces the markAllDirty() that used to fire on any split or merge
 * (BUGHUNT H1). That was correct, and it cost a full re-fit of the document on
 * every Enter — ~500 ms in a 290-page document, measured from a user's trace.
 * Re-keying costs one pass over the caches and leaves untouched paragraphs
 * cached.
 */
export function markParagraphsSpliced(at: number, removed: number, inserted: number): void {
  if (removed === 0 && inserted === 0) return
  const delta = inserted - removed
  const moved: Array<[number, number]> = []
  for (const [index, version] of lastChangedAt) {
    if (index < at) moved.push([index, version])
    else if (index < at + removed) continue // that paragraph is gone
    else moved.push([index + delta, version])
  }
  lastChangedAt.clear()
  for (const [index, version] of moved) lastChangedAt.set(index, version)

  if (pending !== 'all' && pending !== null) {
    if (pending.from >= at) pending.from = Math.max(at, pending.from + delta)
    if (pending.to >= at) pending.to = Math.max(at, pending.to + delta)
  }
  pendingShifts.push({ at, removed, inserted })
}

/** Returns and clears the splices recorded since the last layout pass. */
export function takeShifts(): IndexSplice[] {
  return pendingShifts.splice(0)
}

/**
 * Invalidates every paragraph. Still the right call when the whole document is
 * replaced — reset, import, restore — where nothing cached survives anyway.
 */
export function markAllDirty(): void {
  allChangedAt = ++clock
  lastChangedAt.clear()
  pendingShifts.length = 0
  pending = 'all'
}

/** Returns and clears the pending dirty range. */
export function takeDirty(): DirtyRange {
  const p = pending
  pending = null
  return p
}
