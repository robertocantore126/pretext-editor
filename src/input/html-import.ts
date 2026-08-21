// RICH-TEXT-MODEL.md §6 - HTML import: pasted markup becomes rich text.
//
// There is no HTML parser and no CSS cascade engine here: the browser is both.
// The sanitised markup is imported into an offscreen shadow root and walked with
// getComputedStyle, so classes, <style> blocks, inheritance and unit conversion
// (18pt -> 24px) are all resolved for free. Two properties the browser will not
// resolve - text-decoration and background-color, which propagate visually but
// are not inherited - are accumulated on the walker's context stack (§3).
//
// Structure comes from `display`, not tag names: any block-level element opens a
// block, any inline element stays inside it. Images never enter the text flow:
// they are collected during sanitisation and handed to the existing floating
// image system (§6.4, frozen by design).

import { recordEdit } from '../edit/history'
import { addImageFromSrc } from '../images/images'
import { applyEdit, selectionDeleteSpec } from '../model/document'
import { internStyle } from '../model/styles'
import { relayout } from '../layout/engine'
import { defaultBlockAttrs, defaultStyle, doc } from '../state/doc'
import { view } from '../state/view'
import type { BlockAttrs, InlineStyle } from '../types/doc'

// RICH-TEXT-MODEL.md §12: a page full of images is a memory and network event,
// so a single paste imports at most this many images; the rest are dropped.
const MAX_IMAGES_PER_PASTE = 20

interface PendingBlock {
  text: string
  ids: number[]
  attrs: BlockAttrs
}

interface ListFrame {
  type: 'bullet' | 'number'
  counter: number
}

interface WalkContext {
  underline: boolean
  strike: boolean
  background: string | null
  whiteSpace: 'normal' | 'pre'
  linkHref: string | null
  listStack: ListFrame[]
  /** Accumulated indentation of the enclosing <ul>/<ol> containers. */
  listIndent: number
}

const isCollapsible = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r'

function px(v: string): number {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * The element's own background, or null when it must not become a text
 * highlight. Transparent is null; so is page chrome — colours that are
 * near-achromatic AND near-white or near-black, the classic page and box
 * backgrounds (Wikipedia's #fdfdfd navbox, #f8f9fa boxes, dark-mode #1f1f23,
 * Word's #d9d9d9 shading). Without this, pasting from Wikipedia painted every
 * character with the page's white: the walker accumulates the first
 * non-transparent ancestor background and applies it to the whole subtree.
 * Genuine highlights are coloured and keep their saturation, so they survive
 * (a yellow <mark>, the nested red-on-yellow of VERIFY.md §8.3).
 */
function ownBackground(cs: CSSStyleDeclaration): string | null {
  const bg = cs.backgroundColor
  if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') return null
  const m = bg.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (m) {
    const r = +m[1]
    const g = +m[2]
    const b = +m[3]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    if (max - min <= 24 && (max > 200 || max < 70)) return null
  }
  return bg
}

/** The accumulated character style for text inside `el`. */
function styleFromComputed(el: HTMLElement, ctx: WalkContext): InlineStyle {
  const cs = getComputedStyle(el)
  const w = parseFloat(cs.fontWeight)
  const ls = parseFloat(cs.letterSpacing)
  const va = cs.verticalAlign
  return {
    fontFamily: cs.fontFamily,
    fontSize: parseFloat(cs.fontSize) || defaultStyle().fontSize,
    fontWeight: Number.isFinite(w) ? w : 400,
    italic: cs.fontStyle === 'italic' || cs.fontStyle === 'oblique',
    underline: ctx.underline,
    strike: ctx.strike,
    color: cs.color,
    background: ownBackground(cs) ?? ctx.background,
    letterSpacing: Number.isFinite(ls) ? ls : 0,
    baseline: va === 'super' ? 'super' : va === 'sub' ? 'sub' : 'normal',
    linkHref: ctx.linkHref,
    headline: false,
  }
}

function blockAttrsFromElement(el: HTMLElement, cs: CSSStyleDeclaration, ctx: WalkContext): BlockAttrs {
  const tag = el.tagName.toLowerCase()
  const isHeading = /^h[1-6]$/.test(tag)
  const align = cs.textAlign === 'start' ? 'left' : cs.textAlign === 'end' ? 'right' : cs.textAlign
  const attrs: BlockAttrs = {
    kind: isHeading ? 'heading' : cs.whiteSpace.startsWith('pre') ? 'preformatted' : 'paragraph',
    ...(isHeading ? { headingLevel: Number(tag[1]) as 1 | 2 | 3 | 4 | 5 | 6 } : {}),
    align: (align === 'center' || align === 'right' || align === 'justify' ? align : 'left') as BlockAttrs['align'],
    indentLeft: px(cs.marginLeft) + px(cs.paddingLeft),
    indentRight: px(cs.marginRight) + px(cs.paddingRight),
    indentFirstLine: px(cs.textIndent),
    spaceBefore: px(cs.marginTop),
    spaceAfter: px(cs.marginBottom),
    lineHeight: cs.lineHeight !== 'normal' && parseFloat(cs.lineHeight) > 0 ? parseFloat(cs.lineHeight) : null,
    whiteSpace: cs.whiteSpace.startsWith('pre') ? 'pre' : 'normal',
    direction: cs.direction === 'rtl' ? 'rtl' : 'ltr',
  }
  if (cs.display === 'list-item' && ctx.listStack.length > 0) {
    const top = ctx.listStack[ctx.listStack.length - 1]
    attrs.kind = 'listItem'
    attrs.list = {
      type: top.type,
      level: ctx.listStack.length,
      marker: top.type === 'bullet' ? '•' : String(top.counter) + '.',
    }
    // The li itself has no margin; the indent lives on the enclosing list's
    // padding-inline-start, which the browser default puts at 40px.
    attrs.indentLeft += ctx.listIndent
  }
  return attrs
}

/**
 * Sanitises the inert parsed document. Runs BEFORE anything touches the live
 * DOM: once a subtree is attached, <img onerror> becomes executable.
 * <style> is kept - it carries the formatting and the shadow root scopes it.
 * <img> elements are removed here (no network load in the walk) and their
 * srcs returned for the floating-image pipeline.
 */
function sanitize(inert: Document): { srcs: string[] } {
  const srcs: string[] = []
  const badTags = new Set([
    'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
    'form', 'input', 'button', 'select', 'textarea',
  ])
  for (const el of Array.from(inert.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase()
    if (badTags.has(tag)) {
      el.remove()
      continue
    }
    if (tag === 'img') {
      const src = el.getAttribute('src')
      if (src && /^(https?:|data:image\/|blob:)/i.test(src)) srcs.push(src)
      el.remove()
      continue
    }
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name)
      else if (
        (attr.name === 'href' || attr.name === 'src') &&
        /^\s*(javascript:|data:text\/html)/i.test(attr.value)
      ) {
        el.removeAttribute(attr.name)
      }
    }
  }
  return { srcs }
}

/**
 * Walks the shadow root and emits text blocks with interned style ids and
 * block attributes. Block boundaries come from `display`; inline elements
 * only extend the current block. Whitespace is collapsed here (not by pretext)
 * so text and style ids stay aligned in the stored model.
 */
function walk(nodes: Node[]): PendingBlock[] {
  const out: PendingBlock[] = []
  let pending: PendingBlock | null = null
  let curStyle: InlineStyle = defaultStyle()

  function closeBlock(): void {
    if (!pending) return
    // Trim trailing collapsible whitespace in lockstep with the ids.
    let end = pending.text.length
    while (end > 0 && isCollapsible(pending.text[end - 1])) end--
    if (end < pending.text.length) {
      pending.text = pending.text.slice(0, end)
      pending.ids.length = end
    }
    if (pending.text.length > 0) out.push(pending)
    pending = null
  }

  function openBlock(attrs: BlockAttrs): void {
    closeBlock()
    pending = { text: '', ids: [], attrs }
  }

  function appendText(s: string, ctx: WalkContext): void {
    if (!pending) pending = { text: '', ids: [], attrs: defaultBlockAttrs() }
    const id = internStyle(curStyle)
    for (const ch of s) {
      if (ctx.whiteSpace === 'normal' && isCollapsible(ch)) {
        if (pending.text.length === 0) continue
        if (isCollapsible(pending.text[pending.text.length - 1])) continue
      }
      pending.text += ch
      pending.ids.push(id)
    }
  }

  function visit(node: Node, ctx: WalkContext): void {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue && node.nodeValue.length > 0) appendText(node.nodeValue, ctx)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()
    if (tag === 'br') {
      closeBlock()
      return
    }
    const cs = getComputedStyle(el)
    const display = cs.display
    const isBlock =
      display !== 'inline' &&
      display !== 'inline-block' &&
      display !== 'inline-flex' &&
      display !== 'contents'

    const deco = cs.textDecorationLine || ''
    const childCtx: WalkContext = {
      underline: ctx.underline || deco.includes('underline'),
      strike: ctx.strike || deco.includes('line-through'),
      background: ctx.background || ownBackground(cs),
      whiteSpace: cs.whiteSpace === 'pre' || cs.whiteSpace === 'pre-wrap' ? 'pre' : 'normal',
      linkHref: tag === 'a' ? el.getAttribute('href') || ctx.linkHref : ctx.linkHref,
      listStack: ctx.listStack.slice(),
      listIndent: ctx.listIndent,
    }
    if (tag === 'ul' || tag === 'ol') {
      childCtx.listStack.push({ type: tag === 'ul' ? 'bullet' : 'number', counter: 0 })
      childCtx.listIndent += px(cs.paddingLeft) + px(cs.marginLeft)
    }
    else if (tag === 'li' && childCtx.listStack.length > 0) {
      const top = childCtx.listStack[childCtx.listStack.length - 1]
      if (top.type === 'number') top.counter++
    }

    // curStyle is what appendText interns, so an inline element's style must
    // not leak into the siblings that follow it: save and restore around the
    // children. (A block element's style is scoped by its own open/close.)
    const savedStyle = curStyle
    curStyle = styleFromComputed(el, childCtx)

    let opened = false
    if (isBlock) {
      openBlock(blockAttrsFromElement(el, cs, childCtx))
      opened = true
    }
    for (const child of Array.from(el.childNodes)) visit(child, childCtx)
    if (opened) closeBlock()
    curStyle = savedStyle
  }

  const rootCtx: WalkContext = {
    underline: false,
    strike: false,
    background: null,
    whiteSpace: 'normal',
    linkHref: null,
    listStack: [],
    listIndent: 0,
  }
  for (const child of nodes) visit(child, rootCtx)
  closeBlock()
  return out
}

/**
 * Pastes foreign HTML at the cursor: sanitise, cascade in an offscreen shadow
 * root, walk to blocks, then insert through applyEdit (undoable) with the
 * imported block attributes applied to the new paragraphs. Pasted images are
 * added as floating boxes via the existing image system.
 */
export function importHTML(html: string): void {
  const inert = new DOMParser().parseFromString(html, 'text/html')
  const srcs = sanitize(inert).srcs.slice(0, MAX_IMAGES_PER_PASTE)

  const host = document.createElement('div')
  host.style.cssText = `position:fixed;left:-99999px;top:0;width:${view.docWidth || 800}px;visibility:hidden;`
  const shadow = host.attachShadow({ mode: 'open' })
  // <style> lives in the head of the parsed document; import it into the shadow
  // root so the cascade sees it, scoped away from the host page.
  for (const s of Array.from(inert.head.querySelectorAll('style'))) {
    shadow.appendChild(document.importNode(s, true))
  }
  // Only the body content is walked: the head <style> elements are imported for
  // the cascade but their text must never become paragraphs.
  const bodyNodes: Node[] = []
  for (const child of Array.from(inert.body.childNodes)) {
    bodyNodes.push(shadow.appendChild(document.importNode(child, true)))
  }
  document.body.appendChild(host)
  const blocks = walk(bodyNodes)
  host.remove()

  // A block may hold internal newlines (<pre>); applyEdit splits on '\n', so
  // expand each block into per-line paragraphs with id slices kept in lockstep.
  const expanded: { text: string; ids: Uint16Array; attrs: BlockAttrs }[] = []
  for (const b of blocks) {
    const parts = b.text.split('\n')
    let off = 0
    for (const part of parts) {
      if (part.length === 0) {
        off += 1
        continue
      }
      expanded.push({ text: part, ids: Uint16Array.from(b.ids.slice(off, off + part.length)), attrs: b.attrs })
      off += part.length + 1
    }
  }
  const joined = expanded.map((e) => e.text).join('\n')
  if (!joined && srcs.length === 0) return
  if (!joined && srcs.length > 0) {
    // Image-only paste: no text to insert, just place the images.
    for (const src of srcs) addImageFromSrc(src)
    return
  }

  const spec = selectionDeleteSpec()
  const para = spec?.para ?? doc.cursor.para
  const offset = spec?.offset ?? doc.cursor.offset
  const deleteCount = spec?.deleteCount ?? 0
  const rec = applyEdit(para, offset, deleteCount, joined, expanded.map((e) => e.ids))
  recordEdit(rec)
  // The inserted paragraphs occupy rec.paraIndex .. rec.paraIndex + n - 1.
  for (let i = 0; i < expanded.length; i++) {
    doc.blockAttrs[rec.paraIndex + i] = expanded[i].attrs
  }
  for (const src of srcs) addImageFromSrc(src)
  relayout()
}
