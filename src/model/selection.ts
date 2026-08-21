// Contract 3 (docs/PARALLEL-PLAN.md): Agent A implements, Agent B consumes.
//
// A decides what is selected; B decides how it is painted. This is what lets A1
// support multi-paragraph selection without editing render/draw.ts.

import { doc } from '../state/doc'
import type { Cursor } from '../types/doc'

export interface SelectionRange {
  para: number
  start: number
  end: number
}

/**
 * The selected spans, one per paragraph, in document order.
 *
 * A1 extends this across paragraphs: boundary paragraphs are clamped to their
 * anchor/focus offsets, middle paragraphs contribute their full span (empty
 * middle paragraphs contribute nothing).
 */
export function getSelectionRanges(): SelectionRange[] {
  const sel = doc.selection
  if (!sel) return []
  const a = sel.anchor
  const b = sel.focus
  if (a.para === b.para) {
    const start = Math.min(a.offset, b.offset)
    const end = Math.max(a.offset, b.offset)
    if (end <= start) return []
    return [{ para: a.para, start, end }]
  }
  const first = a.para < b.para ? a : b
  const last = a.para < b.para ? b : a
  const ranges: SelectionRange[] = []
  for (let para = first.para; para <= last.para; para++) {
    const len = doc.paragraphs[para]?.length ?? 0
    const start = para === first.para ? first.offset : 0
    const end = para === last.para ? last.offset : len
    // Zero-length spans are kept: an empty paragraph inside the selection is a
    // real blank line, and dropping it makes the clipboard lose it while a cut
    // still deletes it. Renderers skip empty spans on their own.
    if (start > end) continue
    ranges.push({ para, start, end })
  }
  return ranges
}

/** Passing null for focus collapses the selection to the anchor. */
export function setSelection(anchor: Cursor, focus: Cursor | null): void {
  doc.selection = { anchor, focus: focus ?? anchor }
}

export function clearSelection(): void {
  doc.selection = null
}

/** Moves the caret. The only way a non-A file may change the cursor. */
export function setCursor(c: Cursor): void {
  doc.cursor = c
}

/** Collapses the caret onto the focus end of the current selection, if any. */
export function moveCursorToSelectionFocus(): void {
  if (doc.selection) doc.cursor = doc.selection.focus
}

export function isCollapsed(): boolean {
  const sel = doc.selection
  if (!sel) return true
  return sel.anchor.para === sel.focus.para && sel.anchor.offset === sel.focus.offset
}
