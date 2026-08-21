import { importInput } from '../dom'
import { addImageFromDataURL, clearImages, convertImageToDataURL } from '../images/images'
import { markAllDirty } from '../model/dirty'
import { relayout } from '../layout/engine'
import { STYLE_BOLD, STYLE_HEADLINE, STYLE_ITALIC, STYLE_UNDERLINE } from '../model/runs'
import { doc } from '../state/doc'
import { view } from '../state/view'
import type { SerializedDocument, TextMark } from '../types'

// The on-disk format keeps TextMark[] (offset marks) so previously exported
// .json files keep importing; the editor itself stores style bytes
// (ARCHITECTURE.md §4.5) and these helpers convert at the boundary.

function stylesToMarks(paragraphs: string[], styles: Uint8Array[]): TextMark[][] {
  return paragraphs.map((text, paraIndex) => {
    const bytes = styles[paraIndex]
    const marks: TextMark[] = []
    let i = 0
    while (i < text.length) {
      const byte = bytes?.[i] ?? 0
      if (byte === 0) {
        i++
        continue
      }
      let j = i + 1
      while (j < text.length && (bytes?.[j] ?? 0) === byte) j++
      const mark: TextMark = { start: i, end: j }
      if (byte & STYLE_BOLD) mark.bold = true
      if (byte & STYLE_ITALIC) mark.italic = true
      if (byte & STYLE_UNDERLINE) mark.underline = true
      if (byte & STYLE_HEADLINE) mark.headline = true
      marks.push(mark)
      i = j
    }
    return marks
  })
}

function marksToStyles(paragraphs: string[], marks: TextMark[][] | undefined): Uint8Array[] {
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
    return bytes
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
  const documentData: SerializedDocument = {
    paragraphs: doc.paragraphs,
    marks: stylesToMarks(doc.paragraphs, doc.styles),
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
  doc.styles = marksToStyles(
    doc.paragraphs,
    Array.isArray(json.marks) && json.marks.every((para: any) => Array.isArray(para)) ? json.marks : undefined
  )
  doc.cursor = { para: 0, offset: 0 }
  doc.selection = null
  view.selectedImageId = null
  if (Array.isArray(json.images)) {
    for (const im of json.images) {
      if (!im || typeof im.dataUrl !== 'string') continue
      await addImageFromDataURL(im.dataUrl, im.x, im.y, im.w, im.h)
    }
  }
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
