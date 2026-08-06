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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  paragraphs: [
    'Scrivi qui il tuo documento. Il testo viene impaginato da pretext senza mai toccare il DOM per la misura: incolla un\u2019immagine (Ctrl/Cmd+V) oppure trascinala qui dentro da fuori, poi spostala per vedere il testo ricalcolare la propria larghezza riga per riga attorno ad essa.',
    '',
  ],
  cursor: { para: 0, offset: 0 } as Cursor,
  images: [] as FloatImage[],
  selectedImageId: null as string | null,
  lines: [] as LineInfo[],
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

const ctx = canvas.getContext('2d')!
const measureCanvas = document.createElement('canvas')
const measureCtx = measureCanvas.getContext('2d')!
measureCtx.font = FONT

document.getElementById('btn-clear')!.addEventListener('click', () => {
  if (!confirm('Cancellare il documento e tutte le immagini?')) return
  for (const im of state.images) URL.revokeObjectURL(im.objectUrl)
  for (const im of state.images) im.wrapper.remove()
  state.images = []
  state.paragraphs = ['']
  state.cursor = { para: 0, offset: 0 }
  state.selectedImageId = null
  relayout()
})

// ---------------------------------------------------------------------------
// Layout: figure out the free horizontal slot for a line given floating images
// ---------------------------------------------------------------------------

function computeLineSlots(y: number, lineH: number, docWidth: number): { x: number; width: number }[] {
  const intervals: [number, number][] = []
  for (const im of state.images) {
    if (!im.loaded) continue
    if (im.y < y + lineH && im.y + im.h > y) {
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

  let prepared: PreparedTextWithSegments
  try {
    prepared = prepareWithSegments(text, FONT)
  } catch {
    lines.push({ paraIndex, text, x: 0, yTop: startY, width: docWidth, startOffset: 0, endOffset: text.length })
    return { lines, height: LINE_HEIGHT }
  }

  let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 }
  let y = startY
  let searchFrom = 0
  let steps = 0

  while (steps++ < MAX_LAYOUT_STEPS_PER_PARA) {
    const slots = computeLineSlots(y, LINE_HEIGHT, docWidth)
    if (slots.every((slot) => slot.width < MIN_LINE_WIDTH)) {
      y += 6
      continue
    }
    let lineHasText = false
    for (const slot of slots) {
      const range = layoutNextLineRange(prepared, cursor, slot.width)
      if (range === null) break
      const line = materializeLineRange(prepared, range)
      let idx = text.indexOf(line.text, searchFrom)
      if (idx < 0) idx = searchFrom
      const startOffset = idx
      const endOffset = idx + line.text.length
      lines.push({ paraIndex, text: line.text, x: slot.x, yTop: y, width: slot.width, startOffset, endOffset })
      searchFrom = endOffset
      cursor = range.end
      lineHasText = true
      if (cursor.segmentIndex >= prepared.segments.length && cursor.graphemeIndex === 0) break
    }
    if (!lineHasText) {
      y += 6
      continue
    }
    if (cursor.segmentIndex >= prepared.segments.length && cursor.graphemeIndex === 0) break
    y += LINE_HEIGHT
  }

  if (lines.length === 0) {
    lines.push({ paraIndex, text: '', x: 0, yTop: startY, width: docWidth, startOffset: 0, endOffset: 0 })
    y = startY + LINE_HEIGHT
  }

  return { lines, height: y - startY }
}

// ---------------------------------------------------------------------------
// Full relayout + draw
// ---------------------------------------------------------------------------

function relayout() {
  const cssWidth = docWrap.clientWidth || 800
  const docWidth = Math.max(80, cssWidth - PAD_X * 2)
  state.docWidth = docWidth

  const lines: LineInfo[] = []
  let y = 0
  state.paragraphs.forEach((p, i) => {
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

  const cssHeight = Math.max(160, docHeight + PAD_Y * 2)
  const dpr = window.devicePixelRatio || 1
  canvas.style.width = cssWidth + 'px'
  canvas.style.height = cssHeight + 'px'
  canvas.width = Math.round(cssWidth * dpr)
  canvas.height = Math.round(cssHeight * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  docWrap.style.height = cssHeight + 'px'

  for (const im of state.images) {
    im.wrapper.style.left = PAD_X + im.x + 'px'
    im.wrapper.style.top = PAD_Y + im.y + 'px'
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
  for (const line of state.lines) {
    if (line.text) {
      ctx.fillText(line.text, PAD_X + line.x, PAD_Y + line.yTop + baselineOffset)
    }
  }

  if (state.focused && state.caretVisible) {
    const pos = caretPixelPosition()
    if (pos) {
      ctx.strokeStyle = CARET_COLOR
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(PAD_X + pos.x, PAD_Y + pos.y + 2)
      ctx.lineTo(PAD_X + pos.x, PAD_Y + pos.y + LINE_HEIGHT - 5)
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

function caretPixelPosition(): { x: number; y: number } | null {
  const line = lineForCursor(state.cursor)
  if (!line) return null
  const within = Math.max(0, Math.min(state.cursor.offset - line.startOffset, line.text.length))
  const x = line.x + measureSubWidth(line.text.slice(0, within))
  return { x, y: line.yTop }
}

function pixelToCursor(px: number, py: number): Cursor {
  if (state.lines.length === 0) return { para: 0, offset: 0 }
  const candidates = state.lines.filter((l) => py >= l.yTop && py < l.yTop + LINE_HEIGHT)
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
  measureCtx.font = FONT
  let acc = 0
  let offset = best.startOffset
  const text = best.text
  for (let i = 0; i < text.length; i++) {
    const w = measureCtx.measureText(text[i]).width
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
  ghostInput.style.left = PAD_X + pos.x + 'px'
  ghostInput.style.top = PAD_Y + pos.y + 'px'
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

docWrap.addEventListener('mousedown', (e) => {
  if ((e.target as HTMLElement).closest('.img-handle')) return
  const rect = docWrap.getBoundingClientRect()
  const px = e.clientX - rect.left - PAD_X
  const py = e.clientY - rect.top - PAD_Y
  deselectImage()
  state.cursor = pixelToCursor(px, py)
  ghostInput.focus()
  repositionGhostInput()
  resetCaretBlink()
  draw()
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

// click elsewhere deselects images (mousedown on doc-wrap already handles text areas;
// this also covers clicking outside the card entirely)
document.addEventListener('mousedown', (e) => {
  if (!(e.target as HTMLElement).closest('.doc-wrap')) {
    deselectImage()
    draw()
  }
})

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
