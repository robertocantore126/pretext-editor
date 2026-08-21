import { MIN_LINE_WIDTH } from '../config'
import { view } from '../state/view'

// The core of the wrap feature: given a horizontal band, return the free x-ranges
// left over by the floating images that overlap it. Two slots on one band is what
// produces text flowing on both sides of an image.

export function computeLineSlots(y: number, lineH: number, docWidth: number): { x: number; width: number }[] {
  const intervals: [number, number][] = []
  for (const im of view.images) {
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
          // rowSpans: [minX, maxX] per row, -1 when fully transparent (ARCHITECTURE.md §4.7)
          const rowMin = map.rowSpans[r * 2]
          if (rowMin === -1) continue
          const rowMax = map.rowSpans[r * 2 + 1]
          const docMinX = im.x + (rowMin / map.w) * im.w
          const docMaxX = im.x + ((rowMax + 1) / map.w) * im.w
          minX = Math.min(minX, docMinX)
          maxX = Math.max(maxX, docMaxX)
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
