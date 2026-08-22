// Re-export shim. The mark logic moved to model/styles.ts (byte-based, A1);
// this file keeps the import path in the frozen main.ts alive and records style
// edits into history from the edit layer.

import { relayout } from '../layout/engine'
import {
  applySelectionDecoration as applyDecoration,
  applySelectionMark as applyMark,
  toggleHeadlineForPara as toggleHeadline,
} from '../model/styles'
import { recordStyleEdit } from './history'

export function applySelectionMark(kind: 'bold' | 'italic' | 'underline'): void {
  const edits = applyMark(kind)
  if (edits.length > 0) {
    recordStyleEdit(edits)
    relayout()
  }
}

export function applySelectionDecoration(id: string | null): void {
  const edits = applyDecoration(id)
  if (edits.length > 0) {
    recordStyleEdit(edits)
    relayout()
  }
}

export function toggleHeadlineForPara(): void {
  const edits = toggleHeadline()
  if (edits.length > 0) {
    recordStyleEdit(edits)
    relayout()
  }
}
