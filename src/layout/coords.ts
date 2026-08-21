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

import { PAD_X, PAD_Y } from '../config'
import { docWrap } from '../dom'
import { view } from '../state/view'
import { paraCache } from './cache'
import { visualToDocY } from './pagination'

export interface DocumentPoint {
  /** X relative to the text column (document X === visual X: pages do not shift sideways). */
  x: number
  /** Y in document space, page gaps already removed. */
  y: number
}

/**
 * The document Y where a paragraph starts. From the layout cache when it is
 * there, otherwise from the lines it emitted — one of the two always is, for a
 * paragraph that has been laid out.
 */
export function paragraphTop(paraIndex: number): number {
  const cached = paraCache[paraIndex]
  if (cached) return cached.yStart
  let top: number | null = null
  for (const line of view.lines) {
    if (line.paraIndex === paraIndex) top = top === null ? line.yTop : Math.min(top, line.yTop)
  }
  return top ?? 0
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
