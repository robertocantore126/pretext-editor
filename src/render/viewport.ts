// B4 - Viewport-sized canvas inside a scrolling spacer.
// Owned by Agent B (docs/PARALLEL-PLAN.md).
//
// The canvas is pinned to the visible top of .doc-wrap and draw() paints in
// document coordinates translated by scrollTop, so all scrolling has to do is
// repaint. Without this listener the canvas keeps whatever it painted at the
// previous scroll position and the document appears frozen while scrolling.

import { docWrap } from '../dom'
import { draw } from './draw'

export function initVirtualScroll(): void {
  let pending = false
  docWrap.addEventListener(
    'scroll',
    () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        draw()
      })
    },
    { passive: true }
  )
}
