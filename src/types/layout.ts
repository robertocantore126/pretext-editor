// Layout and rendering types. Owned by Agent B (see docs/PARALLEL-PLAN.md).

import type { Style } from '../model/runs'
export interface FloatImage {
  id: string
  img: HTMLImageElement
  wrapper: HTMLDivElement
  x: number
  y: number
  w: number
  h: number
  loaded: boolean
  objectUrl: string
  alphaMap?: {
    w: number
    h: number
    data: Uint8Array
    /** [minX, maxX] per row in map-local pixels, -1 when the row is fully transparent. */
    rowSpans: Int16Array
    scale: number
  }
}

export interface LineInfo {
  paraIndex: number
  text: string
  x: number
  yTop: number
  width: number
  startOffset: number
  endOffset: number
  /** The real height of this visual line (headline lines are taller). */
  height: number
  /**
   * Justified lines only (RICH-TEXT-MODEL.md §7): extra pixels to add after
   * each inter-word gap when painting, so the line fills its slot. pretext
   * still decides the breaks; this is a paint-time pass on its output.
   */
  justifyGap?: number
  /** Extra pixels this fragment starts at: its share of the gaps before it. */
  justifyOffset?: number
}

/** One contiguous styled run of a paragraph, with per-char widths and their prefix sums. */
export interface CharRun {
  start: number
  end: number
  text: string
  style: Style
  charWidths: number[]
  /** prefix[k] = width of the first k chars of this run; width(b..a) = prefix[b] - prefix[a]. */
  prefix: Float64Array
  width: number
}
