import { jsPDF } from 'jspdf'
import {
  prepareWithSegments,
  layoutNextLineRange,
  materializeLineRange,
  type LayoutCursor,
  type PreparedTextWithSegments,
} from '@chenglou/pretext'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FONT_SIZE = 17
const LINE_HEIGHT = 27
const FONT_FAMILY = `"Georgia", "Iowan Old Style", "Palatino Linotype", serif`
const FONT = `${FONT_SIZE}px ${FONT_FAMILY}`
const PAD_X = 48
const PAD_Y = 40
const PAGE_HEIGHT = 1060
const PAGE_GAP = 24
const PARA_GAP = 8
const MIN_LINE_WIDTH = 40 // below this we push the line down instead of trying to fit text
const MAX_LAYOUT_STEPS_PER_PARA = 4000 // safety guard against runaway loops

const INK = '#2a2420'
const CARET_COLOR = '#7c3aed'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FloatImage {
  id: string
  img: HTMLImageElement
  wrapper: HTMLDivElement
  x: number
  y: number
  w: number
  h: number
  loaded: boolean
  objectUrl: string
  alphaMap?: { w: number; h: number; data: Uint8Array; scale: number }
}

interface LineInfo {
  paraIndex: number
  text: string
  x: number
  yTop: number
  width: number
  startOffset: number
  endOffset: number
}

interface Cursor {
  para: number
  offset: number
}

interface Selection {
  anchor: Cursor
  focus: Cursor
}

interface TextMark {
  start: number
  end: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  headline?: boolean
}

interface SerializedImage {
  x: number
  y: number
  w: number
  h: number
  type: string
  dataUrl: string
}

interface SerializedDocument {
  paragraphs: string[]
  marks: TextMark[][]
  images: SerializedImage[]
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  paragraphs: [
    'Scrivi qui il tuo documento. Il testo viene impaginato da pretext senza mai toccare il DOM per la misura: incolla un\u2019immagine (Ctrl/Cmd+V) oppure trascinala qui dentro da fuori, poi spostala per vedere il testo ricalcolare la propria larghezza riga per riga attorno ad essa.',
    '',
  ],
  marks: [[], []] as TextMark[][],
  cursor: { para: 0, offset: 0 } as Cursor,
  selection: null as Selection | null,
  images: [] as FloatImage[],
  selectedImageId: null as string | null,
  lines: [] as LineInfo[],
  runCache: {} as { [para: number]: { start: number; end: number; text: string; style: { bold: boolean; italic: boolean; underline: boolean; headline: boolean }; charWidths: number[]; width: number }[] },
  prepared: {} as { [para: number]: { text: string; start: number; end: number; style: { bold: boolean; italic: boolean; underline: boolean; headline: boolean }; width: number }[] },
  docWidth: 0,
  docHeight: 0,
  focused: false,
  caretVisible: true,
  dragging: null as null | { id: string; mode: 'move' | 'resize'; startX: number; startY: number; origX: number; origY: number; origW: number; origH: number; aspect: number },
}

// ---------------------------------------------------------------------------
// DOM scaffold
// ---------------------------------------------------------------------------

const app = document.getElementById('app')!

const toolbar = document.createElement('div')
toolbar.className = 'toolbar'
toolbar.innerHTML = `
  <h1>Editor pretext</h1>
  <button id="btn-clear" type="button">Nuovo documento</button>
  <button id="btn-bold" type="button">Grassetto</button>
  <button id="btn-italic" type="button">Corsivo</button>
  <button id="btn-underline" type="button">Sottolineato</button>
  <button id="btn-headline" type="button">Titolo</button>
  <button id="btn-export" type="button">Esporta (HTML)</button>
  <button id="btn-export-json" type="button">Esporta JSON</button>
  <button id="btn-export-pdf" type="button">Esporta PDF</button>
  <button id="btn-import" type="button">Importa</button>
`
app.appendChild(toolbar)

const hint = document.createElement('div')
hint.className = 'hint'
hint.textContent = 'Clicca ed inizia a scrivere. Incolla un\u2019immagine con Ctrl/Cmd+V oppure trascinala qui dentro dal tuo computer.'
app.appendChild(hint)

const docWrap = document.createElement('div')
docWrap.className = 'doc-wrap'
docWrap.tabIndex = 0
app.appendChild(docWrap)

const canvas = document.createElement('canvas')
canvas.className = 'doc-canvas'
docWrap.appendChild(canvas)

const emptyHint = document.createElement('div')
emptyHint.className = 'empty-hint'
emptyHint.style.left = PAD_X + 'px'
emptyHint.style.top = PAD_Y + 'px'
emptyHint.style.font = FONT
emptyHint.textContent = ''
docWrap.appendChild(emptyHint)

const ghostInput = document.createElement('textarea')
ghostInput.className = 'caret-input'
ghostInput.setAttribute('autocapitalize', 'off')
ghostInput.setAttribute('autocomplete', 'off')
ghostInput.setAttribute('spellcheck', 'false')
docWrap.appendChild(ghostInput)

docWrap.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.img-handle')) return
  ghostInput.focus()
})

const importInput = document.createElement('input')
importInput.type = 'file'
importInput.accept = '.json,application/json'
importInput.style.display = 'none'
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
docWrap.appendChild(importInput)

const ctx = canvas.getContext('2d')!
const measureCanvas = document.createElement('canvas')
const measureCtx = measureCanvas.getContext('2d')!
measureCtx.font = FONT

document.getElementById('btn-clear')!.addEventListener('click', () => {
  if (!confirm('Cancellare il documento e tutte le immagini?')) return
  clearDocument()
  state.paragraphs = ['']
  state.marks = [[]]
  state.cursor = { para: 0, offset: 0 }
  state.selection = null
  state.selectedImageId = null
  relayout()
})

document.getElementById('btn-bold')!.addEventListener('click', () => applySelectionMark('bold'))
document.getElementById('btn-italic')!.addEventListener('click', () => applySelectionMark('italic'))
document.getElementById('btn-underline')!.addEventListener('click', () => applySelectionMark('underline'))
document.getElementById('btn-headline')!.addEventListener('click', () => toggleHeadlineForPara())

document.getElementById('btn-export')!.addEventListener('click', async () => {
  try {
    await exportHTML()
  } catch (error) {
    alert('Errore durante l’esportazione del documento.')
  }
})

document.getElementById('btn-export-json')!.addEventListener('click', async () => {
  try {
    await exportDocument()
  } catch (error) {
    alert('Errore durante l’esportazione JSON.')
  }
})

document.getElementById('btn-export-pdf')!.addEventListener('click', async () => {
  try {
    await exportPDF()
  } catch (error) {
    alert('Errore durante l’esportazione PDF.')
  }
})

document.getElementById('btn-import')!.addEventListener('click', () => {
  importInput.click()
})

// ---------------------------------------------------------------------------
// Layout: figure out the free horizontal slot for a line given floating images
// ---------------------------------------------------------------------------

async function exportDocument() {
  const images = await Promise.all(
    state.images.map(async (im) => ({
      x: im.x,
      y: im.y,
      w: im.w,
      h: im.h,
      type: im.img.src.startsWith('data:') ? im.img.src.split(';')[0].slice(5) : 'image/png',
      dataUrl: await convertImageToDataURL(im.img),
    }))
  )
  const documentData: SerializedDocument = {
    paragraphs: state.paragraphs,
    marks: state.marks,
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

async function importDocument(json: any) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.paragraphs)) throw new Error('Formato non valido')
  clearDocument()
  state.paragraphs = json.paragraphs
  state.marks = Array.isArray(json.marks) && json.marks.every((para: any) => Array.isArray(para))
    ? json.marks.map((para: any) => para.filter((mark: any) => typeof mark.start === 'number' && typeof mark.end === 'number'))
    : state.paragraphs.map(() => [])
  state.cursor = { para: 0, offset: 0 }
  state.selection = null
  state.selectedImageId = null
  if (Array.isArray(json.images)) {
    for (const im of json.images) {
      if (!im || typeof im.dataUrl !== 'string') continue
      await addImageFromDataURL(im.dataUrl, im.x, im.y, im.w, im.h)
    }
  }
  relayout()
}

function clearDocument() {
  for (const im of state.images) URL.revokeObjectURL(im.objectUrl)
  for (const im of state.images) im.wrapper.remove()
  state.images = []
}

function convertImageToDataURL(img: HTMLImageElement): Promise<string> {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx2 = canvas.getContext('2d')!
    ctx2.drawImage(img, 0, 0)
    resolve(canvas.toDataURL('image/png'))
  })
}

function addImageFromDataURL(dataUrl: string, x: number, y: number, w: number, h: number) {
  const imgEl = new Image()
  const wrapper = document.createElement('div')
  wrapper.className = 'img-handle'
  wrapper.appendChild(imgEl)
  const grip = document.createElement('div')
  grip.className = 'resize-grip'
  const del = document.createElement('div')
  del.className = 'delete-btn'
  del.textContent = ' d7'
  wrapper.appendChild(grip)
  wrapper.appendChild(del)
  docWrap.appendChild(wrapper)
  imgEl.style.width = '100%'
  imgEl.style.height = '100%'
  imgEl.style.display = 'block'
  imgEl.style.userSelect = 'none'
  imgEl.draggable = false

  const id = 'img-' + ++imgCounter
  const rec: FloatImage = { id, img: imgEl, wrapper, x, y, w, h, loaded: false, objectUrl: dataUrl }
  state.images.push(rec)

  imgEl.onload = () => {
    rec.loaded = true
    relayout()
    buildAlphaMapForImage(rec)
  }
  imgEl.src = dataUrl

  wrapper.addEventListener('mousedown', (e) => {
    e.stopPropagation()
    selectImage(id)
    state.dragging = {
      id,
      mode: 'move',
      startX: e.clientX,
      startY: e.clientY,
      origX: rec.x,
      origY: rec.y,
      origW: rec.w,
      origH: rec.h,
      aspect: rec.w / rec.h,
    }
  })
  grip.addEventListener('mousedown', (e) => {
    e.stopPropagation()
    selectImage(id)
    state.dragging = {
      id,
      mode: 'resize',
      startX: e.clientX,
      startY: e.clientY,
      origX: rec.x,
      origY: rec.y,
      origW: rec.w,
      origH: rec.h,
      aspect: rec.w / rec.h,
    }
  })
  del.addEventListener('mousedown', (e) => e.stopPropagation())
  del.addEventListener('click', (e) => {
    e.stopPropagation()
    deleteImage(id)
  })
}

function computeLineSlots(y: number, lineH: number, docWidth: number): { x: number; width: number }[] {
  const intervals: [number, number][] = []
  for (const im of state.images) {
    if (!im.loaded) continue
    if (im.y < y + lineH && im.y + im.h > y) {
      // if we have an alpha map, compute silhouette intersection for this scan region
      if (im.alphaMap) {
        const map = im.alphaMap
        // determine the range of rows in alpha map that intersect this visual line
        const relY0 = Math.max(0, y - im.y)
        const relY1 = Math.min(lineH, im.y + im.h - y)
        const startRow = Math.floor((relY0 / im.h) * map.h)
        const endRow = Math.ceil(((relY0 + relY1) / im.h) * map.h)
        let minX = docWidth
        let maxX = 0
        for (let r = startRow; r < endRow; r++) {
          if (r < 0 || r >= map.h) continue
          // scan this row for occupied pixels
          let rowMin = -1
          let rowMax = -1
          for (let cx = 0; cx < map.w; cx++) {
            if (map.data[r * map.w + cx]) {
              if (rowMin === -1) rowMin = cx
              rowMax = cx
            }
          }
          if (rowMin !== -1) {
            const docMinX = im.x + (rowMin / map.w) * im.w
            const docMaxX = im.x + ((rowMax + 1) / map.w) * im.w
            minX = Math.min(minX, docMinX)
            maxX = Math.max(maxX, docMaxX)
          }
        }
        if (maxX > minX) {
          const a = Math.max(0, Math.floor(minX))
          const b = Math.min(docWidth, Math.ceil(maxX))
          if (b > a) intervals.push([a, b])
          continue
        }
      }
      // fallback to rectangle
      const a = Math.max(0, im.x)
      const b = Math.min(docWidth, im.x + im.w)
      if (b > a) intervals.push([a, b])
    }
  }
  if (intervals.length === 0) return [{ x: 0, width: docWidth }]
  intervals.sort((p, q) => p[0] - q[0])
  const merged: [number, number][] = []
  for (const iv of intervals) {
    const last = merged[merged.length - 1]
    if (last && iv[0] <= last[1] + 4) {
      last[1] = Math.max(last[1], iv[1])
    } else {
      merged.push([iv[0], iv[1]])
    }
  }
  const slots: { x: number; width: number }[] = []
  let cursorX = 0
  for (const [a, b] of merged) {
    const gap = a - cursorX
    if (gap >= MIN_LINE_WIDTH) slots.push({ x: cursorX, width: gap })
    cursorX = Math.max(cursorX, b)
  }
  const tail = docWidth - cursorX
  if (tail >= MIN_LINE_WIDTH) slots.push({ x: cursorX, width: tail })
  if (slots.length === 0) {
    return [{ x: 0, width: docWidth }]
  }
  return slots
}

function layoutParagraph(text: string, docWidth: number, startY: number, paraIndex: number): { lines: LineInfo[]; height: number } {
  const lines: LineInfo[] = []

  if (text.length === 0) {
    lines.push({ paraIndex, text: '', x: 0, yTop: startY, width: docWidth, startOffset: 0, endOffset: 0 })
    return { lines, height: LINE_HEIGHT }
  }

  const paraMarks: TextMark[] = (state as any).marks?.[paraIndex] || []

  function getStyleAt(absPos: number) {
    const style = { bold: false, italic: false, underline: false, headline: false }
    for (const m of paraMarks) {
      if (m.start <= absPos && absPos < m.end) {
        if (m.bold) style.bold = true
        if (m.italic) style.italic = true
        if (m.underline) style.underline = true
        if (m.headline) style.headline = true
      }
    }
    return style
  }

  // build runs cache for this paragraph to speed up width calculations
  function computeRuns() {
    const runs: { start: number; end: number; text: string; style: { bold: boolean; italic: boolean; underline: boolean; headline: boolean }; charWidths: number[]; width: number }[] = []
    let i = 0
    while (i < text.length) {
      const abs = i
      const style = getStyleAt(abs)
      let runLen = 1
      while (i + runLen < text.length) {
        const s2 = getStyleAt(i + runLen)
        if (s2.bold !== style.bold || s2.italic !== style.italic || s2.underline !== style.underline || s2.headline !== style.headline) break
        runLen++
      }
      const seg = text.slice(i, i + runLen)
      const fontSize = style.headline ? Math.round(FONT_SIZE * 1.6) : FONT_SIZE
      const parts: string[] = []
      if (style.italic) parts.push('italic')
      if (style.bold) parts.push('700')
      parts.push(fontSize + 'px')
      measureCtx.font = parts.join(' ') + ' ' + FONT_FAMILY
      const charWidths: number[] = []
      for (let k = 0; k < seg.length; k++) {
        const w = measureCtx.measureText(seg[k]).width
        charWidths.push(w)
      }
      const width = charWidths.reduce((a, b) => a + b, 0)
      runs.push({ start: i, end: i + runLen, text: seg, style, charWidths, width })
      i += runLen
    }
    state.runCache[paraIndex] = runs
  }

  computeRuns()

  function measureRunWidth(str: string, globalStart: number) {
    // use precomputed runs to sum widths quickly for substring starting at globalStart
    const runs = state.runCache[paraIndex] || []
    if (str.length === 0) return 0
    let remaining = str.length
    let cursor = globalStart
    let acc = 0
    for (const r of runs) {
      if (r.end <= cursor) continue
      if (remaining <= 0) break
      const runLocalStart = Math.max(0, cursor - r.start)
      const take = Math.min(r.end - (r.start + runLocalStart), remaining)
      if (take <= 0) continue
      for (let k = 0; k < take; k++) acc += r.charWidths[runLocalStart + k]
      cursor += take
      remaining -= take
    }
    return acc
  }

  let pos = 0
  let y = startY
  let steps = 0
  while (pos < text.length && steps++ < MAX_LAYOUT_STEPS_PER_PARA) {
    // default line height; if any headline in upcoming chars, increase height
    const upcomingHasHeadline = paraMarks.some((m) => m.headline && m.end > pos && m.start <= pos + 40)
    const lineH = upcomingHasHeadline ? Math.round(FONT_SIZE * 1.6 * 1.4) : LINE_HEIGHT
    const slots = computeLineSlots(y, lineH, docWidth)
    if (slots.every((s) => s.width < MIN_LINE_WIDTH)) {
      y += 6
      continue
    }
    let anyPlaced = false
    // try pretext layout first if prepared segments exist
    const preparedSegs = (state as any).prepared?.[paraIndex]
    if (preparedSegs && typeof prepareWithSegments === 'function') {
      try {
        const prepared = (prepareWithSegments as any)(preparedSegs.map((s: any) => ({ text: s.text, attrs: s.style, width: s.width })))
        for (const slot of slots) {
          if (pos >= text.length) break
          const range = (layoutNextLineRange as any)(prepared, { offset: pos }, slot.width)
          if (!range) continue
          const mat = (materializeLineRange as any)(prepared, range)
          const segText = mat?.text ?? mat?.str ?? text.slice(range.start ?? pos, range.end ?? pos + 1)
          const startOff = typeof range.start === 'number' ? range.start : pos
          const endOff = typeof range.end === 'number' ? range.end : (startOff + segText.length)
          lines.push({ paraIndex, text: segText, x: slot.x, yTop: y, width: slot.width, startOffset: startOff, endOffset: endOff })
          pos = endOff
          anyPlaced = true
        }
      } catch (err) {
        // if pretext integration fails, fallback to greedy below
        // console.warn('pretext layout failed, falling back', err)
      }
    }

    // fallback greedy layout if pretext didn't place anything
    if (!anyPlaced) {
      for (const slot of slots) {
        if (pos >= text.length) break
        // fill this slot greedily
        let consumed = 0
        let lastGood = 0
        while (pos + consumed < text.length) {
          const substr = text.slice(pos, pos + consumed + 1)
          const w = measureRunWidth(substr, pos)
          if (w > slot.width) break
          if (substr[substr.length - 1] === ' ' || substr[substr.length - 1] === '\t') lastGood = consumed + 1
          consumed++
        }
        if (consumed === 0) continue
        if (pos + consumed < text.length && lastGood > 0) consumed = lastGood
        const segText = text.slice(pos, pos + consumed)
        lines.push({ paraIndex, text: segText, x: slot.x, yTop: y, width: slot.width, startOffset: pos, endOffset: pos + consumed })
        pos += consumed
        anyPlaced = true
      }
    }
    if (!anyPlaced) {
      y += 6
      continue
    }
    y += lineH
  }

  if (lines.length === 0) {
    lines.push({ paraIndex, text: '', x: 0, yTop: startY, width: docWidth, startOffset: 0, endOffset: 0 })
    y = startY + LINE_HEIGHT
  }

  return { lines, height: y - startY }
}

function prepareSegmentsForPara(paraIndex: number) {
  const runs = state.runCache[paraIndex] || []
  const segs: { text: string; start: number; end: number; style: { bold: boolean; italic: boolean; underline: boolean; headline: boolean }; width: number }[] = []
  for (const r of runs) {
    segs.push({ text: r.text, start: r.start, end: r.end, style: r.style, width: r.width })
  }
  state.prepared[paraIndex] = segs
}

// ---------------------------------------------------------------------------
// Full relayout + draw
// ---------------------------------------------------------------------------

function docToVisualY(docY: number): number {
  return docY + Math.floor(docY / PAGE_HEIGHT) * PAGE_GAP
}

function visualToDocY(visualY: number): number {
  const pageSize = PAGE_HEIGHT + PAGE_GAP
  const pageIndex = Math.floor(visualY / pageSize)
  const pageStart = pageIndex * pageSize
  const within = visualY - pageStart
  if (within > PAGE_HEIGHT) {
    return pageIndex * PAGE_HEIGHT
  }
  return pageIndex * PAGE_HEIGHT + within
}

function relayout() {
  const cssWidth = docWrap.clientWidth || 800
  const docWidth = Math.max(80, cssWidth - PAD_X * 2)
  state.docWidth = docWidth

  const lines: LineInfo[] = []
  let y = 0
  state.paragraphs.forEach((p, i) => {
    // prepare styled segments/runs for potential pretext layout
    prepareSegmentsForPara(i)
    const { lines: paraLines, height } = layoutParagraph(p, docWidth, y, i)
    lines.push(...paraLines)
    y += height + (i < state.paragraphs.length - 1 ? PARA_GAP : 0)
  })
  state.lines = lines
  const textHeight = y

  let maxImageBottom = 0
  for (const im of state.images) maxImageBottom = Math.max(maxImageBottom, im.y + im.h)

  const docHeight = Math.max(textHeight, maxImageBottom)
  state.docHeight = docHeight

  const pageCount = Math.max(1, Math.ceil(docHeight / PAGE_HEIGHT))
  const visualHeight = pageCount * PAGE_HEIGHT + (pageCount - 1) * PAGE_GAP

  const cssHeight = Math.max(160, visualHeight + PAD_Y * 2)
  const dpr = window.devicePixelRatio || 1
  canvas.style.width = cssWidth + 'px'
  canvas.style.height = cssHeight + 'px'
  canvas.width = Math.round(cssWidth * dpr)
  canvas.height = Math.round(cssHeight * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  docWrap.style.height = cssHeight + 'px'

  for (const im of state.images) {
    im.wrapper.style.left = PAD_X + im.x + 'px'
    im.wrapper.style.top = PAD_Y + docToVisualY(im.y) + 'px'
    im.wrapper.style.width = im.w + 'px'
    im.wrapper.style.height = im.h + 'px'
  }

  draw()
}

function draw() {
  const cssWidth = parseFloat(canvas.style.width)
  const cssHeight = parseFloat(canvas.style.height)
  ctx.clearRect(0, 0, cssWidth, cssHeight)
  ctx.font = FONT
  ctx.fillStyle = INK
  ctx.textBaseline = 'alphabetic'

  const isEmptyDoc = state.paragraphs.length === 1 && state.paragraphs[0] === '' && state.images.length === 0
  emptyHint.style.display = isEmptyDoc && !state.focused ? 'block' : 'none'
  if (isEmptyDoc && !state.focused) {
    emptyHint.textContent = 'Clicca qui per iniziare a scrivere\u2026'
    emptyHint.style.font = FONT
  }

  const baselineOffset = FONT_SIZE * 0.92
  const pageCount = Math.max(1, Math.ceil(state.docHeight / PAGE_HEIGHT))
  ctx.fillStyle = '#f7f5f1'
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const top = PAD_Y + pageIndex * (PAGE_HEIGHT + PAGE_GAP)
    ctx.fillRect(PAD_X - 8, top - 8, state.docWidth + 16, PAGE_HEIGHT + 16)
    ctx.strokeStyle = '#d3d0c8'
    ctx.lineWidth = 1
    ctx.strokeRect(PAD_X - 8, top - 8, state.docWidth + 16, PAGE_HEIGHT + 16)
  }

  ctx.fillStyle = INK
  // draw selection background if any
  if (state.selection) {
    const a = state.selection.anchor
    const b = state.selection.focus
    if (a.para === b.para) {
      const para = a.para
      const start = Math.min(a.offset, b.offset)
      const end = Math.max(a.offset, b.offset)
      for (const line of state.lines) {
        if (line.paraIndex !== para) continue
        const s = Math.max(line.startOffset, start)
        const e = Math.min(line.endOffset, end)
        if (e <= s) continue
        const leftPart = line.text.slice(0, s - line.startOffset)
        const midPart = line.text.slice(s - line.startOffset, e - line.startOffset)
        const segLeft = PAD_X + line.x + measureTextWidthOnPara(line.paraIndex, leftPart, line.startOffset)
        const segWidth = measureTextWidthOnPara(line.paraIndex, midPart, s)
        const top = PAD_Y + docToVisualY(line.yTop)
        const lineH = paraHasHeadlineInRange(line.paraIndex, line.startOffset, line.endOffset) ? Math.round(FONT_SIZE * 1.6 * 1.4) : LINE_HEIGHT
        ctx.fillStyle = 'rgba(124,58,237,0.12)'
        ctx.fillRect(segLeft, top + 4, segWidth, lineH - 8)
        ctx.fillStyle = INK
      }
    }
  }

  for (const line of state.lines) {
    if (!line.text) continue
    const paraMarks = (state as any).marks?.[line.paraIndex] || []
    let xPos = PAD_X + line.x
    const globalStart = line.startOffset
    let i = 0
    while (i < line.text.length) {
      const absPos = globalStart + i
      // compute style at this position
      const style = { bold: false, italic: false, underline: false, headline: false }
      for (const m of paraMarks) {
        if (m.start <= absPos && absPos < m.end) {
          if (m.bold) style.bold = true
          if (m.italic) style.italic = true
          if (m.underline) style.underline = true
          if (m.headline) style.headline = true
        }
      }
      // extend run while style unchanged
      let runLen = 1
      while (i + runLen < line.text.length) {
        const abs2 = globalStart + i + runLen
        const style2 = { bold: false, italic: false, underline: false, headline: false }
        for (const m of paraMarks) {
          if (m.start <= abs2 && abs2 < m.end) {
            if (m.bold) style2.bold = true
            if (m.italic) style2.italic = true
            if (m.underline) style2.underline = true
            if (m.headline) style2.headline = true
          }
        }
        if (style.bold !== style2.bold || style.italic !== style2.italic || style.underline !== style2.underline || style.headline !== style2.headline) break
        runLen++
      }
      const segText = line.text.slice(i, i + runLen)
      // set font with style
      const parts: string[] = []
      const fontSize = style.headline ? Math.round(FONT_SIZE * 1.6) : FONT_SIZE
      if (style.italic) parts.push('italic')
      if (style.bold) parts.push('700')
      parts.push(fontSize + 'px')
      ctx.font = parts.join(' ') + ' ' + FONT_FAMILY
      // draw text with computed baseline for this font size
      const localBaseline = fontSize * 0.92
      ctx.fillText(segText, xPos, PAD_Y + docToVisualY(line.yTop) + localBaseline)
      // measure and maybe underline
      measureCtx.font = ctx.font
      const w = measureCtx.measureText(segText).width
      if (style.underline) {
        const uy = PAD_Y + docToVisualY(line.yTop) + localBaseline + 2
        ctx.strokeStyle = INK
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(xPos, uy)
        ctx.lineTo(xPos + w, uy)
        ctx.stroke()
      }
      xPos += w
      i += runLen
      ctx.font = FONT
    }
  }

  if (state.focused && state.caretVisible) {
    const pos = caretPixelPosition()
    if (pos) {
      const visualY = docToVisualY(pos.y)
      ctx.strokeStyle = CARET_COLOR
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(PAD_X + pos.x, PAD_Y + visualY + 2)
      ctx.lineTo(PAD_X + pos.x, PAD_Y + visualY + LINE_HEIGHT - 5)
      ctx.stroke()
    }
  }
}

// ---------------------------------------------------------------------------
// Cursor <-> pixel mapping
// ---------------------------------------------------------------------------

function lineForCursor(c: Cursor): LineInfo | null {
  const candidates = state.lines.filter((l) => l.paraIndex === c.para)
  if (candidates.length === 0) return null
  for (const l of candidates) {
    if (c.offset >= l.startOffset && c.offset <= l.endOffset) {
      // prefer a line that isn't the wrap-continuation unless offset matches exactly
      if (c.offset < l.endOffset || l === candidates[candidates.length - 1]) return l
    }
  }
  return candidates[candidates.length - 1]
}

function measureSubWidth(text: string): number {
  measureCtx.font = FONT
  return measureCtx.measureText(text).width
}

function paraHasHeadlineInRange(paraIndex: number, start: number, end: number) {
  const paraMarks: TextMark[] = (state as any).marks?.[paraIndex] || []
  return paraMarks.some((m) => m.headline && m.end > start && m.start < end)
}

function measureTextWidthOnPara(paraIndex: number, text: string, globalStart: number) {
  // use runCache if available
  const runs = state.runCache[paraIndex] || []
  if (text.length === 0) return 0
  let remaining = text.length
  let cursor = globalStart
  let acc = 0
  for (const r of runs) {
    if (r.end <= cursor) continue
    if (remaining <= 0) break
    const runLocalStart = Math.max(0, cursor - r.start)
    const take = Math.min(r.end - (r.start + runLocalStart), remaining)
    if (take <= 0) continue
    for (let k = 0; k < take; k++) acc += r.charWidths[runLocalStart + k]
    cursor += take
    remaining -= take
  }
  return acc
}

function caretPixelPosition(): { x: number; y: number } | null {
  const line = lineForCursor(state.cursor)
  if (!line) return null
  const within = Math.max(0, Math.min(state.cursor.offset - line.startOffset, line.text.length))
  const x = line.x + measureTextWidthOnPara(line.paraIndex, line.text.slice(0, within), line.startOffset)
  return { x, y: line.yTop }
}

function pixelToCursor(px: number, py: number): Cursor {
  const docY = visualToDocY(py)
  if (state.lines.length === 0) return { para: 0, offset: 0 }
    const candidates = state.lines.filter((l) => docY >= l.yTop && docY < l.yTop + LINE_HEIGHT)
  let best: LineInfo
  if (candidates.length > 0) {
    const inside = candidates.find((l) => px >= l.x && px <= l.x + l.width)
    best = inside ?? candidates.reduce((prev, cur) => {
      const prevDist = Math.abs(px - (prev.x + prev.width / 2))
      const curDist = Math.abs(px - (cur.x + cur.width / 2))
      return curDist < prevDist ? cur : prev
    })
  } else {
    best = state.lines[0]
    for (const l of state.lines) {
      if (py >= l.yTop && py < l.yTop + LINE_HEIGHT) {
        best = l
        break
      }
      if (l.yTop <= py) best = l
    }
  }
  const localX = px - best.x
  let acc = 0
  let offset = best.startOffset
  const text = best.text
  let prevStyle: any = null
  for (let i = 0; i < text.length; i++) {
    const abs = best.startOffset + i
    const paraMarks: TextMark[] = (state as any).marks?.[best.paraIndex] || []
    const style = { bold: false, italic: false, underline: false, headline: false }
    for (const m of paraMarks) {
      if (m.start <= abs && abs < m.end) {
        if (m.bold) style.bold = true
        if (m.italic) style.italic = true
        if (m.underline) style.underline = true
        if (m.headline) style.headline = true
      }
    }
    // use runCache for faster per-char widths when available
    const runs = state.runCache[best.paraIndex] || []
    let w = 0
    // find run containing this abs
    for (const r of runs) {
      if (abs >= r.start && abs < r.end) {
        w = r.charWidths[abs - r.start]
        break
      }
    }
    if (!w) {
      // fallback
      const fontSize = style.headline ? Math.round(FONT_SIZE * 1.6) : FONT_SIZE
      const parts: string[] = []
      if (style.italic) parts.push('italic')
      if (style.bold) parts.push('700')
      parts.push(fontSize + 'px')
      measureCtx.font = parts.join(' ') + ' ' + FONT_FAMILY
      w = measureCtx.measureText(text[i]).width
    }
    if (acc + w / 2 > localX) {
      offset = best.startOffset + i
      return { para: best.paraIndex, offset }
    }
    acc += w
  }
  offset = best.endOffset
  return { para: best.paraIndex, offset }
}

// ---------------------------------------------------------------------------
// Text editing operations
// ---------------------------------------------------------------------------

function currentParaText(): string {
  return state.paragraphs[state.cursor.para]
}

function insertTextAtCursor(str: string) {
  if (str.length === 0) return
  const normalized = str.replace(/\r\n/g, '\n')
  if (normalized.includes('\n')) {
    const parts = normalized.split('\n')
    const para = currentParaText()
    const before = para.slice(0, state.cursor.offset)
    const after = para.slice(state.cursor.offset)
    const newParas = [before + parts[0]]
    for (let i = 1; i < parts.length - 1; i++) newParas.push(parts[i])
    newParas.push(parts[parts.length - 1] + after)
    state.paragraphs.splice(state.cursor.para, 1, ...newParas)
    state.cursor = { para: state.cursor.para + parts.length - 1, offset: parts[parts.length - 1].length }
  } else {
    const para = currentParaText()
    const before = para.slice(0, state.cursor.offset)
    const after = para.slice(state.cursor.offset)
    state.paragraphs[state.cursor.para] = before + normalized + after
    state.cursor.offset += normalized.length
  }
  relayout()
}

function splitParagraphAtCursor() {
  const para = currentParaText()
  const before = para.slice(0, state.cursor.offset)
  const after = para.slice(state.cursor.offset)
  state.paragraphs.splice(state.cursor.para, 1, before, after)
  state.cursor = { para: state.cursor.para + 1, offset: 0 }
  relayout()
}

function backspaceAtCursor() {
  if (state.cursor.offset > 0) {
    const para = currentParaText()
    state.paragraphs[state.cursor.para] = para.slice(0, state.cursor.offset - 1) + para.slice(state.cursor.offset)
    state.cursor.offset -= 1
  } else if (state.cursor.para > 0) {
    const prevLen = state.paragraphs[state.cursor.para - 1].length
    state.paragraphs[state.cursor.para - 1] += state.paragraphs[state.cursor.para]
    state.paragraphs.splice(state.cursor.para, 1)
    state.cursor = { para: state.cursor.para - 1, offset: prevLen }
  } else {
    return
  }
  relayout()
}

function deleteForwardAtCursor() {
  const para = currentParaText()
  if (state.cursor.offset < para.length) {
    state.paragraphs[state.cursor.para] = para.slice(0, state.cursor.offset) + para.slice(state.cursor.offset + 1)
  } else if (state.cursor.para < state.paragraphs.length - 1) {
    state.paragraphs[state.cursor.para] += state.paragraphs[state.cursor.para + 1]
    state.paragraphs.splice(state.cursor.para + 1, 1)
  } else {
    return
  }
  relayout()
}

function moveLeft() {
  if (state.cursor.offset > 0) state.cursor.offset -= 1
  else if (state.cursor.para > 0) {
    state.cursor.para -= 1
    state.cursor.offset = state.paragraphs[state.cursor.para].length
  }
  resetCaretBlink()
  draw()
  repositionGhostInput()
}

function moveRight() {
  const len = currentParaText().length
  if (state.cursor.offset < len) state.cursor.offset += 1
  else if (state.cursor.para < state.paragraphs.length - 1) {
    state.cursor.para += 1
    state.cursor.offset = 0
  }
  resetCaretBlink()
  draw()
  repositionGhostInput()
}

function moveVertical(dir: 1 | -1) {
  const pos = caretPixelPosition()
  if (!pos) return
  const targetY = pos.y + dir * LINE_HEIGHT
  const targetX = PAD_X + pos.x - PAD_X // keep in doc coords
  const c = pixelToCursor(pos.x, targetY)
  state.cursor = c
  resetCaretBlink()
  draw()
  repositionGhostInput()
}

// ---------------------------------------------------------------------------
// Ghost input (captures keystrokes / IME) + focus handling
// ---------------------------------------------------------------------------

function repositionGhostInput() {
  const pos = caretPixelPosition()
  if (!pos) return
  const visualY = docToVisualY(pos.y)
  ghostInput.style.left = PAD_X + pos.x + 'px'
  ghostInput.style.top = PAD_Y + visualY + 'px'
}

let blinkTimer: number | undefined
function resetCaretBlink() {
  state.caretVisible = true
  if (blinkTimer) window.clearInterval(blinkTimer)
  blinkTimer = window.setInterval(() => {
    state.caretVisible = !state.caretVisible
    draw()
  }, 530)
}
function stopCaretBlink() {
  if (blinkTimer) window.clearInterval(blinkTimer)
  blinkTimer = undefined
  state.caretVisible = false
}

ghostInput.addEventListener('focus', () => {
  state.focused = true
  resetCaretBlink()
  draw()
})
ghostInput.addEventListener('blur', () => {
  state.focused = false
  stopCaretBlink()
  draw()
})

ghostInput.addEventListener('input', () => {
  const val = ghostInput.value
  ghostInput.value = ''
  if (val) insertTextAtCursor(val)
  repositionGhostInput()
})

ghostInput.addEventListener('keydown', (e) => {
  if (state.selectedImageId && (e.key === 'Backspace' || e.key === 'Delete')) {
    e.preventDefault()
    deleteImage(state.selectedImageId)
    return
  }
  switch (e.key) {
    case 'Enter':
      e.preventDefault()
      splitParagraphAtCursor()
      repositionGhostInput()
      break
    case 'Backspace':
      e.preventDefault()
      backspaceAtCursor()
      repositionGhostInput()
      break
    case 'Delete':
      e.preventDefault()
      deleteForwardAtCursor()
      repositionGhostInput()
      break
    case 'ArrowLeft':
      e.preventDefault()
      moveLeft()
      break
    case 'ArrowRight':
      e.preventDefault()
      moveRight()
      break
    case 'ArrowUp':
      e.preventDefault()
      moveVertical(-1)
      break
    case 'ArrowDown':
      e.preventDefault()
      moveVertical(1)
      break
    default:
      break
  }
})

ghostInput.addEventListener('paste', (e: ClipboardEvent) => {
  const items = e.clipboardData?.items
  if (!items) return
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault()
      const file = item.getAsFile()
      if (file) addImageFromFile(file)
      return
    }
  }
  // otherwise let the default text paste happen -> triggers 'input'
})

// ---------------------------------------------------------------------------
// Click-to-focus / place cursor
// ---------------------------------------------------------------------------

function applySelectionMark(kind: 'bold' | 'italic' | 'underline') {
  if (!state.selection) {
    alert('Seleziona il testo prima di applicare il formato.')
    return
  }
  const a = state.selection.anchor
  const b = state.selection.focus
  if (a.para !== b.para) {
    alert('La selezione deve essere all\'interno dello stesso paragrafo.')
    return
  }
  const para = a.para
  const start = Math.min(a.offset, b.offset)
  const end = Math.max(a.offset, b.offset)
  if (start === end) return
  ;(state as any).marks = (state as any).marks || []
  ;(state as any).marks[para] = (state as any).marks[para] || []
  const m: TextMark = { start, end }
  if (kind === 'bold') m.bold = true
  if (kind === 'italic') m.italic = true
  if (kind === 'underline') m.underline = true
  ;(state as any).marks[para].push(m)
  normalizeMarksForPara(para)
  state.selection = null
  relayout()
}

function normalizeMarksForPara(para: number) {
  const marks: TextMark[] = (state as any).marks[para] || []
  if (marks.length <= 1) return
  // sort by start
  marks.sort((a, b) => a.start - b.start || a.end - b.end)
  const out: TextMark[] = []
  for (const m of marks) {
    if (m.start >= m.end) continue
    const last = out[out.length - 1]
    if (!last) {
      out.push({ ...m })
      continue
    }
    // if same attributes and overlapping/adjacent, merge
    const sameAttrs = last.bold === m.bold && last.italic === m.italic && last.underline === m.underline && last.headline === m.headline
    if (sameAttrs && m.start <= last.end + 0) {
      last.end = Math.max(last.end, m.end)
    } else if (m.start < last.end) {
      // overlapping but different attrs -> keep both by splitting
      if (m.start > last.start && m.end < last.end) {
        // m is contained inside last -> split last
        const lastCopy = { ...last, start: m.end }
        last.end = m.start
        out.push(m)
        out.push(lastCopy)
      } else {
        out.push(m)
      }
    } else {
      out.push({ ...m })
    }
  }
  (state as any).marks[para] = out
}

async function exportPDF() {
  const imgs = await Promise.all(
    state.images.map(async (im) => ({ ...im, dataUrl: await convertImageToDataURL(im.img) }))
  )
  const pageCount = Math.max(1, Math.ceil(state.docHeight / PAGE_HEIGHT))
  const pageW = Math.round(state.docWidth + PAD_X * 2)
  const pageH = Math.round(PAGE_HEIGHT + PAD_Y * 2)
  const pdf = new jsPDF({ unit: 'px', format: [pageW, pageH] })
  const baselineOffset = FONT_SIZE * 0.92
  for (let pi = 0; pi < pageCount; pi++) {
    if (pi > 0) pdf.addPage([pageW, pageH], 'portrait')
    // background
    pdf.setFillColor(247, 245, 241)
    pdf.rect(0, 0, pageW, pageH, 'F')
    pdf.setFontSize(FONT_SIZE)
    for (const line of state.lines) {
      if (line.yTop < pi * PAGE_HEIGHT || line.yTop >= (pi + 1) * PAGE_HEIGHT) continue
      let xPos = PAD_X + line.x
      const paraMarks = (state as any).marks?.[line.paraIndex] || []
      let i = 0
      const globalStart = line.startOffset
      while (i < line.text.length) {
        const absPos = globalStart + i
        const style = { bold: false, italic: false, underline: false }
        for (const m of paraMarks) {
          if (m.start <= absPos && absPos < m.end) {
            if (m.bold) style.bold = true
            if (m.italic) style.italic = true
            if (m.underline) style.underline = true
          }
        }
        let runLen = 1
        while (i + runLen < line.text.length) {
          const abs2 = globalStart + i + runLen
          const style2 = { bold: false, italic: false, underline: false }
          for (const m of paraMarks) {
            if (m.start <= abs2 && abs2 < m.end) {
              if (m.bold) style2.bold = true
              if (m.italic) style2.italic = true
              if (m.underline) style2.underline = true
            }
          }
          if (style.bold !== style2.bold || style.italic !== style2.italic || style.underline !== style2.underline) break
          runLen++
        }
        const segText = line.text.slice(i, i + runLen)
        let fontStyle = 'normal'
        if (style.bold && style.italic) fontStyle = 'bolditalic'
        else if (style.bold) fontStyle = 'bold'
        else if (style.italic) fontStyle = 'italic'
        try {
          pdf.setFont(undefined as any, fontStyle as any)
        } catch {}
        pdf.text(segText, xPos, PAD_Y + (line.yTop - pi * PAGE_HEIGHT) + baselineOffset)
        const segW = pdf.getTextWidth(segText)
        if (style.underline) {
          const uy = PAD_Y + (line.yTop - pi * PAGE_HEIGHT) + baselineOffset + 2
          pdf.setDrawColor(42, 36, 32)
          pdf.setLineWidth(1)
          pdf.line(xPos, uy, xPos + segW, uy)
        }
        xPos += segW
        i += runLen
      }
    }
    for (const im of imgs) {
      const imTop = im.y
      const imBottom = im.y + im.h
      if (imTop < (pi + 1) * PAGE_HEIGHT && imBottom > pi * PAGE_HEIGHT) {
        const yOnPage = PAD_Y + (im.y - pi * PAGE_HEIGHT)
        try {
          pdf.addImage(im.dataUrl, 'PNG', PAD_X + im.x, yOnPage, im.w, im.h)
        } catch {}
      }
    }
  }
  pdf.save('pretext.pdf')
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function exportHTML() {
  const imgs = await Promise.all(state.images.map(async (im) => ({ ...im, dataUrl: await convertImageToDataURL(im.img) })))
  const pageCount = Math.max(1, Math.ceil(state.docHeight / PAGE_HEIGHT))
  const pageW = Math.round(state.docWidth + PAD_X * 2)
  const css = `
  body{margin:0;padding:20px;background:#f0e6ff;font-family: ${FONT_FAMILY}}
  .doc{width:${pageW}px;margin:0 auto}
  .page{position:relative;width:${pageW}px;height:${PAGE_HEIGHT + PAD_Y * 2}px;background:#f7f5f1;border:1px solid #d3d0c8;margin-bottom:${PAGE_GAP}px;box-sizing:border-box;}
  .line{position:absolute;white-space:pre}
  .img{position:absolute}
  `

  let bodyHtml = ''
  for (let pi = 0; pi < pageCount; pi++) {
    const pageTop = pi * PAGE_HEIGHT
    let pageInner = ''
    // lines
    for (const line of state.lines) {
      if (line.yTop < pageTop || line.yTop >= pageTop + PAGE_HEIGHT) continue
      const top = PAD_Y + (line.yTop - pageTop)
      let left = PAD_X + line.x
      const paraMarks = (state as any).marks?.[line.paraIndex] || []
      // build inner HTML by runs
      let i = 0
      let runs: string[] = []
      const globalStart = line.startOffset
      while (i < line.text.length) {
        const absPos = globalStart + i
        const style = { bold: false, italic: false, underline: false }
        for (const m of paraMarks) {
          if (m.start <= absPos && absPos < m.end) {
            if (m.bold) style.bold = true
            if (m.italic) style.italic = true
            if (m.underline) style.underline = true
          }
        }
        let runLen = 1
        while (i + runLen < line.text.length) {
          const abs2 = globalStart + i + runLen
          const style2 = { bold: false, italic: false, underline: false }
          for (const m of paraMarks) {
            if (m.start <= abs2 && abs2 < m.end) {
              if (m.bold) style2.bold = true
              if (m.italic) style2.italic = true
              if (m.underline) style2.underline = true
            }
          }
          if (style.bold !== style2.bold || style.italic !== style2.italic || style.underline !== style2.underline) break
          runLen++
        }
        const segText = escapeHtml(line.text.slice(i, i + runLen))
        let segHtml = segText
        if (style.underline) segHtml = `<u>${segHtml}</u>`
        if (style.italic) segHtml = `<i>${segHtml}</i>`
        if (style.bold) segHtml = `<b>${segHtml}</b>`
        runs.push(segHtml)
        i += runLen
      }
      pageInner += `<div class="line" style="left:${left}px;top:${top}px;font:${FONT};">${runs.join('')}</div>`
    }
    // images on page
    for (const im of imgs) {
      const imTop = im.y
      const imBottom = im.y + im.h
      if (imTop < pageTop + PAGE_HEIGHT && imBottom > pageTop) {
        const yOnPage = PAD_Y + (im.y - pageTop)
        const xOnPage = PAD_X + im.x
        pageInner += `<img class="img" src="${im.dataUrl}" style="left:${xOnPage}px;top:${yOnPage}px;width:${im.w}px;height:${im.h}px;"/>`
      }
    }
    bodyHtml += `<div class="page">${pageInner}</div>`
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div class="doc">${bodyHtml}</div></body></html>`
  const blob = new Blob([html], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'pretext-export.html'
  a.click()
  URL.revokeObjectURL(url)
}

docWrap.addEventListener('mousedown', (e) => {
  if ((e.target as HTMLElement).closest('.img-handle')) return
  const rect = docWrap.getBoundingClientRect()
  const px = e.clientX - rect.left - PAD_X
  const py = e.clientY - rect.top - PAD_Y
  deselectImage()
  const c = pixelToCursor(px, py)
  state.cursor = c
  state.selection = { anchor: c, focus: c }
  ;(state as any).selectingText = true
  ghostInput.focus()
  repositionGhostInput()
  resetCaretBlink()
  draw()
  const onMove = (ev: MouseEvent) => {
    if (!(state as any).selectingText) return
    const r = docWrap.getBoundingClientRect()
    const mx = ev.clientX - r.left - PAD_X
    const my = ev.clientY - r.top - PAD_Y
    state.selection = { anchor: c, focus: pixelToCursor(mx, my) }
    draw()
  }
  const onUp = (ev: MouseEvent) => {
    ;(state as any).selectingText = false
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    if (state.selection && state.selection.anchor.para === state.selection.focus.para && state.selection.anchor.offset === state.selection.focus.offset) {
      state.selection = null
    } else if (state.selection) {
      state.cursor = state.selection.focus
    }
    repositionGhostInput()
    draw()
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
})

// ---------------------------------------------------------------------------
// Drag & drop image files from the OS
// ---------------------------------------------------------------------------

docWrap.addEventListener('dragover', (e) => {
  e.preventDefault()
  docWrap.classList.add('dropzone-active')
})
docWrap.addEventListener('dragleave', () => {
  docWrap.classList.remove('dropzone-active')
})
docWrap.addEventListener('drop', (e) => {
  e.preventDefault()
  docWrap.classList.remove('dropzone-active')
  const rect = docWrap.getBoundingClientRect()
  const dropX = e.clientX - rect.left - PAD_X
  const dropY = e.clientY - rect.top - PAD_Y
  const files = e.dataTransfer?.files
  if (!files) return
  Array.from(files)
    .filter((f) => f.type.startsWith('image/'))
    .forEach((f, i) => addImageFromFile(f, dropX + i * 16, dropY + i * 16))
})

// ---------------------------------------------------------------------------
// Floating images
// ---------------------------------------------------------------------------

let imgCounter = 0

function addImageFromFile(file: File | Blob, dropX?: number, dropY?: number) {
  const objectUrl = URL.createObjectURL(file)
  const imgEl = new Image()
  const wrapper = document.createElement('div')
  wrapper.className = 'img-handle'
  wrapper.appendChild(imgEl)
  const grip = document.createElement('div')
  grip.className = 'resize-grip'
  const del = document.createElement('div')
  del.className = 'delete-btn'
  del.textContent = '\u00d7'
  wrapper.appendChild(grip)
  wrapper.appendChild(del)
  docWrap.appendChild(wrapper)
  imgEl.style.width = '100%'
  imgEl.style.height = '100%'
  imgEl.style.display = 'block'
  imgEl.style.userSelect = 'none'
  imgEl.draggable = false

  const id = 'img-' + ++imgCounter
  const rec: FloatImage = { id, img: imgEl, wrapper, x: 0, y: 0, w: 160, h: 160, loaded: false, objectUrl }
  state.images.push(rec)

  imgEl.onload = () => {
    const maxDim = Math.min(260, Math.max(120, state.docWidth * 0.42))
    let w = imgEl.naturalWidth
    let h = imgEl.naturalHeight
    if (w > maxDim) {
      h = h * (maxDim / w)
      w = maxDim
    }
    rec.w = Math.round(w)
    rec.h = Math.round(h)

    let x: number
    let y: number
    if (dropX !== undefined && dropY !== undefined) {
      x = dropX - rec.w / 2
      y = dropY - rec.h / 2
    } else {
      const caret = caretPixelPosition() || { x: 0, y: 0 }
      if (caret.x > state.docWidth / 2) {
        x = state.docWidth - rec.w
      } else {
        x = 0
      }
      y = caret.y
    }
    rec.x = Math.max(0, Math.min(state.docWidth - rec.w, x))
    rec.y = Math.max(0, y)
    rec.loaded = true
    relayout()
    buildAlphaMapForImage(rec)
  }
  imgEl.src = objectUrl

  wrapper.addEventListener('mousedown', (e) => {
    e.stopPropagation()
    selectImage(id)
    state.dragging = {
      id,
      mode: 'move',
      startX: e.clientX,
      startY: e.clientY,
      origX: rec.x,
      origY: rec.y,
      origW: rec.w,
      origH: rec.h,
      aspect: rec.w / rec.h,
    }
  })
  grip.addEventListener('mousedown', (e) => {
    e.stopPropagation()
    selectImage(id)
    state.dragging = {
      id,
      mode: 'resize',
      startX: e.clientX,
      startY: e.clientY,
      origX: rec.x,
      origY: rec.y,
      origW: rec.w,
      origH: rec.h,
      aspect: rec.w / rec.h,
    }
  })
  del.addEventListener('mousedown', (e) => e.stopPropagation())
  del.addEventListener('click', (e) => {
    e.stopPropagation()
    deleteImage(id)
  })
}

function selectImage(id: string) {
  state.selectedImageId = id
  for (const im of state.images) im.wrapper.classList.toggle('selected', im.id === id)
  ghostInput.blur()
}
function deselectImage() {
  state.selectedImageId = null
  for (const im of state.images) im.wrapper.classList.remove('selected')
}
function deleteImage(id: string) {
  const idx = state.images.findIndex((i) => i.id === id)
  if (idx === -1) return
  URL.revokeObjectURL(state.images[idx].objectUrl)
  state.images[idx].wrapper.remove()
  state.images.splice(idx, 1)
  if (state.selectedImageId === id) state.selectedImageId = null
  relayout()
}

let pendingRelayout = false
function scheduleRelayout() {
  if (pendingRelayout) return
  pendingRelayout = true
  requestAnimationFrame(() => {
    pendingRelayout = false
    relayout()
  })
}

window.addEventListener('mousemove', (e) => {
  const d = state.dragging
  if (!d) return
  const rec = state.images.find((i) => i.id === d.id)
  if (!rec) return
  const dx = e.clientX - d.startX
  const dy = e.clientY - d.startY
  if (d.mode === 'move') {
    rec.x = Math.max(0, Math.min(state.docWidth - rec.w, d.origX + dx))
    rec.y = Math.max(0, d.origY + dy)
  } else {
    const newW = Math.max(40, d.origW + dx)
    rec.w = Math.round(newW)
    rec.h = Math.round(newW / d.aspect)
  }
  scheduleRelayout()
})
window.addEventListener('mouseup', () => {
  state.dragging = null
})

function buildAlphaMapForImage(rec: FloatImage, sampleFactor = 3) {
  if (!rec.loaded) return
  try {
    const dw = Math.max(2, Math.floor(rec.w / sampleFactor))
    const dh = Math.max(2, Math.floor(rec.h / sampleFactor))
    const oc = document.createElement('canvas')
    oc.width = dw
    oc.height = dh
    const octx = oc.getContext('2d')!
    octx.clearRect(0, 0, dw, dh)
    // draw image scaled to downsampled size
    octx.drawImage(rec.img, 0, 0, dw, dh)
    const imgd = octx.getImageData(0, 0, dw, dh)
    const data = new Uint8Array(dw * dh)
    for (let i = 0; i < dw * dh; i++) {
      const alpha = imgd.data[i * 4 + 3]
      data[i] = alpha > 25 ? 1 : 0
    }
    rec.alphaMap = { w: dw, h: dh, data, scale: sampleFactor }
  } catch (err) {
    // ignore
  }
}

// click elsewhere deselects images (mousedown on doc-wrap already handles text areas;
// this also covers clicking outside the card entirely)
document.addEventListener('mousedown', (e) => {
  if (!(e.target as HTMLElement).closest('.doc-wrap')) {
    deselectImage()
    draw()
  }
})

function toggleHeadlineForPara() {
  const para = state.cursor.para
  const paraLen = state.paragraphs[para].length
  ;(state as any).marks = (state as any).marks || []
  ;(state as any).marks[para] = (state as any).marks[para] || []
  // Determine range: use selection if present and within same paragraph
  let start = 0
  let end = paraLen
  if (state.selection && state.selection.anchor.para === state.selection.focus.para) {
    start = Math.min(state.selection.anchor.offset, state.selection.focus.offset)
    end = Math.max(state.selection.anchor.offset, state.selection.focus.offset)
    if (start === end) { // empty selection -> treat as whole paragraph
      start = 0
      end = paraLen
    }
  }
  const marks: TextMark[] = (state as any).marks[para]
  // find headline marks that intersect the range
  const overlapping = marks.filter((m) => m.headline && m.start < end && m.end > start)
  if (overlapping.length > 0) {
    // remove all overlapping headline marks (toggle off)
    (state as any).marks[para] = marks.filter((m) => !(m.headline && m.start < end && m.end > start))
    normalizeMarksForPara(para)
  } else {
    // add a headline mark for the selected range
    ;(state as any).marks[para].push({ start, end, headline: true })
    normalizeMarksForPara(para)
  }
  state.selection = null
  relayout()
}

// selecting an image blurs the hidden text input on purpose (so typing doesn't
// land in the document while an image is selected), so Backspace/Delete for a
// selected image needs its own document-level listener rather than relying on
// ghostInput's keydown handler.
document.addEventListener('keydown', (e) => {
  if (state.selectedImageId && document.activeElement !== ghostInput) {
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      deleteImage(state.selectedImageId)
    } else if (e.key === 'Escape') {
      deselectImage()
      draw()
    }
  }
})

// ---------------------------------------------------------------------------
// Resize handling
// ---------------------------------------------------------------------------

let resizeRaf: number | undefined
window.addEventListener('resize', () => {
  if (resizeRaf) cancelAnimationFrame(resizeRaf)
  resizeRaf = requestAnimationFrame(() => relayout())
})

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

relayout()
