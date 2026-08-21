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

const COLLAPSIBLE_WS = /[ \t]/

/**
 * FIXPLAN.md fix-1 follow-up — browsers' contenteditable rule: when a typed (or
 * plain-pasted) space would sit directly after a collapsible space, insert
 * U+00A0 instead, so two collapsible characters are never adjacent in the
 * model. pretext preserves space+NBSP pairs verbatim (verified: source and
 * fragment character codes both 32,160,…), which retires the fix-1 residual —
 * a line containing a collapsed run is painted a few pixels wider than the
 * width pretext broke it at.
 *
 * `prevChar` is the character before the insertion point. Each '\n' starts a
 * fresh paragraph segment whose first character has no predecessor (a space at
 * the start of a paragraph is a normal space).
 */
export function expandCollapsibleSpaces(text: string, prevChar: string): string {
  if (!text.includes(' ') && !text.includes('\t')) return text
  let out = ''
  let prev = prevChar
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\n') {
      out += ch
      prev = ''
    } else {
      out += COLLAPSIBLE_WS.test(ch) && COLLAPSIBLE_WS.test(prev) ? '\u00A0' : ch
      prev = ch
    }
  }
  return out
}

export function insertTextAtCursor(str: string) {
  if (str.length === 0) return
  const normalized = str.replace(/\r\n/g, '\n')
  const pos = editPos()
  const text = expandCollapsibleSpaces(normalized, pos.offset > 0 ? doc.paragraphs[pos.para][pos.offset - 1] : '')
  recordEdit(applyEdit(pos.para, pos.offset, pos.deleteCount, text))
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
