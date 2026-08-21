// Contract 1 (docs/PARALLEL-PLAN.md): Agent A implements, Agent B consumes.
//
// The single way to ask "what style is this character?". Layout, rendering and the
// exporters go through here and never touch doc.styleIds/styleTable, so the
// representation can change (A1 swapped TextMark[] for style bytes; the rich-text
// model now swaps bytes for an interned InlineStyle table, RICH-TEXT-MODEL.md §4.1)
// without any B-owned file changing.

import { doc } from '../state/doc'
import { paragraphVersion } from './dirty'
import type { InlineStyle } from '../types/doc'

export interface Style {
  bold: boolean
  italic: boolean
  underline: boolean
  headline: boolean
  strike: boolean
  color: string
  background: string | null
  fontSize: number
  fontFamily: string
  fontWeight: number
  letterSpacing: number
  baseline: 'normal' | 'super' | 'sub'
  linkHref: string | null
}

export interface StyleRun extends Style {
  start: number
  end: number
  styleId: number
}

// Legacy style-byte bits (ARCHITECTURE.md §4.5, retired). Only the import
// converters (io/json.ts, io/persistence.ts) still use them to read old files.
export const STYLE_BOLD = 1
export const STYLE_ITALIC = 2
export const STYLE_UNDERLINE = 4
export const STYLE_HEADLINE = 8

function defaultEntry(): InlineStyle {
  return doc.styleTable[0]
}

function styleFromEntry(e: InlineStyle): Style {
  return {
    bold: e.fontWeight >= 700,
    italic: e.italic,
    underline: e.underline,
    headline: e.headline,
    strike: e.strike,
    color: e.color,
    background: e.background,
    fontSize: e.fontSize,
    fontFamily: e.fontFamily,
    fontWeight: e.fontWeight,
    letterSpacing: e.letterSpacing,
    baseline: e.baseline,
    linkHref: e.linkHref,
  }
}

export function emptyStyle(): Style {
  return styleFromEntry(defaultEntry())
}

export function styleById(id: number): Style {
  return styleFromEntry(doc.styleTable[id] ?? defaultEntry())
}

export function styleAt(paraIndex: number, offset: number): Style {
  const ids = doc.styleIds[paraIndex]
  if (!ids || offset < 0 || offset >= ids.length) return emptyStyle()
  return styleById(ids[offset])
}

/**
 * Contiguous runs of identical style across the whole paragraph, in order.
 * O(chars): a single pass over the style ids.
 */
export function getStyleRuns(paraIndex: number): StyleRun[] {
  const text = doc.paragraphs[paraIndex] ?? ''
  const ids = doc.styleIds[paraIndex]
  const runs: StyleRun[] = []
  let i = 0
  while (i < text.length) {
    const id = ids?.[i] ?? 0
    const style = styleById(id)
    let len = 1
    while (i + len < text.length && (ids?.[i + len] ?? 0) === id) len++
    runs.push({ start: i, end: i + len, styleId: id, ...style })
    i += len
  }
  return runs
}

/** The runs overlapping [start, end), clipped to it. Used to paint one line. */
export function getStyleRunsInRange(paraIndex: number, start: number, end: number): StyleRun[] {
  const out: StyleRun[] = []
  for (const r of getStyleRuns(paraIndex)) {
    if (r.end <= start) continue
    if (r.start >= end) break
    out.push({ ...r, start: Math.max(r.start, start), end: Math.min(r.end, end) })
  }
  return out
}

export function hasHeadlineInRange(paraIndex: number, start: number, end: number): boolean {
  const ids = doc.styleIds[paraIndex]
  if (!ids) return false
  const from = Math.max(0, start)
  const to = Math.min(end, ids.length)
  for (let i = from; i < to; i++) {
    if (doc.styleTable[ids[i]]?.headline) return true
  }
  return false
}

/** Cache key for layout: bumps whenever this paragraph's text or styles change. */
export function styleVersion(paraIndex: number): number {
  return paragraphVersion(paraIndex)
}

export function sameStyle(a: Style, b: Style): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.headline === b.headline &&
    a.strike === b.strike &&
    a.color === b.color &&
    a.background === b.background &&
    a.fontSize === b.fontSize &&
    a.fontFamily === b.fontFamily &&
    a.fontWeight === b.fontWeight &&
    a.letterSpacing === b.letterSpacing &&
    a.baseline === b.baseline &&
    a.linkHref === b.linkHref
  )
}

/** The effective px size of a run: headline paragraphs render ~1.6x (legacy behaviour). */
export function styleFontSize(style: Style): number {
  return style.headline ? Math.round(style.fontSize * 1.6) : style.fontSize
}

/** The full CSS font shorthand pretext consumes, built from the interned entry. */
export function fontForStyle(style: Style): string {
  const parts: string[] = []
  if (style.italic) parts.push('italic')
  parts.push(String(style.bold ? 700 : style.fontWeight))
  parts.push(Math.round(styleFontSize(style)) + 'px')
  return parts.join(' ') + ' ' + style.fontFamily
}
