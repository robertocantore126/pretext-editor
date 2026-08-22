// B4 - Viewport-sized canvas inside a scrolling spacer.
// Owned by Agent B (docs/PARALLEL-PLAN.md).
//
// The canvas is pinned to the visible top of .doc-wrap and draw() paints in
// document coordinates translated by scrollTop, so all scrolling has to do is
// repaint. Without this listener the canvas keeps whatever it painted at the
// previous scroll position and the document appears frozen while scrolling.
//
// With lazy layout (docs/LAZY-LAYOUT.md §4) repainting is no longer enough:
// the incoming band must be *materialized* first — the paragraphs scrolling
// into view have no lines until this pass runs — and the estimate-to-measure
// correction has to adjust scrollTop. So the scroll handler runs relayout(),
// which materializes the new window, applies the correction and draws.

import { docWrap } from '../dom'
import { relayout } from '../layout/engine'

export function initVirtualScroll(): void {
  let pending = false
  docWrap.addEventListener(
    'scroll',
    () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        relayout()
      })
    },
    { passive: true }
  )
}
