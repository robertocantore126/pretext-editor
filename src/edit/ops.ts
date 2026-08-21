import { relayout } from '../layout/engine'
import { moveCursorVertical, resetStickyX } from '../layout/caret-position'
import { draw } from '../render/draw'
import { applyEdit, selectionDeleteSpec } from '../model/document'
import { doc } from '../state/doc'
import { repositionGhostInput } from './caret'
import { resetCaretBlink } from '../render/caret'
import { recordEdit } from './history'

export function currentParaText(): string {
  return doc.paragraphs[doc.cursor.para]
}

/** Where the next edit applies: the selection's anchored start, or the caret. */
function editPos(): { para: number; offset: number; deleteCount: number } {
  const spec = selectionDeleteSpec()
  if (spec) return spec
  return { para: doc.cursor.para, offset: doc.cursor.offset, deleteCount: 0 }
}

export function insertTextAtCursor(str: string) {
  if (str.length === 0) return
  const normalized = str.replace(/\r\n/g, '\n')
  const pos = editPos()
  recordEdit(applyEdit(pos.para, pos.offset, pos.deleteCount, normalized))
  relayout()
}

export function splitParagraphAtCursor() {
  const pos = editPos()
  recordEdit(applyEdit(pos.para, pos.offset, pos.deleteCount, '\n'))
  relayout()
}

export function backspaceAtCursor() {
  const spec = selectionDeleteSpec()
  if (spec) {
    recordEdit(applyEdit(spec.para, spec.offset, spec.deleteCount, ''))
    relayout()
    return
  }
  const { para, offset } = doc.cursor
  if (offset > 0) {
    // applyEdit deletes forward from its start position, so Backspace must
    // start one character before the caret.
    recordEdit(applyEdit(para, offset - 1, 1, ''))
  } else if (para > 0) {
    recordEdit(applyEdit(para - 1, doc.paragraphs[para - 1].length, 1, ''))
  } else {
    return
  }
  relayout()
}

export function deleteForwardAtCursor() {
  const spec = selectionDeleteSpec()
  if (spec) {
    recordEdit(applyEdit(spec.para, spec.offset, spec.deleteCount, ''))
    relayout()
    return
  }
  const { para, offset } = doc.cursor
  const len = doc.paragraphs[para].length
  if (offset < len) {
    recordEdit(applyEdit(para, offset, 1, ''))
  } else if (para < doc.paragraphs.length - 1) {
    recordEdit(applyEdit(para, len, 1, ''))
  } else {
    return
  }
  relayout()
}

export function moveLeft() {
  resetStickyX()
  if (doc.cursor.offset > 0) doc.cursor.offset -= 1
  else if (doc.cursor.para > 0) {
    doc.cursor.para -= 1
    doc.cursor.offset = doc.paragraphs[doc.cursor.para].length
  }
  resetCaretBlink()
  draw()
  repositionGhostInput()
}

export function moveRight() {
  resetStickyX()
  const len = currentParaText().length
  if (doc.cursor.offset < len) doc.cursor.offset += 1
  else if (doc.cursor.para < doc.paragraphs.length - 1) {
    doc.cursor.para += 1
    doc.cursor.offset = 0
  }
  resetCaretBlink()
  draw()
  repositionGhostInput()
}

export function moveVertical(dir: 1 | -1) {
  // B5: the geometry - real line heights and the sticky column - lives in
  // layout/caret-position.ts (Agent B); this A-owned entry point delegates.
  moveCursorVertical(dir)
  resetCaretBlink()
  draw()
  repositionGhostInput()
}
