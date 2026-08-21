// Style interning and application on the per-character style ids
// (RICH-TEXT-MODEL.md §4.1). Replaces the byte-level mark logic that lived in
// edit/marks.ts (A1); the merge/split normalisation (normalizeMarksForPara) is
// gone because the ids can never desynchronise from the text. Owned by Agent A.
//
// Interning: one table entry per distinct character-level style; ids reference
// the table by index. The table lives on doc.styleTable so persistence can
// serialize it; the key map lives here and is rebuilt by resetStyleTable().

import { defaultStyle, doc } from '../state/doc'
import { markParagraphDirty } from './dirty'
import { getSelectionRanges } from './selection'
import { STYLE_BOLD, STYLE_HEADLINE, STYLE_ITALIC, STYLE_UNDERLINE } from './runs'
import type { InlineStyle } from '../types/doc'

/** A styles-only change, snapshotted so history can undo/redo it. */
export interface StyleEdit {
  para: number
  before: Uint16Array
  after: Uint16Array
}

function styleKey(s: InlineStyle): string {
  return JSON.stringify([
    s.fontFamily,
    Math.round(s.fontSize * 100) / 100,
    s.fontWeight,
    s.italic,
    s.underline,
    s.strike,
    s.color,
    s.background,
    Math.round(s.letterSpacing * 100) / 100,
    s.baseline,
    s.linkHref,
    s.headline,
  ])
}

const styleKeys = new Map<string, number>([[styleKey(defaultStyle()), 0]])

/** Returns the table index for a style, adding it when unseen. */
export function internStyle(style: InlineStyle): number {
  const key = styleKey(style)
  const hit = styleKeys.get(key)
  if (hit !== undefined) return hit
  const id = doc.styleTable.length
  doc.styleTable.push(style)
  styleKeys.set(key, id)
  return id
}

/** Rebuilds the table to just the default entry. Called by resetDocument. */
export function resetStyleTable(): void {
  doc.styleTable.length = 0
  doc.styleTable.push(defaultStyle())
  styleKeys.clear()
  styleKeys.set(styleKey(defaultStyle()), 0)
}

/**
 * Imports a serialized table (io/json.ts, io/persistence.ts): re-interns every
 * entry so table indices and the key map stay in sync, and returns the old-id →
 * new-id remap for the serialized styleIds.
 */
export function reinternTable(entries: InlineStyle[]): number[] {
  resetStyleTable()
  return entries.map((e) => internStyle({ ...defaultStyle(), ...(e ?? {}) }))
}

/** The style entry a (possibly stale) id resolves to. */
function styleEntry(id: number): InlineStyle {
  return doc.styleTable[id] ?? doc.styleTable[0]
}

/** Legacy byte → interned style (old marks/bytes format). */
export function legacyByteToStyle(byte: number): InlineStyle {
  const s = defaultStyle()
  if (byte & STYLE_BOLD) s.fontWeight = 700
  if (byte & STYLE_ITALIC) s.italic = true
  if (byte & STYLE_UNDERLINE) s.underline = true
  if (byte & STYLE_HEADLINE) s.headline = true
  return s
}

/** Converts a legacy per-char byte array into interned ids. */
export function styleIdsFromBytes(bytes: Uint8Array): Uint16Array {
  const ids = new Uint16Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) ids[i] = internStyle(legacyByteToStyle(bytes[i]))
  return ids
}

export function applySelectionMark(kind: 'bold' | 'italic' | 'underline'): StyleEdit[] {
  // Selections routinely span paragraphs now (drag-select across a break, Ctrl+A),
  // so apply the attribute to every selected span instead of refusing the whole action.
  const ranges = getSelectionRanges()
  if (ranges.length === 0) {
    alert('Seleziona il testo prima di applicare il formato.')
    return []
  }
  const edits: StyleEdit[] = []
  for (const r of ranges) {
    const ids = doc.styleIds[r.para]
    if (!ids || r.end <= r.start) continue
    const before = ids.slice()
    for (let i = r.start; i < r.end; i++) {
      const entry = styleEntry(ids[i])
      const modified: InlineStyle = { ...entry }
      if (kind === 'bold') modified.fontWeight = 700
      else if (kind === 'italic') modified.italic = true
      else modified.underline = true
      ids[i] = internStyle(modified)
    }
    edits.push({ para: r.para, before, after: ids.slice() })
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
  const ids = doc.styleIds[para]
  const before = ids.slice()
  let anyHeadline = false
  for (let i = start; i < end; i++) {
    if (styleEntry(ids[i]).headline) {
      anyHeadline = true
      break
    }
  }
  for (let i = start; i < end; i++) {
    const entry = styleEntry(ids[i])
    if (anyHeadline ? entry.headline : !entry.headline) {
      ids[i] = internStyle({ ...entry, headline: !anyHeadline })
    }
  }
  doc.selection = null
  markParagraphDirty(para)
  return { para, before, after: ids.slice() }
}
