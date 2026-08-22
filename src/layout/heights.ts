// Prefix sums over paragraph offsets, as a Fenwick tree (docs/LAZY-LAYOUT.md §3).
//
// yOf(i) and paragraphAtY(y) answer in O(log n) what relayout's eager walk
// accumulates in O(n): where paragraph i starts, and which paragraph a document
// Y falls in. The index must agree with the eager walk — that is the gate — so
// relayout writes it the same way the walk computes y: the offset stored for
// paragraph i is exactly yOf(i+1) - yOf(i), i.e. its height plus the PARA_GAP
// after it, plus the section fold padding and title block when it opens a tab
// (docs/TABS.md) — "PARA_GAP and section folds are part of the offset, not of
// the height" (LAZY-LAYOUT.md §3). The fold padding depends on the accumulated
// y, which a pure prefix sum cannot express on its own, so the engine
// recomputes it on every pass and rewrites the entry: that is the only part of
// the index that ever changes for a paragraph whose text did not.
//
// The index is re-keyed in the same place the layout caches are — next to
// shiftCaches/shiftImageAnchors in relayout — because a fourth structure keyed
// by paragraph index that forgets to follow a splice is commit 239b1a2's bug
// again (docs/DIAGNOSTICS.md).

/** Per-paragraph offset yOf(i+1) - yOf(i), the raw values the tree aggregates. */
let values: number[] = []
/** Fenwick tree over values, 1-based (tree[0] unused). */
let tree: number[] = []
let count = 0

const lowbit = (x: number) => x & -x

/** Rebuild the tree from values in O(n) — used after a splice. */
function rebuild(): void {
  tree.length = count + 1
  tree[0] = 0
  for (let i = 1; i <= count; i++) tree[i] = values[i - 1]
  for (let i = 1; i <= count; i++) {
    const j = i + lowbit(i)
    if (j <= count) tree[j] += tree[i]
  }
}

/** Drop everything: the document was replaced wholesale (reset, import, restore). */
export function resetHeights(): void {
  values = []
  tree = []
  count = 0
}

/**
 * Size the index for a freshly replaced document. The walk that follows will
 * overwrite every entry; sizing up front keeps setHeight's point update O(log n)
 * instead of growing the array one rebuild at a time (O(n) per paragraph — the
 * full materialization of a large document would otherwise be quadratic).
 */
export function prepareHeights(n: number): void {
  values = new Array(n).fill(0)
  count = n
  rebuild()
}

/**
 * Set paragraph i's offset — what the eager walk adds to y while processing it:
 * height + PARA_GAP (except after the last paragraph) + section fold padding +
 * title block. The caller (relayout) computes the exact value from the walk's
 * y before and after the paragraph, so the fold padding is right by
 * construction.
 */
export function setHeight(paraIndex: number, offset: number): void {
  if (paraIndex >= values.length) {
    // A paragraph beyond the current length (reset followed by a walk, or a
    // splice the caller forgot): grow so the tree always matches paragraph
    // indices. The walk rewrites every entry anyway.
    values[paraIndex] = offset
    count = values.length
    rebuild()
    return
  }
  const delta = offset - values[paraIndex]
  if (delta === 0) return
  values[paraIndex] = offset
  for (let i = paraIndex + 1; i <= count; i += lowbit(i)) tree[i] += delta
}

/** Document Y where paragraph i starts, O(log n). Paragraph 0 starts at 0. */
export function yOf(paraIndex: number): number {
  let sum = 0
  for (let i = paraIndex; i > 0; i -= lowbit(i)) sum += tree[i]
  return sum
}

/** The document Y just past the last paragraph — the text height. */
export function totalHeight(): number {
  let sum = 0
  for (let i = count; i > 0; i -= lowbit(i)) sum += tree[i]
  return sum
}

/**
 * The paragraph whose band contains document Y. The Fenwick "find the largest
 * index whose prefix sum is ≤ y" walk: O(log n), no binary search over the
 * array. Clamps to the last paragraph past the end and to 0 above the top.
 */
export function paragraphAtY(y: number): number {
  if (count === 0) return 0
  let idx = 0
  let bit = 1
  while (bit << 1 <= count) bit <<= 1
  for (let step = bit; step > 0; step >>= 1) {
    const next = idx + step
    if (next <= count && tree[next] <= y) {
      idx = next
      y -= tree[next]
    }
  }
  return Math.min(count - 1, idx)
}

/**
 * Paragraph indices moved: splice the values array like the model spliced the
 * paragraphs, and rebuild. Inserted paragraphs get a placeholder offset of 0 —
 * the walk that always follows a splice rewrites them; between the two, yOf is
 * approximate below the splice, which nothing may depend on (the layout is
 * invalidated at exactly that point anyway).
 */
export function spliceHeights(at: number, removed: number, inserted: number): void {
  if (removed === 0 && inserted === 0) return
  values.splice(at, removed, ...Array(inserted).fill(0))
  count = values.length
  rebuild()
}

/** For the differential gate: the raw per-paragraph offsets. */
export function rawOffsets(): number[] {
  return [...values]
}
