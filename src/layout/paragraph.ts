import { prepareRichInline, layoutNextRichInlineLineRange, materializeRichInlineLineRange } from '@chenglou/pretext/rich-inline'
import type { RichInlineCursor, RichInlineItem } from '@chenglou/pretext/rich-inline'
import {
  FONT_SIZE,
  LINE_HEIGHT,
  MIN_LINE_WIDTH,
  PAGE_HEIGHT,
} from '../config'
import { measureCtx } from '../dom'
import { fontForStyle, getStyleRuns, styleFontSize } from '../model/runs'
import { defaultBlockAttrs, doc } from '../state/doc'
import type { LineInfo } from '../types'
import type { CharRun } from '../types/layout'
import { runCache } from './cache'
import { computeLineSlots } from './slots'

// Line breaking: pretext's rich-inline engine (ARCHITECTURE.md §4.1, B2), which
// replaces the dead prepareWithSegments integration and the greedy fitter. Runs
// come from the interned style table (Contract 1); the cursor threads across
// slots so both-sides wrap keeps working. Each fragment becomes its own
// LineInfo, which is what the renderer, caret and exporters already consume.
//
// Paragraph attributes (RICH-TEXT-MODEL.md §4.2) are slot geometry and y
// arithmetic: alignment shifts an already-broken line inside its slot, indents
// narrow the region the slots may occupy, space-before/after are y offsets, and
// the line height follows the tallest run font. pretext never sees any of it.

function computeRuns(text: string, paraIndex: number): CharRun[] {
  const runs: CharRun[] = []
  for (const run of getStyleRuns(paraIndex)) {
    const i = run.start
    const runLen = run.end - run.start
    const style = run
    const seg = text.slice(i, i + runLen)
    measureCtx.font = fontForStyle(style)
    const ls = style.letterSpacing || 0
    const charWidths: number[] = []
    // pretext widens every grapheme except the last by letterSpacing
    // (addInternalLetterSpacing); the measured widths must agree so the caret
    // and the exporters line up with the breaks (BUGHUNT M3).
    for (let k = 0; k < seg.length; k++) {
      charWidths.push(measureCtx.measureText(seg[k]).width + (k < seg.length - 1 ? ls : 0))
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

/** Clip a slot to the paragraph's text region. */
function regionSlot(
  slot: { x: number; width: number },
  left: number,
  right: number
): { x: number; width: number } | null {
  const a = Math.max(slot.x, left)
  const b = Math.min(slot.x + slot.width, right)
  if (b - a < MIN_LINE_WIDTH) return null
  return { x: a, width: b - a }
}

const WS_CHARS = /[ \t\n\f\r]/
const isWs = (ch: string) => WS_CHARS.test(ch)

/**
 * Interior inter-word gaps of a fragment: whitespace runs followed by a
 * non-space character. Trailing whitespace is trimmed by pretext, so every
 * counted gap is a real visual space between two words.
 */
function countInteriorGaps(text: string): number {
  let count = 0
  let inWs = false
  for (let i = 0; i < text.length; i++) {
    if (isWs(text[i])) inWs = true
    else if (inWs) {
      count++
      inWs = false
    }
  }
  return count
}

/** One visual line of a paragraph, for the paint-time justification pass. */
interface LineMetric {
  justifyGap: number
  /** justifyOffset for each pushed fragment (LineInfo index) of this line. */
  offsets: number[]
  indices: number[]
}

export function layoutParagraph(text: string, docWidth: number, startY: number, paraIndex: number): { lines: LineInfo[]; height: number } {
  const attrs = doc.blockAttrs[paraIndex] ?? defaultBlockAttrs()
  const leftIndent = Math.max(0, attrs.indentLeft)
  const rightIndent = Math.max(0, attrs.indentRight)
  const regionRight = docWidth - rightIndent
  const y0 = startY + attrs.spaceBefore
  const lines: LineInfo[] = []
  let y = y0

  const runs = text.length === 0 ? [] : computeRuns(text, paraIndex)

  // Line height follows the tallest run font (imported headings carry their own
  // computed size); a paragraph-level lineHeight overrides it.
  let maxRunSize = FONT_SIZE
  for (const r of runs) maxRunSize = Math.max(maxRunSize, styleFontSize(r.style))
  const lineH = attrs.lineHeight ?? Math.max(LINE_HEIGHT, Math.round(maxRunSize * 1.4))

  if (text.length === 0) {
    lines.push({
      paraIndex,
      text: '',
      x: leftIndent,
      yTop: y0,
      width: Math.max(0, regionRight - leftIndent),
      startOffset: 0,
      endOffset: 0,
      height: lineH,
    })
    return { lines, height: lineH + attrs.spaceBefore + attrs.spaceAfter }
  }

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

  // Alignment is applied to an already-broken line inside its slot. Justify
  // (RICH-TEXT-MODEL.md §7) is a paint-time pass: pretext still decides every
  // break, the leftover slack is distributed over the line's inter-word gaps,
  // and draw.ts spreads the words. Per-slot: in a both-sides-wrap band each
  // slot justifies independently against its own width.
  const alignFactor = attrs.align === 'center' ? 0.5 : attrs.align === 'right' ? 1 : 0

  let cursor: RichInlineCursor | undefined
  let pos = 0
  let firstBand = true
  // Tracks the last visual line that placed text, in case the paragraph ends in
  // trailing whitespace (pos never reaches text.length, so the final-band check
  // below cannot fire) and the loop breaks on exhaustion instead.
  let lastMetric: LineMetric | null = null
  let finalMarked = false
  while (pos < text.length) {
    const lineY = pushPastPageBoundary(y, lineH)
    const slots = computeLineSlots(lineY, lineH, docWidth)
    const regionSlots = slots
      .map((s) => regionSlot(s, leftIndent + (firstBand ? attrs.indentFirstLine : 0), regionRight))
      .filter((s): s is { x: number; width: number } => s !== null)
    if (regionSlots.length === 0) {
      y += 6
      continue
    }
    let placed = false
    const bandMetrics: LineMetric[] = []
    for (const slot of regionSlots) {
      const range = layoutNextRichInlineLineRange(prepared, slot.width, cursor)
      if (!range) continue
      const mat = materializeRichInlineLineRange(prepared, range)
      cursor = range.end
      // Shift the whole broken line inside its slot for center/right alignment.
      const shift = (slot.width - mat.width) * alignFactor
      let x = slot.x + shift
      // Justification metrics for this visual line (all fragments of the line
      // share one gap size; each fragment's start shifts by its share).
      const nonEmpty = mat.fragments.filter((f) => f.text.length > 0)
      const interior = nonEmpty.map((f) => countInteriorGaps(f.text))
      const boundary: number[] = nonEmpty.map((f, j) =>
        j > 0 && !isWs(nonEmpty[j - 1].text[nonEmpty[j - 1].text.length - 1]) && !isWs(f.text[0]) ? 1 : 0
      )
      const gapCount = interior.reduce((a, b) => a + b, 0) + boundary.reduce((a, b) => a + b, 0)
      const slack = slot.width - mat.width
      const justifyGap = attrs.align === 'justify' && slack > 0 && gapCount > 0 ? slack / gapCount : 0
      const metric: LineMetric = { justifyGap, offsets: [], indices: [] }
      bandMetrics.push(metric)
      let cum = 0
      let fi = 0
      for (const frag of mat.fragments) {
        x += frag.gapBefore
        const meta = itemMeta[frag.itemIndex]
        const startOffset = meta.start + meta.trimStart + consumedInItem[frag.itemIndex]
        if (frag.text.length > 0) {
          const endOffset = startOffset + frag.text.length
          const li: LineInfo = {
            paraIndex,
            text: frag.text,
            x,
            yTop: lineY,
            width: frag.occupiedWidth,
            startOffset,
            endOffset,
            height: lineH,
          }
          if (justifyGap > 0) {
            li.justifyGap = justifyGap
            li.justifyOffset = cum
            cum += (interior[fi] + (boundary[fi + 1] ?? 0)) * justifyGap
            metric.indices.push(lines.length)
            lastMetric = metric
          }
          lines.push(li)
          pos = endOffset
          placed = true
          fi++
        }
        consumedInItem[frag.itemIndex] += frag.text.length
        x += frag.occupiedWidth
      }
    }
    // The last line of a justified paragraph stays left-aligned. When this band
    // placed the paragraph's final text, the last slot's line is the last one;
    // earlier slots of the same band are still justified.
    if (placed && pos >= text.length && bandMetrics.length > 0) {
      const last = bandMetrics[bandMetrics.length - 1]
      for (const i of last.indices) {
        lines[i].justifyGap = 0
        lines[i].justifyOffset = 0
      }
      finalMarked = true
    }
    if (!placed) {
      // Nothing fit this band: push down past the obstruction. If the only
      // remaining text is collapsible whitespace the flow is exhausted - the
      // fragment texts never carry it (pretext trims it), so stop.
      if (cursor && cursor.itemIndex >= nonEmptyItemCount) break
      if (y - y0 > 1e7) break // defensive: never spin forever
      y += 6
      continue
    }
    // Advance from lineY, not y: when pushPastPageBoundary moved this line down
    // to clear a page break, that gap is part of the paragraph's height. Adding
    // lineH to the pre-push y loses it, and the engine then starts the next
    // paragraph on top of this line.
    y = lineY + lineH
    firstBand = false
  }    if (lines.length === 0) {
    lines.push({ paraIndex, text: '', x: leftIndent, yTop: y0, width: Math.max(0, regionRight - leftIndent), startOffset: 0, endOffset: 0, height: lineH })
    y = y0 + lineH
  }

  // Exhaustion with trailing whitespace: the loop broke before pos reached
  // text.length, so the final-band check never fired. Un-justify the last line.
  if (!finalMarked && lastMetric) {
    for (const i of lastMetric.indices) {
      lines[i].justifyGap = 0
      lines[i].justifyOffset = 0
    }
  }

  return { lines, height: y - y0 + attrs.spaceAfter }
}
