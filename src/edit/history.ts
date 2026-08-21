// A2 - Undo/redo. Owned by Agent A (docs/PARALLEL-PLAN.md).
//
// Every mutation funnels through applyEdit (model/document.ts) and is recorded
// here by the edit layer (ops.ts, clipboard.ts, marks shim). Text edits are
// replayed as inverse edits through applyEdit, which keeps dirty tracking and
// style ids consistent for free; style edits restore a one-paragraph snapshot of
// the interned-id array. Consecutive typed characters coalesce into a single entry.

import { relayout } from '../layout/engine'
import { applyEdit, subscribeReset } from '../model/document'
import type { EditRecord } from '../model/document'
import { markParagraphDirty } from '../model/dirty'
import { doc } from '../state/doc'

interface TextEditEntry {
  kind: 'edit'
  forward: EditRecord
  inverse: EditRecord
}

interface StyleSnapshot {
  para: number
  before: Uint16Array
  after: Uint16Array
}

interface StyleEditEntry {
  kind: 'style'
  edits: StyleSnapshot[]
}

type HistoryEntry = TextEditEntry | StyleEditEntry

const undoStack: HistoryEntry[] = []
const redoStack: HistoryEntry[] = []

export function initHistory(): void {
  undoStack.length = 0
  redoStack.length = 0
}

// A "new document" (main.ts reset) invalidates the history of the previous one.
subscribeReset(() => {
  undoStack.length = 0
  redoStack.length = 0
})

/** Records an edit produced by applyEdit. Callers are the edit-layer entry points. */
export function recordEdit(record: EditRecord): void {
  // A fresh edit invalidates the redo branch.
  redoStack.length = 0

  const last = undoStack[undoStack.length - 1]
  if (last && last.kind === 'edit' && canCoalesce(last, record)) {
    const f = last.forward
    const mergedText = f.insertText + record.insertText
    last.forward = {
      paraIndex: f.paraIndex,
      offset: f.offset,
      deleteCount: 0,
      insertText: mergedText,
      // Pure typing never contains '\n', so each insertIds is a single part;
      // merge into one part of the full length (plain concat would keep two
      // parts, breaking the constantId check on the next keystroke).
      insertIds: [concatU16(f.insertIds[0], record.insertIds[0])],
      deletedText: '',
      deletedIds: [],
    }
    last.inverse = {
      paraIndex: f.paraIndex,
      offset: f.offset,
      deleteCount: mergedText.length,
      insertText: '',
      insertIds: [],
      deletedText: mergedText,
      deletedIds: mergedText.split('\n').map(() => new Uint16Array(0)),
    }
    return
  }

  undoStack.push({
    kind: 'edit',
    forward: record,
    inverse: {
      paraIndex: record.paraIndex,
      offset: record.offset,
      deleteCount: record.insertText.length,
      insertText: record.deletedText,
      insertIds: record.deletedIds,
      deletedText: record.insertText,
      deletedIds: record.insertIds,
    },
  })
}

/**
 * Records a styles-only change (model/styles.ts), snapshotted by id array.
 * One formatting action may touch several paragraphs; they share a single undo
 * entry so one Ctrl+Z reverts the whole action.
 */
export function recordStyleEdit(edits: StyleSnapshot[]): void {
  if (edits.length === 0) return
  redoStack.length = 0
  undoStack.push({ kind: 'style', edits })
}

export function undo(): boolean {
  const entry = undoStack.pop()
  if (!entry) return false
  redoStack.push(entry)
  applyEntry(entry, 'undo')
  return true
}

export function redo(): boolean {
  const entry = redoStack.pop()
  if (!entry) return false
  undoStack.push(entry)
  applyEntry(entry, 'redo')
  return true
}

function applyEntry(entry: HistoryEntry, direction: 'undo' | 'redo'): void {
  if (entry.kind === 'style') {
    for (const e of entry.edits) {
      doc.styleIds[e.para] = (direction === 'undo' ? e.before : e.after).slice()
      markParagraphDirty(e.para)
    }
  } else {
    const edit = direction === 'undo' ? entry.inverse : entry.forward
    applyEdit(edit.paraIndex, edit.offset, edit.deleteCount, edit.insertText, edit.insertIds)
  }
  relayout()
}

/** Merge two pure-typing edits into one undo step when they are contiguous. */
function canCoalesce(last: TextEditEntry, record: EditRecord): boolean {
  const f = last.forward
  if (record.deleteCount !== 0) return false
  if (f.insertText.length === 0 || record.insertText.length === 0) return false
  if (f.insertText.includes('\n') || record.insertText.includes('\n')) return false
  if (f.paraIndex !== record.paraIndex) return false
  if (f.offset + f.insertText.length !== record.offset) return false
  // Both inserts must carry one constant id so the merged entry replays identically.
  const a = constantId(f.insertIds)
  const b = constantId(record.insertIds)
  return a !== null && a === b
}

function concatU16(a: Uint16Array, b: Uint16Array): Uint16Array {
  const out = new Uint16Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function constantId(parts: Uint16Array[]): number | null {
  if (parts.length !== 1 || parts[0].length === 0) return null
  const first = parts[0][0]
  for (const b of parts[0]) {
    if (b !== first) return null
  }
  return first
}
