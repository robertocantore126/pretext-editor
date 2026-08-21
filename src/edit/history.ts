// A2 - Undo/redo. Owned by Agent A (docs/PARALLEL-PLAN.md).
//
// Every mutation funnels through applyEdit (model/document.ts) and is recorded
// here by the edit layer (ops.ts, clipboard.ts, marks shim). Text edits are
// replayed as inverse edits through applyEdit, which keeps dirty tracking and
// style bytes consistent for free; style edits restore a one-paragraph byte
// snapshot. Consecutive typed characters coalesce into a single entry.

import { relayout } from '../layout/engine'
import { applyEdit } from '../model/document'
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
  before: Uint8Array
  after: Uint8Array
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
      // Pure typing never contains '\n', so each insertBytes is a single part;
      // merge into one part of the full length (plain concat would keep two
      // parts, breaking the constantByte check on the next keystroke).
      insertBytes: [concatU8(f.insertBytes[0], record.insertBytes[0])],
      deletedText: '',
      deletedBytes: [],
    }
    last.inverse = {
      paraIndex: f.paraIndex,
      offset: f.offset,
      deleteCount: mergedText.length,
      insertText: '',
      insertBytes: [],
      deletedText: mergedText,
      deletedBytes: mergedText.split('\n').map(() => new Uint8Array(0)),
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
      insertBytes: record.deletedBytes,
      deletedText: record.insertText,
      deletedBytes: record.insertBytes,
    },
  })
}

/**
 * Records a styles-only change (model/styles.ts), snapshotted by byte array.
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
      doc.styles[e.para] = (direction === 'undo' ? e.before : e.after).slice()
      markParagraphDirty(e.para)
    }
  } else {
    const edit = direction === 'undo' ? entry.inverse : entry.forward
    applyEdit(edit.paraIndex, edit.offset, edit.deleteCount, edit.insertText, edit.insertBytes)
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
  // Both inserts must carry one constant byte so the merged entry replays identically.
  const a = constantByte(f.insertBytes)
  const b = constantByte(record.insertBytes)
  return a !== null && a === b
}

function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function constantByte(parts: Uint8Array[]): number | null {
  if (parts.length !== 1 || parts[0].length === 0) return null
  const first = parts[0][0]
  for (const b of parts[0]) {
    if (b !== first) return null
  }
  return first
}
