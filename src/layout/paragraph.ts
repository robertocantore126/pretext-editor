import { prepareRichInline, layoutNextRichInlineLineRange, materializeRichInlineLineRange } from '@chenglou/pretext/rich-inline'
import type { RichInlineCursor, RichInlineItem } from '@chenglou/pretext/rich-inline'
import {
  FONT_SIZE,
  LINE_HEIGHT,
  MIN_LINE_WIDTH,
  PAGE_HEIGHT,
} from '../config'
import { measureCtx } from '../dom'
import { fontForStyle, getStyleRuns, hasHeadlineInRange } from '../model/runs'
import type { LineInfo } from '../types'
import type { CharRun } from '../types/layout'
import { runCache } from './cache'
import { computeLineSlots } from './slots'

// Line breaking: pretext's rich-inline engine (ARCHITECTURE.md §4.1, B2), which
// replaces the dead prepareWithSegments integration and the greedy fitter. Runs
// come from the interned style table (Contract 1); the cursor threads across
// slots so both-sides wrap keeps working. Each fragment becomes its own
// LineInfo, which is what the renderer, caret and exporters already consume.

const MAX_LINE_HEIGHT = Math.round(FONT_SIZE * 1.6 * 1.4)

function computeRuns(text: string, paraIndex: number): CharRun[] {
  const runs: CharRun[] = []
  for (const run of getStyleRuns(paraIndex)) {
    const i = run.start
    const runLen = run.end - run.start
    const style = run
    const seg = text.slice(i, i + runLen)
    measureCtx.font = fontForStyle(style)
    const charWidths: number[] = []
    for (let k = 0; k < seg.length; k++) {
      charWidths.push(measureCtx.measureText(seg[k]).width)
    }
    // Prefix sums so a substring's width is prefix[b] - prefix[a] (ARCHITECTURE.md §4.7).
    const prefix = new Float64Array(charWidths.length + 1)
    for (let k = 0; k < charWidths.length; k++) prefix[k + 1] = prefix[k] + charWidths[k]
    runs.push({ start: i, end: i + runLen, text: seg, style, charWidths, prefix, width: prefix[charWidths.length] })
  }
  runCache[paraIndex] = runs
  return runs
}

/**
 * B5: push a line that would straddle a page boundary onto the next page, so
 * lines never bleed into the page gap (ROADMAP step 7).
 */
function pushPastPageBoundary(y: number, lineH: number): number {
  const page = Math.floor(y / PAGE_HEIGHT)
  const boundary = (page + 1) * PAGE_HEIGHT
  if (y < boundary && y + lineH > boundary) return boundary
  return y
}

export function layoutParagraph(text: string, docWidth: number, startY: number, paraIndex: number): { lines: LineInfo[]; height: number } {
  const lines: LineInfo[] = []

  if (text.length === 0) {
    lines.push({ paraIndex, text: '', x: 0, yTop: startY, width: docWidth, startOffset: 0, endOffset: 0, height: LINE_HEIGHT })
    return { lines, height: LINE_HEIGHT }
  }

  const runs = computeRuns(text, paraIndex)

  // Rich-inline items mirror the style runs. Pretext collapses collapsible
  // whitespace at item edges into gapBefore, so we track each item's document
  // offset and its leading-trim length to map fragments back to offsets.
  const items: RichInlineItem[] = []
  const itemMeta: { start: number; trimStart: number; trimmedLen: number }[] = []
  let itemStart = 0
  for (const r of runs) {
    items.push({ text: r.text, font: fontForStyle(r.style), letterSpacing: r.style.letterSpacing || undefined })
    const withoutLeading = r.text.replace(/^[ \t\n\f\r]+/, '')
    const trimmed = withoutLeading.replace(/[ \t\n\f\r]+$/, '')
    itemMeta.push({ start: itemStart, trimStart: r.text.length - withoutLeading.length, trimmedLen: trimmed.length })
    itemStart += r.text.length
  }
  const nonEmptyItemCount = itemMeta.filter((m) => m.trimmedLen > 0).length
  const prepared = prepareRichInline(items)
  // How much of each item's trimmed text has already been emitted as fragments.
  const consumedInItem: number[] = itemMeta.map(() => 0)

  let cursor: RichInlineCursor | undefined
  let pos = 0
  let y = startY
  while (pos < text.length) {
    const upcomingHasHeadline = hasHeadlineInRange(paraIndex, pos, pos + 41)
    const lineH = upcomingHasHeadline ? MAX_LINE_HEIGHT : LINE_HEIGHT
    const lineY = pushPastPageBoundary(y, lineH)
    const slots = computeLineSlots(lineY, lineH, docWidth)
    if (slots.every((s) => s.width < MIN_LINE_WIDTH)) {
      y += 6
      continue
    }
    let placed = false
    for (const slot of slots) {
      const range = layoutNextRichInlineLineRange(prepared, slot.width, cursor)
      if (!range) continue
      const mat = materializeRichInlineLineRange(prepared, range)
      cursor = range.end
      let x = slot.x
      for (const frag of mat.fragments) {
        x += frag.gapBefore
        const meta = itemMeta[frag.itemIndex]
        const startOffset = meta.start + meta.trimStart + consumedInItem[frag.itemIndex]
        if (frag.text.length > 0) {
          const endOffset = startOffset + frag.text.length
          lines.push({
            paraIndex,
            text: frag.text,
            x,
            yTop: lineY,
            width: frag.occupiedWidth,
            startOffset,
            endOffset,
            height: lineH,
          })
          pos = endOffset
          placed = true
        }
        consumedInItem[frag.itemIndex] += frag.text.length
        x += frag.occupiedWidth
      }
    }
    if (!placed) {
      // Nothing fit this band: push down past the obstruction. If the only
      // remaining text is collapsible whitespace the flow is exhausted - the
      // fragment texts never carry it (pretext trims it), so stop.
      if (cursor && cursor.itemIndex >= nonEmptyItemCount) break
      if (y - startY > 1e7) break // defensive: never spin forever
      y += 6
      continue
    }
    // Advance from lineY, not y: when pushPastPageBoundary moved this line down
    // to clear a page break, that gap is part of the paragraph's height. Adding
    // lineH to the pre-push y loses it, and the engine then starts the next
    // paragraph on top of this line.
    y = lineY + lineH
  }

  if (lines.length === 0) {
    lines.push({ paraIndex, text: '', x: 0, yTop: startY, width: docWidth, startOffset: 0, endOffset: 0, height: LINE_HEIGHT })
    y = startY + LINE_HEIGHT
  }

  return { lines, height: y - startY }
}
