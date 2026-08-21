// Style application on the per-character style bytes (ARCHITECTURE.md §4.5).
// Replaces the offset-mark logic that lived in edit/marks.ts; the merge/split
// normalisation (normalizeMarksForPara) is gone because the bytes can never
// desynchronise from the text. Owned by Agent A (docs/PARALLEL-PLAN.md, A1).

import { markParagraphDirty } from './dirty'
import { getSelectionRanges } from './selection'
import { STYLE_BOLD, STYLE_ITALIC, STYLE_UNDERLINE, STYLE_HEADLINE } from './runs'
import { doc } from '../state/doc'

/** A styles-only change, snapshotted so history can undo/redo it. */
export interface StyleEdit {
  para: number
  before: Uint8Array
  after: Uint8Array
}

export function applySelectionMark(kind: 'bold' | 'italic' | 'underline'): StyleEdit[] {
  // Selections routinely span paragraphs now (drag-select across a break, Ctrl+A),
  // so apply the bit to every selected span instead of refusing the whole action.
  const ranges = getSelectionRanges()
  if (ranges.length === 0) {
    alert('Seleziona il testo prima di applicare il formato.')
    return []
  }
  const bit = kind === 'bold' ? STYLE_BOLD : kind === 'italic' ? STYLE_ITALIC : STYLE_UNDERLINE
  const edits: StyleEdit[] = []
  for (const r of ranges) {
    const bytes = doc.styles[r.para]
    if (!bytes || r.end <= r.start) continue
    const before = bytes.slice()
    for (let i = r.start; i < r.end; i++) bytes[i] = bytes[i] | bit
    edits.push({ para: r.para, before, after: bytes.slice() })
    markParagraphDirty(r.para)
  }
  doc.selection = null
  return edits
}

export function toggleHeadlineForPara(): StyleEdit | null {
  const para = doc.cursor.para
  const paraLen = doc.paragraphs[para].length
  let start = 0
  let end = paraLen
  if (doc.selection && doc.selection.anchor.para === doc.selection.focus.para) {
    start = Math.min(doc.selection.anchor.offset, doc.selection.focus.offset)
    end = Math.max(doc.selection.anchor.offset, doc.selection.focus.offset)
    if (start === end) {
      // empty selection -> whole paragraph
      start = 0
      end = paraLen
    }
  }
  const bytes = doc.styles[para]
  const before = bytes.slice()
  let anyHeadline = false
  for (let i = start; i < end; i++) {
    if (bytes[i] & STYLE_HEADLINE) {
      anyHeadline = true
      break
    }
  }
  for (let i = start; i < end; i++) {
    bytes[i] = anyHeadline ? bytes[i] & ~STYLE_HEADLINE : bytes[i] | STYLE_HEADLINE
  }
  doc.selection = null
  markParagraphDirty(para)
  return { para, before, after: bytes.slice() }
}
