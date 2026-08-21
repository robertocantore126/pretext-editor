// Document-level operations. applyEdit is the single mutation chokepoint for the
// whole editor (ARCHITECTURE.md §4.6, docs/PARALLEL-PLAN.md A1): text and style
// ids are spliced together here, selection deletion happens here, dirty
// paragraphs are marked here, and subscribers (undo, autosave) are notified here.
// blockAttrs (RICH-TEXT-MODEL.md §4.2) is kept in sync with the paragraph array.
//
// main.ts (frozen) reaches the model only through resetDocument.

import { defaultBlockAttrs, doc } from '../state/doc'
import { markAllDirty, markParagraphDirty } from './dirty'
import { clearSelection } from './selection'
import { resetStyleTable } from './styles'

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
  /** Per-paragraph style ids for the inserted text (one entry per insertText paragraph). */
  insertIds: Uint16Array[]
  /** The removed text, paragraphs joined by '\n'. */
  deletedText: string
  /** Per-paragraph style ids of the removed text. */
  deletedIds: Uint16Array[]
}

function spliceIds(bytes: Uint16Array, start: number, deleteCount: number, insert: Uint16Array): Uint16Array {
  const out = new Uint16Array(bytes.length - deleteCount + insert.length)
  out.set(bytes.subarray(0, start))
  out.set(insert, start)
  out.set(bytes.subarray(start + deleteCount), start + insert.length)
  return out
}

function concatIds(parts: Uint16Array[]): Uint16Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint16Array(total)
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
 * merges (deleteCount crossing a boundary) splice text and style ids in
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
  insertIds?: Uint16Array[]
): EditRecord {
  const paras = doc.paragraphs
  const styles = doc.styleIds
  const attrs = doc.blockAttrs
  const p = Math.max(0, Math.min(paraIndex, paras.length - 1))
  const o = Math.max(0, Math.min(offset, paras[p].length))
  const parasBefore = paras.length
  // Style inherited by newly inserted text: the id at the insertion point (the
  // first char of a replaced selection, if any), else the last char of the
  // paragraph. Captured before the delete phase so typing over a styled
  // selection keeps that style.
  const insertStartIds = styles[p]
  const inherit = o < insertStartIds.length
    ? insertStartIds[o]
    : insertStartIds.length > 0
      ? insertStartIds[insertStartIds.length - 1]
      : 0

  // ---- delete phase -------------------------------------------------------
  let remaining = Math.max(0, deleteCount)
  let deletedText = ''
  const deletedIds: Uint16Array[] = []
  let cur = p
  let curOff = o
  // BUGHUNT H1: an edit that crosses a paragraph boundary re-indexes the
  // paragraphs below it even when the net count is unchanged (a delete spanning
  // one boundary + an insert with one '\n'); the layout caches are keyed by
  // index, so only markAllDirty() keeps the tail from rendering stale content.
  let crossedBoundary = false
  while (remaining > 0 && cur < paras.length) {
    const text = paras[cur]
    const ids = styles[cur]
    if (curOff < text.length) {
      const take = Math.min(remaining, text.length - curOff)
      deletedText += text.slice(curOff, curOff + take)
      deletedIds.push(ids.slice(curOff, curOff + take))
      paras[cur] = text.slice(0, curOff) + text.slice(curOff + take)
      styles[cur] = spliceIds(ids, curOff, take, new Uint16Array(0))
      remaining -= take
      if (remaining === 0) break
      curOff += take
    }
    if (cur >= paras.length - 1) break
    // Consume the paragraph boundary: merge the next paragraph into this one.
    crossedBoundary = true
    deletedText += '\n'
    remaining -= 1
    const curLen = paras[cur].length
    paras[cur] = paras[cur] + paras[cur + 1]
    styles[cur] = spliceIds(styles[cur], styles[cur].length, 0, styles[cur + 1])
    paras.splice(cur + 1, 1)
    styles.splice(cur + 1, 1)
    // The merged paragraph keeps the first paragraph's block attributes.
    attrs.splice(cur + 1, 1)
    curOff = curLen
  }
  // Re-slice the collected ids to match the paragraph structure of deletedText.
  // A paragraph that contributed no characters (a delete starting at a paragraph
  // end) pushes nothing above, so padding the tail leaves every entry off by one;
  // splitting the flat run by the part lengths is aligned by construction.
  const delParts = deletedText.split('\n')
  const deletedFlat = concatIds(deletedIds)
  const alignedDeletedIds: Uint16Array[] = []
  let delOff = 0
  for (const part of delParts) {
    alignedDeletedIds.push(deletedFlat.slice(delOff, delOff + part.length))
    delOff += part.length
  }

  // ---- insert phase -------------------------------------------------------
  const parts = insertText.split('\n')
  const n = parts.length
  const idsMatch =
    insertIds !== undefined &&
    insertIds.length === n &&
    insertIds.every((b, i) => b.length === parts[i].length)
  let partsIds: Uint16Array[]
  if (idsMatch) {
    partsIds = insertIds as Uint16Array[]
  } else {
    partsIds = parts.map((part) => new Uint16Array(part.length).fill(inherit))
  }

  const headT = paras[p].slice(0, o)
  const tailT = paras[p].slice(o)
  const headI = styles[p].slice(0, o)
  const tailI = styles[p].slice(o)

  if (n === 1) {
    paras[p] = headT + parts[0] + tailT
    styles[p] = concatIds([headI, partsIds[0], tailI])
  } else {
    paras[p] = headT + parts[0]
    styles[p] = concatIds([headI, partsIds[0]])
    for (let i = 1; i < n - 1; i++) {
      paras.splice(p + i, 0, parts[i])
      styles.splice(p + i, 0, partsIds[i])
      attrs.splice(p + i, 0, defaultBlockAttrs())
    }
    paras.splice(p + n - 1, 0, parts[n - 1] + tailT)
    styles.splice(p + n - 1, 0, concatIds([partsIds[n - 1], tailI]))
    attrs.splice(p + n - 1, 0, defaultBlockAttrs())
  }

  doc.cursor = { para: p + n - 1, offset: o + parts[n - 1].length }
  clearSelection()

  if (paras.length !== parasBefore || crossedBoundary || insertText.includes('\n')) markAllDirty()
  else markParagraphDirty(p)

  const record: EditRecord = {
    paraIndex: p,
    offset: o,
    deleteCount,
    insertText,
    insertIds: partsIds,
    deletedText,
    deletedIds: alignedDeletedIds,
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
  doc.styleIds = [new Uint16Array(0)]
  doc.blockAttrs = [defaultBlockAttrs()]
  resetStyleTable()
  doc.cursor = { para: 0, offset: 0 }
  clearSelection()
  markAllDirty()
  notifyReset()
}

// ---- subscribers -----------------------------------------------------------
// Two hooks so io/persistence.ts (A5) can autosave without main.ts (frozen)
// changing and without the model importing upward. notifyEdits fires only for
// text mutations through applyEdit; notifyChanged fires for *any* document
// change (style edits, image geometry, undo/redo of styles) so nothing that
// affects the saved document escapes persistence (BUGHUNT C2/H2).

type EditListener = (record: EditRecord) => void
const editListeners: EditListener[] = []
const changedListeners: Array<() => void> = []
const resetListeners: Array<() => void> = []

export function subscribeEdits(listener: EditListener): void {
  editListeners.push(listener)
}

/** Fired on every document change: text edits, style edits, image mutations. */
export function subscribeChanged(listener: () => void): void {
  changedListeners.push(listener)
}

/** Signal that the document changed in a way persistence must capture. */
export function notifyChanged(): void {
  for (const listener of changedListeners) listener()
}

export function subscribeReset(listener: () => void): void {
  resetListeners.push(listener)
}

function notifyEdits(record: EditRecord): void {
  for (const listener of editListeners) listener(record)
  notifyChanged()
}

function notifyReset(): void {
  for (const listener of resetListeners) listener()
}
