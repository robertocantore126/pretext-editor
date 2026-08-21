import { LINE_HEIGHT } from '../config'
import { measureCtx } from '../dom'
import { measureTextWidthOnPara } from '../measure'
import { setCursor } from '../model/selection'
import { fontForStyle, styleAt } from '../model/runs'
import { doc } from '../state/doc'
import { view } from '../state/view'
import type { Cursor, LineInfo } from '../types'
import { runCache } from './cache'

// Pure geometry: cursor <-> pixel. Kept free of render/ so that render/draw.ts can
// import it without creating a cycle.

export function lineForCursor(c: Cursor): LineInfo | null {
  const candidates = view.lines.filter((l) => l.paraIndex === c.para)
  if (candidates.length === 0) return null
  for (const l of candidates) {
    if (c.offset >= l.startOffset && c.offset <= l.endOffset) {
      // prefer a line that isn't the wrap-continuation unless offset matches exactly
      if (c.offset < l.endOffset || l === candidates[candidates.length - 1]) return l
    }
  }
  return candidates[candidates.length - 1]
}
export function caretPixelPosition(): { x: number; y: number } | null {
  const line = lineForCursor(doc.cursor)
  if (!line) return null
  const within = Math.max(0, Math.min(doc.cursor.offset - line.startOffset, line.text.length))
  const x = line.x + measureTextWidthOnPara(line.paraIndex, line.text.slice(0, within), line.startOffset)
  return { x, y: line.yTop }
}
/**
 * The cursor nearest a point given in **document** coordinates (layout/coords.ts
 * turns a pointer event into them). It used to take a visual Y and convert
 * internally, which left the fallback below comparing a visual Y against the
 * lines' document Y: a click that missed a line's band — the gap between
 * paragraphs, blank space on a page, below the last line — then walked the
 * document with a coordinate inflated by PAGE_GAP per page and landed further
 * down. That is the "I clicked here and it jumped there" report.
 */
export function pixelToCursor(px: number, docY: number): Cursor {
  if (view.lines.length === 0) return { para: 0, offset: 0 }
    // B5: hit-test against each line's real height, not the constant LINE_HEIGHT.
    const candidates = view.lines.filter((l) => docY >= l.yTop && docY < l.yTop + (l.height || LINE_HEIGHT))
  let best: LineInfo
  if (candidates.length > 0) {
    const inside = candidates.find((l) => px >= l.x && px <= l.x + l.width)
    best = inside ?? candidates.reduce((prev, cur) => {
      const prevDist = Math.abs(px - (prev.x + prev.width / 2))
      const curDist = Math.abs(px - (cur.x + cur.width / 2))
      return curDist < prevDist ? cur : prev
    })
  } else {
    best = view.lines[0]
    for (const l of view.lines) {
      if (docY >= l.yTop && docY < l.yTop + (l.height || LINE_HEIGHT)) {
        best = l
        break
      }
      if (l.yTop <= docY) best = l
    }
  }
  const localX = px - best.x
  let acc = 0
  let offset = best.startOffset
  const text = best.text
  for (let i = 0; i < text.length; i++) {
    const abs = best.startOffset + i
    const style = styleAt(best.paraIndex, abs)
    // use runCache for faster per-char widths when available
    const runs = runCache[best.paraIndex] || []
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
      measureCtx.font = fontForStyle(style)
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

// ---- B5: vertical movement with a sticky column -----------------------------
// The horizontal position is remembered across ArrowUp/ArrowDown moves and only
// reset by an explicit horizontal move or a click, so the caret stays in the
// same visual column on wrapped lines of varying width.

let stickyX: number | null = null

export function resetStickyX(): void {
  stickyX = null
}

/**
 * Moves the caret one visual line up or down, stepping by the real height of
 * the current line. Writes the cursor only through Contract 3.
 */
export function moveCursorVertical(dir: 1 | -1): void {
  const pos = caretPixelPosition()
  if (!pos) return
  if (stickyX === null) stickyX = pos.x
  const line = lineForCursor(doc.cursor)
  const step = line ? line.height || LINE_HEIGHT : LINE_HEIGHT
  // Both are document Y now, so a step is just a step.
  const targetY = pos.y + dir * step
  const c = pixelToCursor(stickyX, targetY)
  setCursor(c)
}
