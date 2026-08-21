import {
  CARET_COLOR,
  FONT,
  INK,
  LINE_HEIGHT,
  PAD_X,
  PAD_Y,
  PAGE_GAP,
  PAGE_HEIGHT,
} from '../config'
import { canvas, ctx, docWrap, emptyHint, measureCtx } from '../dom'
import { caretPixelPosition, lineForCursor } from '../layout/caret-position'
import { docToVisualY } from '../layout/pagination'
import { measureTextWidthOnPara } from '../measure'
import { getComposition } from '../model/composition'
import { fontForStyle, getStyleRunsInRange, styleAt, styleFontSize } from '../model/runs'
import { getSelectionRanges } from '../model/selection'
import { doc } from '../state/doc'
import { view } from '../state/view'
import { updateCaretDom } from './caret'

// Painting (ARCHITECTURE.md §4.3, docs/PARALLEL-PLAN.md B4): the canvas is
// viewport-sized and pinned to the visible top of the scroll container; the
// origin is translated by scrollTop and only the visible band of lines is
// painted, so a 100-page document costs the same as a one-page one.
// Colour, background, strikethrough and super/subscript are paint-only: they
// never reach pretext (RICH-TEXT-MODEL.md §7).

/**
 * Where a line is painted, in the same space as docWrap.scrollTop: document Y
 * mapped through the page gaps, plus the top padding. Comparing raw line.yTop
 * against scrollTop skips PAD_Y plus one PAGE_GAP per page crossed.
 */
function lineVisualTop(line: { yTop: number }): number {
  return PAD_Y + docToVisualY(line.yTop)
}

/** First line that can still be visible: its bottom is at or below scrollTop. */
function firstVisibleIndex(scrollTop: number): number {
  const ls = view.lines
  let lo = 0
  let hi = ls.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (lineVisualTop(ls[mid]) + (ls[mid].height || LINE_HEIGHT) <= scrollTop) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function draw() {
  const cssWidth = parseFloat(canvas.style.width) || docWrap.clientWidth
  const cssHeight = parseFloat(canvas.style.height) || docWrap.clientHeight
  const dpr = window.devicePixelRatio || 1
  const scrollTop = docWrap.scrollTop

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssWidth, cssHeight)
  // Paint in document coordinates: content at docY lands at docY - scrollTop
  // on the pinned canvas. Everything outside the canvas is clipped for free.
  ctx.translate(0, -scrollTop)
  ctx.font = FONT
  ctx.fillStyle = INK
  ctx.textBaseline = 'alphabetic'

  const isEmptyDoc = doc.paragraphs.length === 1 && doc.paragraphs[0] === '' && view.images.length === 0
  emptyHint.style.display = isEmptyDoc && !view.focused ? 'block' : 'none'
  if (isEmptyDoc && !view.focused) {
    emptyHint.textContent = 'Clicca qui per iniziare a scrivere\u2026'
    emptyHint.style.font = FONT
  }

  // Page backgrounds for the pages intersecting the visible band.
  const viewTop = scrollTop
  const viewBottom = scrollTop + cssHeight
  const pageCount = Math.max(1, Math.ceil(view.docHeight / PAGE_HEIGHT))
  const pageSize = PAGE_HEIGHT + PAGE_GAP
  const firstPage = Math.max(0, Math.floor((viewTop - PAD_Y) / pageSize))
  const lastPage = Math.min(pageCount - 1, Math.floor((viewBottom - PAD_Y) / pageSize))
  ctx.fillStyle = '#f7f5f1'
  ctx.strokeStyle = '#d3d0c8'
  ctx.lineWidth = 1
  for (let p = firstPage; p <= lastPage; p++) {
    const top = PAD_Y + p * pageSize
    ctx.fillRect(PAD_X - 8, top - 8, view.docWidth + 16, PAGE_HEIGHT + 16)
    ctx.strokeRect(PAD_X - 8, top - 8, view.docWidth + 16, PAGE_HEIGHT + 16)
  }

  ctx.fillStyle = INK
  const start = firstVisibleIndex(scrollTop)
  const lines = view.lines

  // Selection background. What is selected comes from Contract 3; this only
  // decides how it looks, so A can add multi-paragraph selection without
  // touching this file.
  for (const range of getSelectionRanges()) {
    for (let li = start; li < lines.length; li++) {
      const line = lines[li]
      if (lineVisualTop(line) > viewBottom) break
      if (line.paraIndex !== range.para) continue
      const s = Math.max(line.startOffset, range.start)
      const e = Math.min(line.endOffset, range.end)
      if (e <= s) continue
      const leftPart = line.text.slice(0, s - line.startOffset)
      const midPart = line.text.slice(s - line.startOffset, e - line.startOffset)
      const segLeft = PAD_X + line.x + measureTextWidthOnPara(line.paraIndex, leftPart, line.startOffset)
      const segWidth = measureTextWidthOnPara(line.paraIndex, midPart, s)
      const top = PAD_Y + docToVisualY(line.yTop)
      ctx.fillStyle = 'rgba(124,58,237,0.12)'
      ctx.fillRect(segLeft, top + 4, segWidth, (line.height || LINE_HEIGHT) - 8)
      ctx.fillStyle = INK
    }
  }

  for (let li = start; li < lines.length; li++) {
    const line = lines[li]
    if (lineVisualTop(line) > viewBottom) break
    if (!line.text) continue
    // List markers live in the indent gutter of the first line (RICH-TEXT-MODEL.md §4.2).
    const bAttrs = doc.blockAttrs[line.paraIndex]
    if (line.startOffset === 0 && bAttrs?.kind === 'listItem' && bAttrs.list?.marker) {
      ctx.font = FONT
      const markerW = measureCtx.measureText(bAttrs.list.marker).width
      const markerY = PAD_Y + docToVisualY(line.yTop) + (line.height || LINE_HEIGHT) * 0.76
      ctx.fillStyle = INK
      ctx.fillText(bAttrs.list.marker, PAD_X + line.x - markerW - 10, markerY)
    }
    let xPos = PAD_X + line.x
    const globalStart = line.startOffset
    const lineTopY = PAD_Y + docToVisualY(line.yTop)
    for (const style of getStyleRunsInRange(line.paraIndex, globalStart, line.endOffset)) {
      const segText = line.text.slice(style.start - globalStart, style.end - globalStart)
      const fontSize = styleFontSize(style)
      ctx.font = fontForStyle(style)
      measureCtx.font = ctx.font
      const w = measureCtx.measureText(segText).width
      if (style.background) {
        ctx.fillStyle = style.background
        ctx.fillRect(xPos, lineTopY + 2, w, (line.height || LINE_HEIGHT) - 5)
      }
      ctx.fillStyle = style.color
      const baselineShift = style.baseline === 'super' ? -fontSize * 0.28 : style.baseline === 'sub' ? fontSize * 0.18 : 0
      const baselineY = lineTopY + fontSize * 0.92 + baselineShift
      ctx.fillText(segText, xPos, baselineY)
      if (style.underline) {
        const uy = baselineY + 2
        ctx.strokeStyle = style.color
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(xPos, uy)
        ctx.lineTo(xPos + w, uy)
        ctx.stroke()
      }
      if (style.strike) {
        ctx.strokeStyle = style.color
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(xPos, baselineY - fontSize * 0.42)
        ctx.lineTo(xPos + w, baselineY - fontSize * 0.42)
        ctx.stroke()
      }
      xPos += w
      ctx.font = FONT
    }
  }

  // IME preedit underline (handoff A -> B, blocks A3). The preedit text does
  // not exist in the document yet; draw an underline from the caret for as
  // long as the composed string.
  const composition = getComposition()
  if (composition && composition.text.length > 0) {
    const pos = caretPixelPosition()
    if (pos) {
      const caretLine = lineForCursor(doc.cursor)
      const visualY = docToVisualY(pos.y)
      const style = styleAt(composition.para, composition.offset)
      measureCtx.font = fontForStyle(style)
      const w = measureCtx.measureText(composition.text).width
      const y = PAD_Y + visualY + (caretLine && caretLine.height ? caretLine.height - 4 : LINE_HEIGHT - 4)
      ctx.strokeStyle = CARET_COLOR
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(PAD_X + pos.x, y)
      ctx.lineTo(PAD_X + pos.x + w, y)
      ctx.stroke()
    }
  }

  // Caret: a DOM div (CSS-animated), not canvas ink. Zero canvas work when idle.
  if (view.focused) {
    const pos = caretPixelPosition()
    const line = lineForCursor(doc.cursor)
    if (pos && line) {
      updateCaretDom(
        PAD_X + pos.x,
        PAD_Y + docToVisualY(pos.y) + 2,
        (line.height || LINE_HEIGHT) - 7,
        view.caretVisible
      )
    } else {
      updateCaretDom(0, 0, 0, false)
    }
  } else {
    updateCaretDom(0, 0, 0, false)
  }
}
