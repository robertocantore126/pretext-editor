// Contract 1 (docs/PARALLEL-PLAN.md): Agent A implements, Agent B consumes.
//
// The single way to ask "what style is this character?". Layout, rendering and the
// exporters go through here and never touch doc.styles, so the representation can
// change (A1 already swapped TextMark[] for a Uint8Array of style bits,
// ARCHITECTURE.md §4.5) without any B-owned file changing.

import { doc } from '../state/doc'
import { paragraphVersion } from './dirty'

export interface Style {
  bold: boolean
  italic: boolean
  underline: boolean
  headline: boolean
}

export interface StyleRun extends Style {
  start: number
  end: number
}

// One byte per character: bits for bold/italic/underline/headline.
export const STYLE_BOLD = 1
export const STYLE_ITALIC = 2
export const STYLE_UNDERLINE = 4
export const STYLE_HEADLINE = 8

export function emptyStyle(): Style {
  return { bold: false, italic: false, underline: false, headline: false }
}

export function sameStyle(a: Style, b: Style): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.headline === b.headline
}

function styleFromByte(byte: number): Style {
  return {
    bold: (byte & STYLE_BOLD) !== 0,
    italic: (byte & STYLE_ITALIC) !== 0,
    underline: (byte & STYLE_UNDERLINE) !== 0,
    headline: (byte & STYLE_HEADLINE) !== 0,
  }
}

export function styleAt(paraIndex: number, offset: number): Style {
  const bytes = doc.styles[paraIndex]
  if (!bytes || offset < 0 || offset >= bytes.length) return emptyStyle()
  return styleFromByte(bytes[offset])
}

/**
 * Contiguous runs of identical style across the whole paragraph, in order.
 * O(chars): a single pass over the style bytes.
 */
export function getStyleRuns(paraIndex: number): StyleRun[] {
  const text = doc.paragraphs[paraIndex] ?? ''
  const bytes = doc.styles[paraIndex]
  const runs: StyleRun[] = []
  let i = 0
  while (i < text.length) {
    const byte = bytes?.[i] ?? 0
    const style = styleFromByte(byte)
    let len = 1
    while (i + len < text.length && (bytes?.[i + len] ?? 0) === byte) len++
    runs.push({ start: i, end: i + len, ...style })
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
  const bytes = doc.styles[paraIndex]
  if (!bytes) return false
  const from = Math.max(0, start)
  const to = Math.min(end, bytes.length)
  for (let i = from; i < to; i++) {
    if (bytes[i] & STYLE_HEADLINE) return true
  }
  return false
}

/** Cache key for layout: bumps whenever this paragraph's text or styles change. */
export function styleVersion(paraIndex: number): number {
  return paragraphVersion(paraIndex)
}
