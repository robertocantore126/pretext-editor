// Layout and rendering types. Owned by Agent B (see docs/PARALLEL-PLAN.md).

import type { Style } from '../model/runs'
export interface FloatImage {
  id: string
  img: HTMLImageElement
  wrapper: HTMLDivElement
  x: number
  /**
   * Document Y, **derived** every layout pass from the anchor below. Do not
   * assign it outside the engine: an absolute Y stops meaning anything the
   * moment text above the image is edited, which is the whole reason the anchor
   * exists.
   */
  y: number
  /**
   * The paragraph this image belongs beside, and how far below that paragraph's
   * top it sits. Editing above the anchor moves the paragraph and the image
   * together; editing below leaves both where they are.
   *
   * The index is kept correct across splits and merges by the same splice
   * mechanism that re-keys the layout caches (model/dirty.ts).
   */
  anchorPara: number
  anchorDy: number
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
  /**
   * True when the silhouette could not be sampled (canvas tainted by a
   * cross-origin image without CORS): the wrap falls back to the bounding box
   * and the handle is marked + tooltipped instead of degrading silently
   * (FIXPLAN.md fix 3).
   */
  silhouetteUnavailable?: boolean
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
