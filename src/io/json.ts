import { importInput } from '../dom'
import { initHistory } from '../edit/history'
import { addImageFromDataURL, clearImages, convertImageToDataURL } from '../images/images'
import { markAllDirty } from '../model/dirty'
import { reinternTable, styleIdsFromBytes } from '../model/styles'
import { relayout } from '../layout/engine'
import { STYLE_BOLD, STYLE_HEADLINE, STYLE_ITALIC, STYLE_UNDERLINE } from '../model/runs'
import { defaultBlockAttrs, doc } from '../state/doc'
import { view } from '../state/view'
import type { RichSerializedDocument, TextMark } from '../types'

// On-disk format v2 (RICH-TEXT-MODEL.md §4.1): interned style table + per-char
// ids, so rich formatting round-trips. v1 files (TextMark[] offset marks) still
// import; the converter below maps the legacy bits onto the table.

function marksToStyleIds(paragraphs: string[], marks: TextMark[][] | undefined): Uint16Array[] {
  return paragraphs.map((text, paraIndex) => {
    const bytes = new Uint8Array(text.length)
    for (const mark of marks?.[paraIndex] ?? []) {
      if (!mark || typeof mark.start !== 'number' || typeof mark.end !== 'number') continue
      const start = Math.max(0, Math.min(mark.start, text.length))
      const end = Math.max(start, Math.min(mark.end, text.length))
      let bit = 0
      if (mark.bold) bit |= STYLE_BOLD
      if (mark.italic) bit |= STYLE_ITALIC
      if (mark.underline) bit |= STYLE_UNDERLINE
      if (mark.headline) bit |= STYLE_HEADLINE
      if (bit === 0) continue
      for (let i = start; i < end; i++) bytes[i] = bytes[i] | bit
    }
    return styleIdsFromBytes(bytes)
  })
}

export async function exportDocument() {
  const images = await Promise.all(
    view.images.map(async (im) => ({
      x: im.x,
      y: im.y,
      w: im.w,
      h: im.h,
      type: im.img.src.startsWith('data:') ? im.img.src.split(';')[0].slice(5) : 'image/png',
      dataUrl: await convertImageToDataURL(im.img),
    }))
  )
  const documentData: RichSerializedDocument = {
    version: 2,
    paragraphs: doc.paragraphs,
    styleTable: doc.styleTable,
    styleIds: doc.styleIds.map((s) => Array.from(s)),
    images,
  }
  const blob = new Blob([JSON.stringify(documentData, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'pretext-document.json'
  a.click()
  URL.revokeObjectURL(url)
}

export async function importDocument(json: any) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.paragraphs)) throw new Error('Formato non valido')
  clearImages()
  doc.paragraphs = json.paragraphs
  if (json.version === 2 && Array.isArray(json.styleIds) && Array.isArray(json.styleTable)) {
    // Re-intern the serialized table so indices and the key map stay in sync.
    const remap = reinternTable(json.styleTable)
    doc.styleIds = json.styleIds.map((arr: any) => Uint16Array.from(arr.map((old: number) => remap[old] ?? 0)))
  } else {
    doc.styleIds = marksToStyleIds(
      doc.paragraphs,
      Array.isArray(json.marks) && json.marks.every((para: any) => Array.isArray(para)) ? json.marks : undefined
    )
  }
  doc.blockAttrs = doc.paragraphs.map(() => defaultBlockAttrs())
  doc.cursor = { para: 0, offset: 0 }
  doc.selection = null
  view.selectedImageId = null
  if (Array.isArray(json.images)) {
    for (const im of json.images) {
      if (!im || typeof im.dataUrl !== 'string') continue
      await addImageFromDataURL(im.dataUrl, im.x, im.y, im.w, im.h)
    }
  }
  // The replaced document has no undo history.
  initHistory()
  markAllDirty()
  relayout()
}

export function initImportInput() {
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const json = JSON.parse(text)
      await importDocument(json)
    } catch (error) {
      alert('Impossibile importare il documento: file non valido.')
    } finally {
      importInput.value = ''
    }
  })
}
