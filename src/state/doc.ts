import type { BlockAttrs, Cursor, InlineStyle, Selection } from '../types/doc'
import { FONT_FAMILY, FONT_SIZE, INK } from '../config'

// Document state: what the user is editing. Owned by Agent A.
// Mutations must funnel through model/ and edit/ - never assigned from layout or render.
//
// RICH-TEXT-MODEL.md §4.1: styleIds is a per-paragraph Uint16Array parallel to
// the text, one id per character into the shared styleTable (inline styles,
// interned). Every edit splices text and style ids in lockstep through applyEdit
// (model/document.ts), so offsets cannot desynchronise. blockAttrs (§4.2) is a
// parallel array of paragraph-level attributes, kept in sync by applyEdit.

export function defaultStyle(): InlineStyle {
  return {
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    fontWeight: 400,
    italic: false,
    underline: false,
    strike: false,
    color: INK,
    background: null,
    letterSpacing: 0,
    baseline: 'normal',
    linkHref: null,
    headline: false,
  }
}

export function defaultBlockAttrs(): BlockAttrs {
  return {
    kind: 'paragraph',
    align: 'left',
    indentLeft: 0,
    indentRight: 0,
    indentFirstLine: 0,
    spaceBefore: 0,
    spaceAfter: 0,
    lineHeight: null,
    whiteSpace: 'normal',
    direction: 'ltr',
  }
}

const initialText =
  'Scrivi qui il tuo documento. Il testo viene impaginato da pretext senza mai toccare il DOM per la misura: incolla un\u2019immagine (Ctrl/Cmd+V) oppure trascinala qui dentro da fuori, poi spostala per vedere il testo ricalcolare la propria larghezza riga per riga attorno ad essa.'

export const doc = {
  paragraphs: [initialText, ''],
  styleIds: [new Uint16Array(initialText.length), new Uint16Array(0)] as Uint16Array[],
  styleTable: [defaultStyle()] as InlineStyle[],
  blockAttrs: [defaultBlockAttrs(), defaultBlockAttrs()] as BlockAttrs[],
  cursor: { para: 0, offset: 0 } as Cursor,
  selection: null as Selection | null,
}
