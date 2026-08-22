// Tab operations on the continuous document (docs/TABS.md).
//
// Nothing here swaps documents: a tab is a bookmark inside the one roll of
// paper. Adding one appends an empty paragraph and marks it; deleting one
// removes that stretch of the roll; going to one scrolls there. Every structural
// change goes through applyEdit, so undo covers it like any other edit.

import { docWrap } from '../dom'
import { materializeParagraph, relayout } from '../layout/engine'
import { applyEdit, notifyChanged } from '../model/document'
import { docToVisualY } from '../layout/pagination'
import {
  findSection,
  newSectionId,
  notifySections,
  sectionAt,
  sectionRange,
  sections,
  setSectionMark,
  uniqueTitle,
} from '../model/sections'
import { setCursor } from '../model/selection'
import { PAD_Y } from '../config'
import { doc } from '../state/doc'
import { view } from '../state/view'
import { recordEdit } from './history'
import { trace } from '../debug/tracer'
import { repositionGhostInput } from './caret'

/**
 * Append a tab at the end of the roll: a new empty paragraph, marked. The
 * paragraph is created through applyEdit, so one Ctrl+Z removes the tab again —
 * undoing the insert merges the paragraph away and takes its marker with it.
 */
export function addSection(level: 0 | 1 = 0): string {
  const lastPara = doc.paragraphs.length - 1
  recordEdit(applyEdit(lastPara, doc.paragraphs[lastPara].length, 0, '\n'))
  const index = doc.paragraphs.length - 1
  const id = newSectionId()
  setSectionMark(index, { id, title: uniqueTitle(level === 1 ? 'Sottoscheda' : 'Scheda'), level })
  setCursor({ para: index, offset: 0 })
  trace('section', 'add', { id, level, paraIndex: index, paragraphs: doc.paragraphs.length })
  relayout()
  goToSection(id)
  notifySections()
  notifyChanged()
  return id
}

export function renameSection(id: string, title: string): void {
  const found = findSection(id)
  if (!found) return
  const clean = title.trim()
  if (!clean) return
  if (found.id === 'implicit-first') {
    // The document never had a marker on its first paragraph; naming it creates
    // one, which is also what makes the name survive a save.
    setSectionMark(0, { id: newSectionId(), title: clean, level: 0 })
  } else {
    // Only the mark's own fields: paraIndex is derived from where the marker
    // sits, so storing it would plant a number that lies the moment the
    // paragraph moves.
    setSectionMark(found.paraIndex, { id: found.id, title: clean, level: found.level })
  }
  relayout()
  trace('section', 'rename', { id, title: clean })
  notifySections()
  notifyChanged()
}

/**
 * Delete a tab and the stretch of document it covers, as Docs does. It is one
 * applyEdit, so Ctrl+Z brings back both the text and the marker. The first
 * section cannot be deleted while it is the only one: the roll would have no
 * beginning.
 */
export function deleteSection(id: string): boolean {
  const list = sections()
  if (list.length <= 1) return false
  const range = sectionRange(id)
  if (!range) return false
  const { start, end } = range
  // Linear length of the covered paragraphs, boundaries included.
  let count = 0
  for (let i = start; i <= end; i++) count += doc.paragraphs[i].length + 1
  if (start > 0) {
    // Swallow the newline that precedes the section instead of the one after
    // it, so the tail keeps its own marker and does not get absorbed here.
    recordEdit(applyEdit(start - 1, doc.paragraphs[start - 1].length, count, ''))
  } else {
    // First section: there is no preceding boundary, so drop the trailing one.
    recordEdit(applyEdit(0, 0, Math.min(count, totalLength() - 0), ''))
  }
  relayout()
  trace('section', 'delete', { id, start, end, paragraphs: doc.paragraphs.length })
  notifySections()
  notifyChanged()
  return true
}

function totalLength(): number {
  let n = 0
  for (const p of doc.paragraphs) n += p.length + 1
  return Math.max(0, n - 1)
}

/** Unroll the document to a tab: scroll it to the top of the visible area. */
export function goToSection(id: string): void {
  const entry = view.sections.find((s) => s.id === id)
  if (!entry) return
  // With lazy layout the section's y is approximate while the paragraphs above
  // it are estimates (docs/LAZY-LAYOUT.md §4). Materialize the section's own
  // paragraph first — the pass updates view.sections with the y it actually
  // lands at — then scroll to *that*, or clicking a far tab drops you near the
  // section instead of at it.
  materializeParagraph(entry.paraIndex)
  const fresh = view.sections.find((s) => s.id === id) ?? entry
  docWrap.scrollTop = Math.max(0, PAD_Y + docToVisualY(fresh.y) - 24)
  trace('section', 'goto', { id, y: fresh.y, scrollTop: Math.round(docWrap.scrollTop) })
  const found = findSection(id)
  if (found) setCursor({ para: found.paraIndex, offset: 0 })
  repositionGhostInput()
  relayout()
  notifySections()
}

/** The tab the caret is currently inside — what the panel highlights. */
export function activeSectionId(): string | null {
  return sectionAt(doc.cursor.para)?.id ?? null
}
