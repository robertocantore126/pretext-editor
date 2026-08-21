// Document-model types. Owned by Agent A (see docs/PARALLEL-PLAN.md).

export interface Cursor {
  para: number
  offset: number
}

export interface Selection {
  anchor: Cursor
  focus: Cursor
}

/**
 * One interned character-level style (RICH-TEXT-MODEL.md §4.1). The table lives
 * on `doc.styleTable`; `doc.styleIds` (Uint16Array per paragraph, parallel to
 * the text) references entries by index. Interned once at creation, so the
 * pretext-facing font string is derived from a stable entry.
 */
export interface InlineStyle {
  fontFamily: string // full CSS stack, as computed
  fontSize: number // px
  fontWeight: number // 100-900
  italic: boolean
  underline: boolean
  strike: boolean
  color: string
  background: string | null // null = transparent
  letterSpacing: number // px, 0 for 'normal'
  baseline: 'normal' | 'super' | 'sub'
  linkHref: string | null
  /** Legacy whole-paragraph flag; migrates to BlockAttrs.kind='heading' (§4.2). */
  headline: boolean
}

/**
 * Paragraph-level attributes (RICH-TEXT-MODEL.md §4.2), stored parallel to
 * `doc.paragraphs` as `doc.blockAttrs`. None of the current consumers read them
 * yet; applyEdit keeps the array in sync so the HTML importer can land on top.
 */
export interface BlockAttrs {
  kind: 'paragraph' | 'heading' | 'listItem' | 'preformatted'
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6
  align: 'left' | 'center' | 'right' | 'justify'
  indentLeft: number
  indentRight: number
  indentFirstLine: number
  spaceBefore: number
  spaceAfter: number
  lineHeight: number | null // null = use the font's default
  list?: { type: 'bullet' | 'number'; level: number; marker: string }
  whiteSpace: 'normal' | 'pre'
  direction: 'ltr' | 'rtl'
}

/** Legacy on-disk marks format (bold/italic/underline/headline), still accepted on import. */
export interface TextMark {
  start: number
  end: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  headline?: boolean
}

export interface SerializedImage {
  x: number
  y: number
  w: number
  h: number
  type: string
  dataUrl: string
}

/** v1 on-disk format: paragraphs + offset marks. */
export interface SerializedDocument {
  paragraphs: string[]
  marks: TextMark[][]
  images: SerializedImage[]
}

/** v2 on-disk format (RICH-TEXT-MODEL.md §4.1): interned style table + per-char ids. */
export interface RichSerializedDocument {
  version: 2
  paragraphs: string[]
  styleTable: InlineStyle[]
  styleIds: number[][]
  images: SerializedImage[]
}
