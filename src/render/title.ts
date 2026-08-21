// Tab titles, painted into the document itself (docs/TABS.md).
//
// A tab is not a file: it is a fold in one continuous roll of paper. So its
// title is not chrome around the document, it is the first thing *on* the page
// that tab opens — painted on the canvas, scrolling with the content, taking
// layout space so the first line of the section starts below it, and drawn by
// the exporters too.
//
// It is not part of `doc.paragraphs`: it is the section's name, kept on the
// paragraph's BlockAttrs. Putting it in the text would make it deletable, shift
// every offset by its length, and leave two copies of the same string to
// disagree.

import { FONT_FAMILY, INK, PAD_X, PAD_Y } from '../config'
import { docSpacer, docWrap } from '../dom'
import { docToVisualY } from '../layout/pagination'
import { view } from '../state/view'
import type { SectionLayout } from '../state/view'

export const TITLE_SPACE_ABOVE = 10
export const TITLE_SPACE_BELOW = 24

export function titleFontSize(level: 0 | 1): number {
  return level === 1 ? 23 : 30
}

export function titleFont(level: 0 | 1): string {
  return `600 ${titleFontSize(level)}px ${FONT_FAMILY}`
}

/** Space a title takes at the top of its section, in document Y. */
export function titleBlockHeight(level: 0 | 1 = 0): number {
  return TITLE_SPACE_ABOVE + Math.round(titleFontSize(level) * 1.2) + TITLE_SPACE_BELOW
}

/** The tab whose title band contains this document Y, if any. */
export function sectionTitleAt(docY: number): SectionLayout | null {
  for (const s of view.sections) {
    if (docY >= s.y && docY < s.y + titleBlockHeight(s.level)) return s
  }
  return null
}

export function drawSectionTitles(ctx: CanvasRenderingContext2D, viewTop: number, viewBottom: number): void {
  const prevFont = ctx.font
  const prevFill = ctx.fillStyle
  for (const s of view.sections) {
    const height = titleBlockHeight(s.level)
    const visualTop = PAD_Y + docToVisualY(s.y)
    if (visualTop > viewBottom || visualTop + height < viewTop) continue
    if (!s.title) continue
    ctx.font = titleFont(s.level)
    ctx.fillStyle = INK
    ctx.fillText(s.title, PAD_X, visualTop + TITLE_SPACE_ABOVE + titleFontSize(s.level) * 0.92)
  }
  ctx.font = prevFont
  ctx.fillStyle = prevFill
}

// ---- rename in place ---------------------------------------------------

let commit: (id: string, title: string) => void = () => {}

/**
 * Registered by the UI layer: render/ importing edit/ would close the cycle
 * render -> edit -> layout -> render.
 */
export function setTitleRenameCommit(fn: (id: string, title: string) => void): void {
  commit = fn
}

let input: HTMLInputElement | null = null

/** Click a title and type over it, as in the app this imitates. */
export function startTitleRename(section: SectionLayout): void {
  if (input) return
  const el = document.createElement('input')
  input = el
  el.type = 'text'
  el.className = 'doc-title-input'
  el.value = section.title
  el.style.left = PAD_X + 'px'
  el.style.top = PAD_Y + docToVisualY(section.y) + TITLE_SPACE_ABOVE - 4 + 'px'
  el.style.width = Math.max(160, view.docWidth) + 'px'
  el.style.font = titleFont(section.level)
  docSpacer.appendChild(el)
  el.focus()
  el.select()
  const close = (save: boolean) => {
    if (!input) return
    const value = el.value
    input = null
    el.remove()
    if (save) commit(section.id, value)
  }
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') close(true)
    else if (e.key === 'Escape') close(false)
    // The editor's own keyboard handler must not see these.
    e.stopPropagation()
  })
  el.addEventListener('blur', () => close(true))
  docWrap.scrollTop = docWrap.scrollTop
}
