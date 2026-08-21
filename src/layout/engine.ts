import { FONT_SIZE, LINE_HEIGHT, PAD_X, PAD_Y, PAGE_GAP, PAGE_HEIGHT, PARA_GAP } from '../config'
import { canvas, ctx, docSpacer, docWrap } from '../dom'
import { draw } from '../render/draw'
import { titleBlockHeight } from '../render/title'
import { DEFAULT_FIRST_TITLE, notifySections } from '../model/sections'
import { trace } from '../debug/tracer'
import type { SectionMark } from '../model/sections'
import type { SectionLayout } from '../state/view'

import { doc } from '../state/doc'
import { view } from '../state/view'
import type { FloatImage, LineInfo } from '../types'
import { takeDirty, takeShifts } from '../model/dirty'
import { styleVersion } from '../model/runs'
import { paraCache, shiftCaches } from './cache'
import { docToVisualY } from './pagination'
import { layoutParagraph } from './paragraph'

/**
 * The tab that opens at this paragraph, if any. Paragraph 0 always opens one
 * even without a marker: a roll of paper still has a beginning, and the panel
 * must never be empty (docs/TABS.md).
 */
function sectionMarkAt(paraIndex: number): SectionMark | undefined {
  const mark = doc.blockAttrs[paraIndex]?.section
  if (mark) return mark
  if (paraIndex === 0) return { id: 'implicit-first', title: DEFAULT_FIRST_TITLE, level: 0 }
  return undefined
}

let lastSectionSignature = ''

/**
 * Images grouped by the paragraph they are anchored to, rebuilt once per pass.
 * Scanning every image for every paragraph was 4000 x 40 comparisons on a
 * stress document and showed up in the numbers; most paragraphs have no image.
 */
let anchoredByPara = new Map<number, FloatImage[]>()

function indexAnchors(): void {
  anchoredByPara = new Map()
  for (const im of view.images) {
    const list = anchoredByPara.get(im.anchorPara)
    if (list) list.push(im)
    else anchoredByPara.set(im.anchorPara, [im])
  }
}

/**
 * Images anchored to this paragraph ride with it: their document Y is derived
 * from the paragraph's top, every pass, before anything asks what they obstruct.
 * This is what keeps a figure beside its text when the text above it grows.
 */
function resolveAnchoredImages(paraIndex: number, yStart: number): void {
  const anchored = anchoredByPara.get(paraIndex)
  if (!anchored) return
  for (const im of anchored) im.y = yStart + im.anchorDy
}

/**
 * Paragraph indices moved, so the anchors must follow — the same splice the
 * layout caches get (model/dirty.ts). An image anchored inside a stretch that
 * was deleted attaches to the paragraph that absorbed it rather than pointing
 * at nothing.
 */
function shiftImageAnchors(at: number, removed: number, inserted: number): void {
  const delta = inserted - removed
  for (const im of view.images) {
    if (im.anchorPara < at) continue
    if (im.anchorPara < at + removed) im.anchorPara = Math.max(0, at - 1)
    else im.anchorPara += delta
  }
}

/**
 * The obstruction key of a paragraph: which images overlap its vertical band,
 * plus its page position (B5 makes height depend on page boundaries). Any
 * change means the paragraph must be re-fitted rather than translated.
 */
function obstructionKey(paraIndex: number, yStart: number, estHeight: number): string {
  const page = Math.floor(yStart / PAGE_HEIGHT)
  const straddles = Math.floor((yStart + estHeight) / PAGE_HEIGHT) !== page
  let key = page + (straddles ? ':s' : '')
  for (const im of view.images) {
    if (!im.loaded) continue
    if (im.y < yStart + estHeight && im.y + im.h > yStart) {
      // Relative to the paragraph, not absolute: when a paragraph and the
      // images beside it translate together, nothing about the obstruction has
      // actually changed and the cached layout stays valid.
      key += '|' + im.id + ':' + Math.round(im.x) + ':' + Math.round(im.y - yStart) + ':' + Math.round(im.w) + ':' + Math.round(im.h)
    }
  }
  return key
}

/**
 * A cheap upper bound on how tall a paragraph can be, used only to widen the
 * obstruction probe for a paragraph whose cached layout is already stale.
 * Assumes the narrowest useful line, so it never under-estimates.
 */
function estimateHeight(paraIndex: number): number {
  const chars = doc.paragraphs[paraIndex]?.length ?? 0
  const perLine = Math.max(1, Math.floor(view.docWidth / (FONT_SIZE * 0.5)))
  return Math.max(1, Math.ceil(chars / perLine)) * LINE_HEIGHT
}

export function relayout() {
  const relayoutStart = performance.now()
  const dirty = takeDirty()
  // Paragraph indices moved since the last pass: re-key the caches the same way
  // the model re-keyed its versions, in the order the splices happened.
  for (const shift of takeShifts()) {
    shiftCaches(shift.at, shift.removed, shift.inserted)
    shiftImageAnchors(shift.at, shift.removed, shift.inserted)
  }
  const cssWidth = docWrap.clientWidth || 800
  const docWidth = Math.max(80, cssWidth - PAD_X * 2)
  view.docWidth = docWidth

  const n = doc.paragraphs.length
  // An anchor can only point at a paragraph that exists; a document replaced
  // wholesale (import, restore) leaves the old ones dangling.
  for (const im of view.images) im.anchorPara = Math.max(0, Math.min(im.anchorPara, n - 1))
  indexAnchors()
  if (dirty === 'all') {
    // Index shifts (splits/merges/imports) invalidate every cache entry.
    for (const k of Object.keys(paraCache)) delete paraCache[+k]
  }

  const lines: LineInfo[] = []
  const sectionsOut: SectionLayout[] = []
  let y = 0
  const dirtyFrom = dirty === 'all' ? 0 : dirty ? dirty.from : n
  const dirtyTo = dirty === 'all' ? n - 1 : dirty ? dirty.to : -1
  const maxObstructionBottom = view.images.reduce((m, im) => (im.loaded ? Math.max(m, im.y + im.h) : m), 0)

  for (let i = 0; i < n; i++) {
    // A tab opens here (docs/TABS.md): the roll is folded so the section starts
    // on a fresh page — that is what keeps writing in one tab from running into
    // the next one's page — and its title takes the space above the first line.
    const mark = sectionMarkAt(i)
    if (mark) {
      if (i > 0) y = Math.ceil(y / PAGE_HEIGHT) * PAGE_HEIGHT
      sectionsOut.push({ ...mark, paraIndex: i, y })
      y += titleBlockHeight(mark.level)
    }
    resolveAnchoredImages(i, y)
    const cached = paraCache[i]

    // Early exit: once past the dirty range and every image band with no
    // accumulated shift, nothing below can have moved - append the cached lines
    // verbatim. Validate the entire tail first and only then append: bailing out
    // half way used to leave the already-pushed lines and the advanced y in
    // place, so the fall-through re-appended them and doubled the document.
    if (i > dirtyTo && y > maxObstructionBottom && cached && cached.yStart === y) {
      let ok = true
      let probeY = y
      for (let j = i; j < n; j++) {
        const c = paraCache[j]
        // The probe must fold the roll exactly like the loop below does, or a
        // section start makes every yStart below it look wrong.
        if (j > i) {
          const jMark = sectionMarkAt(j)
          if (jMark) {
            probeY = Math.ceil(probeY / PAGE_HEIGHT) * PAGE_HEIGHT + titleBlockHeight(jMark.level)
          }
          resolveAnchoredImages(j, probeY)
        }
        if (
          !c ||
          c.yStart !== probeY ||
          c.docWidth !== docWidth ||
          c.version !== styleVersion(j) ||
          c.obstructionKey !== obstructionKey(j, probeY, c.height)
        ) {
          ok = false
          break
        }
        probeY += c.height + (j < n - 1 ? PARA_GAP : 0)
      }
      if (ok) {
        for (let j = i; j < n; j++) {
          // i's own marker was already consumed above; the rest still have to be
          // folded and recorded, or the tail's tabs vanish from the panel.
          if (j > i) {
            const jMark = sectionMarkAt(j)
            if (jMark) {
              y = Math.ceil(y / PAGE_HEIGHT) * PAGE_HEIGHT
              sectionsOut.push({ ...jMark, paraIndex: j, y })
              y += titleBlockHeight(jMark.level)
            }
          }
          const c = paraCache[j]
          for (const l of c.lines) lines.push(l)
          y += c.height + (j < n - 1 ? PARA_GAP : 0)
        }
        break
      }
    }

    const version = styleVersion(i)
    const page = Math.floor(y / PAGE_HEIGHT)
    // The cached height is only a safe extent when the cached layout is still
    // the one we would reuse. If the text or styles changed, the paragraph is
    // about to be re-fitted anyway, so probe a band at least as tall as the old
    // one to avoid missing an image the grown paragraph now reaches.
    const stale = !cached || cached.version !== version || cached.docWidth !== docWidth
    const extent = cached ? (stale ? Math.max(cached.height, estimateHeight(i)) : cached.height) : LINE_HEIGHT
    const key = obstructionKey(i, y, extent)
    const inDirty = dirty !== null && i >= dirtyFrom && i <= dirtyTo
    const mustRefit =
      inDirty ||
      !cached ||
      cached.version !== version ||
      cached.docWidth !== docWidth ||
      cached.page !== page ||
      cached.obstructionKey !== key

    if (mustRefit) {
      const { lines: paraLines, height } = layoutParagraph(doc.paragraphs[i], docWidth, y, i)
      lines.push(...paraLines)
      paraCache[i] = { version, docWidth, yStart: y, page, obstructionKey: key, lines: paraLines, height }
    } else if (cached.yStart !== y) {
      // Position-independent: translate instead of re-fitting. The cached lines
      // move *in place*. Cloning them at the new y while leaving the entry's own
      // lines at the old one recorded a yStart that its lines did not agree
      // with, so the next pass — which sees yStart === y and reuses them
      // verbatim — painted the paragraph back at its old position, on top of
      // whatever now lives there. Moving in place also drops one allocation per
      // line per edit.
      const dy = y - cached.yStart
      for (const l of cached.lines) {
        l.yTop += dy
        lines.push(l)
      }
      cached.yStart = y
    } else {
      for (const l of cached.lines) lines.push(l)
    }

    y += paraCache[i].height + (i < n - 1 ? PARA_GAP : 0)
  }

  view.lines = lines
  view.sections = sectionsOut
  // The panel is a view of this list. It changes on tab operations *and* on
  // ordinary typing (a tab slides down the roll as the one above it grows), so
  // signal only when the list really differs instead of on every keystroke.
  const signature = sectionsOut.map((s) => `${s.id}:${s.title}:${s.level}:${s.paraIndex}:${s.y}`).join('|')
  if (signature !== lastSectionSignature) {
    lastSectionSignature = signature
    notifySections()
  }
  const textHeight = y

  let maxImageBottom = 0
  for (const im of view.images) maxImageBottom = Math.max(maxImageBottom, im.y + im.h)
  const docHeight = Math.max(textHeight, maxImageBottom)
  view.docHeight = docHeight

  trace('layout', 'relayout', {
    ms: Math.round((performance.now() - relayoutStart) * 100) / 100,
    dirty: dirty === 'all' ? 'all' : dirty ? `${dirty.from}-${dirty.to}` : 'none',
    paragraphs: n,
    lines: lines.length,
    sections: sectionsOut.length,
    images: view.images.length,
    docHeight: Math.round(docHeight),
  })

  const pageCount = Math.max(1, Math.ceil(docHeight / PAGE_HEIGHT))
  const visualHeight = pageCount * PAGE_HEIGHT + (pageCount - 1) * PAGE_GAP
  const cssHeight = Math.max(160, visualHeight + PAD_Y * 2)

  // B4: the canvas is viewport-sized inside a scrolling spacer; the spacer
  // carries the full document height.
  const dpr = window.devicePixelRatio || 1
  const viewportH = docWrap.clientHeight || 600
  canvas.style.width = cssWidth + 'px'
  canvas.style.height = viewportH + 'px'
  canvas.width = Math.max(1, Math.round(cssWidth * dpr))
  canvas.height = Math.max(1, Math.round(viewportH * dpr))
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  docSpacer.style.height = cssHeight + 'px'

  for (const im of view.images) {
    im.wrapper.style.left = PAD_X + im.x + 'px'
    im.wrapper.style.top = PAD_Y + docToVisualY(im.y) + 'px'
    im.wrapper.style.width = im.w + 'px'
    im.wrapper.style.height = im.h + 'px'
  }

  draw()
}

let pendingRelayout = false
export function scheduleRelayout() {
  if (pendingRelayout) return
  pendingRelayout = true
  requestAnimationFrame(() => {
    pendingRelayout = false
    relayout()
  })
}
