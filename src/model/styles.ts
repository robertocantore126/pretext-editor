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
import { notifyChanged } from './document'
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
    s.decoration,
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
  // A shortcut has to toggle: Ctrl+B, type, Ctrl+B again is how every editor
  // works, and a mark that can only be switched on is unusable from the
  // keyboard. Set it when any character in the selection lacks it, clear it
  // when they all have it — the same rule toggleHeadlineForPara already uses.
  const has = (s: InlineStyle) => (kind === 'bold' ? s.fontWeight >= 600 : kind === 'italic' ? s.italic : s.underline)
  let allHave = true
  for (const r of ranges) {
    const ids = doc.styleIds[r.para]
    if (!ids) continue
    for (let i = r.start; i < r.end && allHave; i++) if (!has(styleEntry(ids[i]))) allHave = false
  }
  const turnOn = !allHave

  const edits: StyleEdit[] = []
  for (const r of ranges) {
    const ids = doc.styleIds[r.para]
    if (!ids || r.end <= r.start) continue
    const before = ids.slice()
    for (let i = r.start; i < r.end; i++) {
      const entry = styleEntry(ids[i])
      const modified: InlineStyle = { ...entry }
      if (kind === 'bold') modified.fontWeight = turnOn ? 700 : 400
      else if (kind === 'italic') modified.italic = turnOn
      else modified.underline = turnOn
      ids[i] = internStyle(modified)
    }
    edits.push({ para: r.para, before, after: ids.slice() })
    markParagraphDirty(r.para)
  }
  doc.selection = null
  notifyChanged()
  return edits
}

/**
 * Toggles headline on the selection. Multi-paragraph selections apply per
 * paragraph (BUGHUNT M5: the old code silently fell back to the cursor's
 * paragraph). With no selection (or a collapsed one) the whole cursor
 * paragraph is toggled, keeping the legacy button behaviour.
 */
export function toggleHeadlineForPara(): StyleEdit[] {
  let ranges = getSelectionRanges()
  if (ranges.length === 0) {
    const paraLen = doc.paragraphs[doc.cursor.para].length
    if (paraLen === 0) return []
    ranges = [{ para: doc.cursor.para, start: 0, end: paraLen }]
  }
  const edits: StyleEdit[] = []
  for (const r of ranges) {
    const para = r.para
    const ids = doc.styleIds[para]
    if (!ids || r.end <= r.start) continue
    const from = Math.min(r.start, ids.length)
    const to = Math.min(r.end, ids.length)
    if (from >= to) continue
    const before = ids.slice()
    let anyHeadline = false
    for (let i = from; i < to; i++) {
      if (styleEntry(ids[i]).headline) {
        anyHeadline = true
        break
      }
    }
    for (let i = from; i < to; i++) {
      const entry = styleEntry(ids[i])
      if (anyHeadline ? entry.headline : !entry.headline) {
        ids[i] = internStyle({ ...entry, headline: !anyHeadline })
      }
    }
    edits.push({ para, before, after: ids.slice() })
    markParagraphDirty(para)
  }
  doc.selection = null
  notifyChanged()
  return edits
}

/**
 * Give the selection a hand-drawn underline (model/decorations.ts), or take it
 * away with null. The decoration implies the underline: a mark that is drawn
 * but not switched on would be invisible, and switching underline off has to
 * take its decoration with it.
 */
export function applySelectionDecoration(id: string | null): StyleEdit[] {
  const ranges = getSelectionRanges()
  if (ranges.length === 0) {
    alert('Seleziona il testo prima di applicare la sottolineatura.')
    return []
  }
  const edits: StyleEdit[] = []
  for (const r of ranges) {
    const ids = doc.styleIds[r.para]
    if (!ids || r.end <= r.start) continue
    const before = ids.slice()
    for (let i = r.start; i < r.end; i++) {
      const entry = styleEntry(ids[i])
      ids[i] = internStyle({ ...entry, decoration: id, underline: id !== null ? true : entry.underline })
    }
    edits.push({ para: r.para, before, after: ids.slice() })
    markParagraphDirty(r.para)
  }
  doc.selection = null
  notifyChanged()
  return edits
}

