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
import { view } from '../state/view'
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

/**
 * Map a materialized fragment back onto the paragraph text. pretext hands back
 * the *normalized* string — runs of collapsible whitespace collapsed to one,
 * edges trimmed — so a fragment index is not a document offset. One source
 * character is consumed per non-space fragment character, and the whole
 * whitespace run per fragment space, which is precisely the normalization being
 * undone. Returns null when the two strings disagree (a hyphen inserted at a
 * break, a future normalization rule): the caller must then warn and fall back
 * rather than emit a line that breaks the offset invariant (FIXPLAN.md fix 1).
 */
function alignFragment(src: string, from: number, frag: string): { start: number; end: number } | null {
  let i = from
  // pretext folds the whitespace preceding a fragment into gapBefore.
  if (frag.length > 0 && !isWs(frag[0])) while (i < src.length && isWs(src[i])) i++
  const start = i
  for (let j = 0; j < frag.length; j++) {
    const fc = frag[j]
    if (isWs(fc)) {
      if (i >= src.length || !isWs(src[i])) return null
      while (i < src.length && isWs(src[i])) i++
    } else {
      if (src[i] !== fc) return null
      i++
    }
  }
  return { start, end: i }
}

/**
 * Painted width of a document range, from the run prefix sums — what the
 * renderer actually draws. For a range containing a collapsed whitespace run
 * this is wider than pretext's trimmed occupiedWidth, which is exactly why the
 * fragment position after it must advance by this, not by occupiedWidth
 * (FIXPLAN.md fix 1).
 */
function runWidthInRange(runs: CharRun[], start: number, end: number): number {
  let w = 0
  for (const r of runs) {
    if (r.end <= start || r.start >= end) continue
    const a = Math.max(start, r.start) - r.start
    const b = Math.min(end, r.end) - r.start
    w += r.prefix[b] - r.prefix[a]
  }
  return w
}

/**
 * FIXPLAN.md §0: for every line the layout emits,
 * `text.slice(line.startOffset, line.endOffset) === line.text`. Every
 * downstream consumer — caret, selection, measurement, exporters — slices
 * line.text by document offsets and silently assumes it, so a violation must be
 * loud. DEV-only; it is a gate, not a probe.
 */
function assertOffsetInvariant(text: string, lines: LineInfo[]) {
  if (!import.meta.env.DEV) return
  for (const li of lines) {
    if (text.slice(li.startOffset, li.endOffset) !== li.text) {
      console.warn('[layout] offset invariant violated (FIXPLAN.md §0)', {
        paraIndex: li.paraIndex,
        startOffset: li.startOffset,
        endOffset: li.endOffset,
        expected: text.slice(li.startOffset, li.endOffset),
        actual: li.text,
      })
    }
  }
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
    assertOffsetInvariant(text, lines)
    return { lines, height: lineH + attrs.spaceBefore + attrs.spaceAfter }
  }

  // Rich-inline items mirror the style runs. Pretext collapses collapsible
  // whitespace at item edges into gapBefore, so a fragment index is not a
  // document offset; alignFragment undoes that normalization with a monotonic
  // searchPos over the paragraph (FIXPLAN.md fix 1). Only the trimmed length of
  // each item is kept here, for the no-layable-content early return below.
  const items: RichInlineItem[] = []
  const itemMeta: { trimmedLen: number }[] = []
  for (const r of runs) {
    items.push({ text: r.text, font: fontForStyle(r.style), letterSpacing: r.style.letterSpacing || undefined })
    const withoutLeading = r.text.replace(/^[ \t\n\f\r]+/, '')
    itemMeta.push({ trimmedLen: withoutLeading.replace(/[ \t\n\f\r]+$/, '').length })
  }
  const prepared = prepareRichInline(items)
  // No layable content: a paragraph of only collapsible whitespace never emits
  // a fragment, so the band loop below could not advance and would spin to the
  // runaway guard (FIXPLAN.md fix 2). Emit the same empty line the
  // text.length === 0 branch emits and return.
  if (itemMeta.every((m) => m.trimmedLen === 0)) {
    lines.push({ paraIndex, text: '', x: leftIndent, yTop: y0, width: Math.max(0, regionRight - leftIndent), startOffset: 0, endOffset: 0, height: lineH })
    assertOffsetInvariant(text, lines)
    return { lines, height: lineH + attrs.spaceBefore + attrs.spaceAfter }
  }

  // Alignment is applied to an already-broken line inside its slot. Justify
  // (RICH-TEXT-MODEL.md §7) is a paint-time pass: pretext still decides every
  // break, the leftover slack is distributed over the line's inter-word gaps,
  // and draw.ts spreads the words. Per-slot: in a both-sides-wrap band each
  // slot justifies independently against its own width.
  const alignFactor = attrs.align === 'center' ? 0.5 : attrs.align === 'right' ? 1 : 0

  // Past the lowest image nothing can obstruct a band, so a band that placed
  // nothing below it never will. The old 1e7 guard was a ~1.7M-iteration
  // freeze, not a guard (FIXPLAN.md fix 2).
  let obstructionBottom = 0
  for (const im of view.images) if (im.loaded) obstructionBottom = Math.max(obstructionBottom, im.y + im.h)

  let cursor: RichInlineCursor | undefined
  let pos = 0
  // Where the last fragment's document text ended (FIXPLAN.md fix 1). A single
  // monotonic cursor over the paragraph: fragments arrive in flow order across
  // slots and bands, so one position is enough.
  let searchPos = 0
  let warnedFallback = false
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
        if (frag.text.length === 0) {
          // Whitespace-only fragment: pretext folded the run into gapBefore and
          // there is nothing to paint, but the search cursor must advance past
          // the collapsed run so the next fragment's alignment starts after it.
          while (searchPos < text.length && isWs(text[searchPos])) searchPos++
          x += frag.occupiedWidth
          continue
        }
        // Map the normalized fragment back onto the document and paint the
        // document slice: that is what keeps the offset invariant (§0) true —
        // every consumer slices line.text by document offsets.
        const a = alignFragment(text, searchPos, frag.text)
        let startOffset: number
        let endOffset: number
        let fragText: string
        let paintedWidth: number
        if (a) {
          startOffset = a.start
          endOffset = a.end
          searchPos = a.end
          fragText = text.slice(startOffset, endOffset)
          // Painted width of the document slice (run prefix sums), not pretext's
          // trimmed occupiedWidth — otherwise the next fragment on the same line
          // overlaps the extra spaces painted before it.
          paintedWidth = runWidthInRange(runs, startOffset, endOffset)
        } else {
          // The strings disagree (a hyphen at a break, a future normalization
          // rule): fall back to the arithmetic offsets, loudly, once per
          // paragraph. A wrong offset must never be silent — a silent fallback
          // is exactly how the dead pretext call survived for the life of the
          // project.
          if (!warnedFallback) {
            warnedFallback = true
            console.warn(
              `[layout] fragment does not align with the paragraph text (para ${paraIndex}); falling back to arithmetic offsets — the offset invariant (FIXPLAN.md §0) may be violated`,
              { frag: frag.text, window: text.slice(searchPos, Math.min(text.length, searchPos + frag.text.length + 12)) }
            )
          }
          startOffset = searchPos
          endOffset = searchPos + frag.text.length
          searchPos = endOffset
          fragText = frag.text
          paintedWidth = frag.occupiedWidth
        }
        const li: LineInfo = {
          paraIndex,
          text: fragText,
          x,
          yTop: lineY,
          width: paintedWidth,
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
        x += paintedWidth
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
      // Nothing fit this band: push down past the obstruction. Probe once at
      // the widest region the paragraph may occupy — if even that lays out
      // nothing, no narrower slot ever will and the flow is exhausted. This
      // subsumes the old itemIndex test, which could not fire because a
      // paragraph ending in collapsible whitespace never returns a range, and
      // `pos` cannot be the termination condition either (pretext trims
      // trailing whitespace, so pos never reaches text.length).
      if (layoutNextRichInlineLineRange(prepared, regionRight - leftIndent, cursor) === null) break
      if (y > obstructionBottom + lineH) break
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

  assertOffsetInvariant(text, lines)
  return { lines, height: y - y0 + attrs.spaceAfter }
}
