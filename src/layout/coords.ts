// The one place a pointer position becomes a document position.
//
// There are two vertical coordinate systems in this editor and they drift apart
// by PAGE_GAP for every page you are down the document:
//
//   document Y — what the layout, the lines and the images are stored in
//   visual Y   — where things are painted, pages separated by PAGE_GAP
//
// Every bug of the shape "I clicked here and it went there" or "I dropped the
// image here and it landed pages later" has been one of them mixed up. Mixing
// them is silent near the top of the document, where the two agree, and gets
// worse the further down you work — which is exactly how it survives testing.
//
// So: converting is not something callers do by hand. They call this.

import { PAD_X, PAD_Y, PAGE_HEIGHT } from '../config'
import { docWrap } from '../dom'
import { doc } from '../state/doc'
import { titleBlockHeight } from '../render/title'
import { yOf } from './heights'
import { visualToDocY } from './pagination'

export interface DocumentPoint {
  /** X relative to the text column (document X === visual X: pages do not shift sideways). */
  x: number
  /** Y in document space, page gaps already removed. */
  y: number
}

/**
 * The document Y where a paragraph's text starts. The height index answers in
 * O(log n) for *every* paragraph — the old fallback scanned view.lines, which
 * no longer holds the whole document (docs/LAZY-LAYOUT.md §4), and would have
 * returned 0 for a far-away paragraph instead of its real position.
 *
 * A paragraph that opens a tab starts after the fold and its title
 * (docs/TABS.md): yOf(i) is the y *before* the fold, so a section-opening
 * paragraph's content sits at ceil(yOf/PAGE_HEIGHT)*PAGE_HEIGHT + title — the
 * exact y the engine hands to resolveAnchoredImages and records as the cache
 * entry's yStart. Returning the pre-fold y here would silently move every
 * image anchored to a section start by a fold's worth of pixels.
 */
export function paragraphTop(paraIndex: number): number {
  const y = yOf(paraIndex)
  const mark = doc.blockAttrs[paraIndex]?.section
  if (mark || paraIndex === 0) {
    const level = mark?.level ?? 0
    if (paraIndex > 0) return Math.ceil(y / PAGE_HEIGHT) * PAGE_HEIGHT + titleBlockHeight(level)
    return y + titleBlockHeight(level)
  }
  return y
}

/** Where a mouse event points, in document coordinates. */
export function pointerToDocument(clientX: number, clientY: number): DocumentPoint {
  const rect = docWrap.getBoundingClientRect()
  const visualY = docWrap.scrollTop + (clientY - rect.top) - PAD_Y
  return {
    x: clientX - rect.left - PAD_X,
    y: visualToDocY(visualY),
  }
}
