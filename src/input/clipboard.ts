// A4 - copy / cut / paste and select-all.
// Owned by Agent A (docs/PARALLEL-PLAN.md).
//
// Copy/cut write text/plain plus a custom MIME carrying the selected spans'
// style bytes, so formatting survives a round trip inside the editor. Paste
// prefers the custom MIME, else plain text through applyEdit with the cursor
// style. Image pastes are left to the existing handler in input/keyboard.ts.

import { repositionGhostInput } from '../edit/caret'
import { recordEdit } from '../edit/history'
import { relayout } from '../layout/engine'
import { draw } from '../render/draw'
import { applyEdit, selectionDeleteSpec } from '../model/document'
import { getSelectionRanges, setSelection } from '../model/selection'
import { ghostInput } from '../dom'
import { doc } from '../state/doc'

const CLIP_MIME = 'application/x-pretext-styles'

interface ClipPart {
  text: string
  bytes: number[]
}

function getSelectionPayload(): { text: string; parts: ClipPart[]; json: string } | null {
  const ranges = getSelectionRanges()
  if (ranges.length === 0) return null
  const parts: ClipPart[] = ranges.map((r) => ({
    text: doc.paragraphs[r.para].slice(r.start, r.end),
    bytes: Array.from(doc.styles[r.para].slice(r.start, r.end)),
  }))
  return {
    text: parts.map((p) => p.text).join('\n'),
    parts,
    json: JSON.stringify({ parts }),
  }
}

function insertAtCursor(insertText: string, insertBytes?: Uint8Array[]) {
  const normalized = insertText.replace(/\r\n/g, '\n')
  const spec = selectionDeleteSpec()
  const para = spec?.para ?? doc.cursor.para
  const offset = spec?.offset ?? doc.cursor.offset
  const deleteCount = spec?.deleteCount ?? 0
  recordEdit(applyEdit(para, offset, deleteCount, normalized, insertBytes))
  relayout()
  repositionGhostInput()
}

export function initClipboard(): void {
  document.addEventListener('copy', (e) => {
    const payload = getSelectionPayload()
    if (!payload) return
    e.preventDefault()
    e.clipboardData?.setData('text/plain', payload.text)
    e.clipboardData?.setData(CLIP_MIME, payload.json)
  })

  document.addEventListener('cut', (e) => {
    const payload = getSelectionPayload()
    if (!payload) return
    e.preventDefault()
    e.clipboardData?.setData('text/plain', payload.text)
    e.clipboardData?.setData(CLIP_MIME, payload.json)
    const spec = selectionDeleteSpec()
    if (spec) {
      recordEdit(applyEdit(spec.para, spec.offset, spec.deleteCount, ''))
      relayout()
      repositionGhostInput()
    }
  })

  document.addEventListener('paste', (e) => {
    const cd = e.clipboardData
    if (!cd) return
    // Image pastes are handled by keyboard.ts (it preventDefaults and inserts
    // the file); do not interfere.
    for (const item of cd.items) {
      if (item.type.startsWith('image/')) return
    }
    const styled = cd.getData(CLIP_MIME)
    if (styled) {
      try {
        const parsed = JSON.parse(styled)
        if (parsed && Array.isArray(parsed.parts)) {
          const parts: ClipPart[] = parsed.parts.filter(
            (p: any) => p && typeof p.text === 'string' && Array.isArray(p.bytes)
          )
          if (parts.length > 0) {
            e.preventDefault()
            insertAtCursor(
              parts.map((p) => p.text).join('\n'),
              parts.map((p) => Uint8Array.from(p.bytes))
            )
            return
          }
        }
      } catch {
        // fall through to plain text
      }
    }
    const text = cd.getData('text/plain')
    if (text) {
      e.preventDefault()
      insertAtCursor(text)
    }
  })

  document.addEventListener('keydown', (e) => {
    // Only claim Ctrl+A while the editor itself has focus - selecting an image
    // deliberately blurs the ghost input, and the page may host other inputs.
    if (document.activeElement !== ghostInput) return
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      const last = doc.paragraphs.length - 1
      setSelection({ para: 0, offset: 0 }, { para: last, offset: doc.paragraphs[last].length })
      repositionGhostInput()
      draw()
    }
  })
}
