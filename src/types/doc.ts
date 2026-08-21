// Document-model types. Owned by Agent A (see docs/PARALLEL-PLAN.md).

export interface Cursor {
  para: number
  offset: number
}

export interface Selection {
  anchor: Cursor
  focus: Cursor
}

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

export interface SerializedDocument {
  paragraphs: string[]
  marks: TextMark[][]
  images: SerializedImage[]
}
