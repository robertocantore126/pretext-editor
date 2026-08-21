import { docSpacer } from '../dom'
import { view } from '../state/view'

// Caret rendering (ARCHITECTURE.md §4.4, docs/PARALLEL-PLAN.md B4): a DOM div
// with a pure-CSS blink, so an idle editor does zero canvas work. draw() calls
// updateCaretDom() on every repaint; the A-owned edit layer keeps calling
// resetCaretBlink/stopCaretBlink, which now only flip the visibility flag.

let caretEl: HTMLDivElement | null = null

function ensureEl(): HTMLDivElement {
  if (!caretEl) {
    caretEl = document.createElement('div')
    caretEl.className = 'caret-dom'
    docSpacer.appendChild(caretEl)
  }
  return caretEl
}

/** Position and show/hide the caret div. Coordinates are spacer-local. */
export function updateCaretDom(x: number, y: number, height: number, visible: boolean): void {
  const el = ensureEl()
  el.style.left = x + 'px'
  el.style.top = y + 'px'
  el.style.height = height + 'px'
  el.style.display = visible ? 'block' : 'none'
}

export function resetCaretBlink(): void {
  // The blink is pure CSS; nothing to schedule. Showing the element restarts
  // the animation from opacity 1.
  view.caretVisible = true
}

export function stopCaretBlink(): void {
  view.caretVisible = false
}
