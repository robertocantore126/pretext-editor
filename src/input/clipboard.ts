// A4 - copy / cut / paste and select-all.
// Owned by Agent A (docs/PARALLEL-PLAN.md).
//
// Copy/cut write text/plain plus a custom MIME carrying the selected spans'
// interned style ids and the referenced style-table entries, so formatting
// survives a round trip inside the editor (RICH-TEXT-MODEL.md §6.5). Paste
// re-interns the entries against the current table (ids are not stable across
// sessions) and prefers the custom MIME over plain text. Image pastes are left
// to the existing handler in input/keyboard.ts.

import { repositionGhostInput } from '../edit/caret'
import { recordEdit } from '../edit/history'
import { relayout } from '../layout/engine'
import { draw } from '../render/draw'
import { applyEdit, selectionDeleteSpec } from '../model/document'
import { internStyle, styleIdsFromBytes } from '../model/styles'
import { getSelectionRanges, setSelection } from '../model/selection'
import { ghostInput } from '../dom'
import { doc } from '../state/doc'
import { defaultStyle } from '../state/doc'
import type { InlineStyle } from '../types/doc'

const CLIP_MIME = 'application/x-pretext-styles'

interface ClipPart {
  text: string
  ids: number[]
  /** The interned entries referenced by `ids`, keyed by id. */
  styles: Record<number, InlineStyle>
}

function getSelectionPayload(): { text: string; parts: ClipPart[]; json: string } | null {
  const ranges = getSelectionRanges()
  if (ranges.length === 0) return null
  const parts: ClipPart[] = ranges.map((r) => {
    const ids = Array.from(doc.styleIds[r.para].slice(r.start, r.end))
    const styles: Record<number, InlineStyle> = {}
    for (const id of ids) {
      if (styles[id] === undefined) styles[id] = doc.styleTable[id] ?? doc.styleTable[0]
    }
    return {
      text: doc.paragraphs[r.para].slice(r.start, r.end),
      ids,
      styles,
    }
  })
  return {
    text: parts.map((p) => p.text).join('\n'),
    parts,
    json: JSON.stringify({ parts }),
  }
}

function insertAtCursor(insertText: string, insertIds?: Uint16Array[]) {
  const normalized = insertText.replace(/\r\n/g, '\n')
  const spec = selectionDeleteSpec()
  const para = spec?.para ?? doc.cursor.para
  const offset = spec?.offset ?? doc.cursor.offset
  const deleteCount = spec?.deleteCount ?? 0
  recordEdit(applyEdit(para, offset, deleteCount, normalized, insertIds))
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
          const newParts = parsed.parts.filter((p: any) => p && typeof p.text === 'string')
          if (newParts.length > 0) {
            // Old ids are not valid in this session's table; re-intern every
            // referenced entry and remap (legacy `bytes` parts convert directly).
            const idMap = new Map<number, number>()
            const remapIds = (ids: number[], styles: Record<number, InlineStyle>): Uint16Array => {
              const out = new Uint16Array(ids.length)
              for (let i = 0; i < ids.length; i++) {
                const old = ids[i]
                let nid = idMap.get(old)
                if (nid === undefined) {
                  nid = internStyle({ ...defaultStyle(), ...(styles[old] ?? {}) })
                  idMap.set(old, nid)
                }
                out[i] = nid
              }
              return out
            }
            const parts: { text: string; ids: Uint16Array }[] = newParts.map((p: any) => {
              if (Array.isArray(p.ids)) return { text: p.text, ids: remapIds(p.ids, p.styles ?? {}) }
              if (Array.isArray(p.bytes)) {
                return { text: p.text, ids: styleIdsFromBytes(Uint8Array.from(p.bytes)) }
              }
              return { text: p.text, ids: new Uint16Array(0) }
            })
            e.preventDefault()
            insertAtCursor(
              parts.map((p) => p.text).join('\n'),
              parts.map((p) => p.ids)
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
