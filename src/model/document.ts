// Document-level operations. applyEdit is the single mutation chokepoint for the
// whole editor (ARCHITECTURE.md §4.6, docs/PARALLEL-PLAN.md A1): text and style
// bytes are spliced together here, selection deletion happens here, dirty
// paragraphs are marked here, and subscribers (undo, autosave) are notified here.
//
// main.ts (frozen) reaches the model only through resetDocument.

import { doc } from '../state/doc'
import { markAllDirty, markParagraphDirty } from './dirty'
import { clearSelection } from './selection'

/** A description of one mutation, sufficient to undo or redo it. */
export interface EditRecord {
  /** The paragraph where the edit starts (before any split/merge). */
  paraIndex: number
  /** Character offset within that paragraph where the edit starts. */
  offset: number
  /** Characters removed, counting paragraph boundaries ('\n') as one each. */
  deleteCount: number
  /** Text inserted; may contain '\n' to split paragraphs. */
  insertText: string
  /** Per-paragraph style bytes for the inserted text (one entry per insertText paragraph). */
  insertBytes: Uint8Array[]
  /** The removed text, paragraphs joined by '\n'. */
  deletedText: string
  /** Per-paragraph style bytes of the removed text. */
  deletedBytes: Uint8Array[]
}

function spliceBytes(bytes: Uint8Array, start: number, deleteCount: number, insert: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length - deleteCount + insert.length)
  out.set(bytes.subarray(0, start))
  out.set(insert, start)
  out.set(bytes.subarray(start + deleteCount), start + insert.length)
  return out
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/**
 * The one way text changes: delete `deleteCount` characters starting at
 * (paraIndex, offset) — spanning paragraph boundaries as needed — then insert
 * `insertText` at the same point. Paragraph splits (insertText with '\n') and
 * merges (deleteCount crossing a boundary) splice text and style bytes in
 * lockstep, so offsets can never desynchronise.
 *
 * Updates doc.cursor to the end of the inserted text (or to the deletion point
 * when nothing is inserted) and clears the selection.
 */
export function applyEdit(
  paraIndex: number,
  offset: number,
  deleteCount: number,
  insertText: string,
  insertBytes?: Uint8Array[]
): EditRecord {
  const paras = doc.paragraphs
  const styles = doc.styles
  const p = Math.max(0, Math.min(paraIndex, paras.length - 1))
  const o = Math.max(0, Math.min(offset, paras[p].length))
  const parasBefore = paras.length
  // Style inherited by newly inserted text: the byte at the insertion point
  // (the first char of a replaced selection, if any), else the last char of the
  // paragraph. Captured before the delete phase so typing over a styled
  // selection keeps that style.
  const insertStartBytes = styles[p]
  const inherit = o < insertStartBytes.length
    ? insertStartBytes[o]
    : insertStartBytes.length > 0
      ? insertStartBytes[insertStartBytes.length - 1]
      : 0

  // ---- delete phase -------------------------------------------------------
  let remaining = Math.max(0, deleteCount)
  let deletedText = ''
  const deletedBytes: Uint8Array[] = []
  let cur = p
  let curOff = o
  while (remaining > 0 && cur < paras.length) {
    const text = paras[cur]
    const bytes = styles[cur]
    if (curOff < text.length) {
      const take = Math.min(remaining, text.length - curOff)
      deletedText += text.slice(curOff, curOff + take)
      deletedBytes.push(bytes.slice(curOff, curOff + take))
      paras[cur] = text.slice(0, curOff) + text.slice(curOff + take)
      styles[cur] = spliceBytes(bytes, curOff, take, new Uint8Array(0))
      remaining -= take
      if (remaining === 0) break
      curOff += take
    }
    if (cur >= paras.length - 1) break
    // Consume the paragraph boundary: merge the next paragraph into this one.
    deletedText += '\n'
    remaining -= 1
    const curLen = paras[cur].length
    paras[cur] = paras[cur] + paras[cur + 1]
    styles[cur] = spliceBytes(styles[cur], styles[cur].length, 0, styles[cur + 1])
    paras.splice(cur + 1, 1)
    styles.splice(cur + 1, 1)
    curOff = curLen
  }
  // Re-slice the collected bytes to match the paragraph structure of deletedText.
  // A paragraph that contributed no characters (a delete starting at a paragraph
  // end) pushes nothing above, so padding the tail leaves every entry off by one;
  // splitting the flat run by the part lengths is aligned by construction.
  const delParts = deletedText.split('\n')
  const deletedFlat = concatBytes(deletedBytes)
  const alignedDeletedBytes: Uint8Array[] = []
  let delOff = 0
  for (const part of delParts) {
    alignedDeletedBytes.push(deletedFlat.slice(delOff, delOff + part.length))
    delOff += part.length
  }

  // ---- insert phase -------------------------------------------------------
  const parts = insertText.split('\n')
  const n = parts.length
  const bytesMatch =
    insertBytes !== undefined &&
    insertBytes.length === n &&
    insertBytes.every((b, i) => b.length === parts[i].length)
  let partsBytes: Uint8Array[]
  if (bytesMatch) {
    partsBytes = insertBytes as Uint8Array[]
  } else {
    partsBytes = parts.map((part) => new Uint8Array(part.length).fill(inherit))
  }

  const headT = paras[p].slice(0, o)
  const tailT = paras[p].slice(o)
  const headB = styles[p].slice(0, o)
  const tailB = styles[p].slice(o)

  if (n === 1) {
    paras[p] = headT + parts[0] + tailT
    styles[p] = concatBytes([headB, partsBytes[0], tailB])
  } else {
    paras[p] = headT + parts[0]
    styles[p] = concatBytes([headB, partsBytes[0]])
    for (let i = 1; i < n - 1; i++) {
      paras.splice(p + i, 0, parts[i])
      styles.splice(p + i, 0, partsBytes[i])
    }
    paras.splice(p + n - 1, 0, parts[n - 1] + tailT)
    styles.splice(p + n - 1, 0, concatBytes([partsBytes[n - 1], tailB]))
  }

  doc.cursor = { para: p + n - 1, offset: o + parts[n - 1].length }
  clearSelection()

  if (paras.length !== parasBefore) markAllDirty()
  else markParagraphDirty(p)

  const record: EditRecord = {
    paraIndex: p,
    offset: o,
    deleteCount,
    insertText,
    insertBytes: partsBytes,
    deletedText,
    deletedBytes: alignedDeletedBytes,
  }
  notifyEdits(record)
  return record
}

/**
 * The deletion implied by the current selection: the anchored start position and
 * the number of linear characters (paragraph boundaries count as one each).
 * Returns null when there is no selection.
 */
export function selectionDeleteSpec(): { para: number; offset: number; deleteCount: number } | null {
  const sel = doc.selection
  if (!sel) return null
  const a = sel.anchor
  const b = sel.focus
  const ordered = a.para < b.para || (a.para === b.para && a.offset <= b.offset)
  const start = ordered ? a : b
  const end = ordered ? b : a
  if (start.para === end.para) {
    if (end.offset <= start.offset) return null
    return { para: start.para, offset: start.offset, deleteCount: end.offset - start.offset }
  }
  let count = 0
  for (let i = start.para; i < end.para; i++) {
    count += doc.paragraphs[i].length - (i === start.para ? start.offset : 0) + 1
  }
  count += end.offset
  return { para: start.para, offset: start.offset, deleteCount: count }
}

/** Deletes the current selection (if any) without recording undo. */
export function deleteSelection(): boolean {
  const spec = selectionDeleteSpec()
  if (!spec || spec.deleteCount === 0) return false
  applyEdit(spec.para, spec.offset, spec.deleteCount, '')
  return true
}

export function resetDocument(): void {
  doc.paragraphs = ['']
  doc.styles = [new Uint8Array(0)]
  doc.cursor = { para: 0, offset: 0 }
  clearSelection()
  markAllDirty()
  notifyReset()
}

// ---- subscribers -----------------------------------------------------------
// A tiny hook so io/persistence.ts (A5) can autosave without main.ts (frozen)
// changing and without the model importing upward.

type EditListener = (record: EditRecord) => void
const editListeners: EditListener[] = []
const resetListeners: Array<() => void> = []

export function subscribeEdits(listener: EditListener): void {
  editListeners.push(listener)
}

export function subscribeReset(listener: () => void): void {
  resetListeners.push(listener)
}

function notifyEdits(record: EditRecord): void {
  for (const listener of editListeners) listener(record)
}

function notifyReset(): void {
  for (const listener of resetListeners) listener()
}
