import type { FloatImage, LineInfo } from '../types/layout'

// View state: everything derived from the document, plus transient UI state.
// Owned by Agent B. runCache and the per-paragraph layout cache live in
// layout/cache.ts (B3).

/** A tab as the layout placed it on the roll (docs/TABS.md): where to unroll to. */
export interface SectionLayout {
  id: string
  title: string
  level: 0 | 1
  paraIndex: number
  /** Document Y of the top of the section — the page it starts on. */
  y: number
}

export const view = {
  images: [] as FloatImage[],
  selectedImageId: null as string | null,
  lines: [] as LineInfo[],
  sections: [] as SectionLayout[],
  docWidth: 0,
  docHeight: 0,
  focused: false,
  caretVisible: true,
  selectingText: false,
  /**
   * A drag in flight. startX/startY are client pixels (the resize needs a plain
   * delta); grabX/grabY are the same point in *document* coordinates, which is
   * what a move needs — adding a client delta to a document Y drifts by
   * PAGE_GAP for every page boundary the pointer crosses (layout/coords.ts).
   */
  dragging: null as null | { id: string; mode: 'move' | 'resize'; startX: number; startY: number; grabX: number; grabY: number; origX: number; origY: number; origW: number; origH: number; aspect: number },
}
