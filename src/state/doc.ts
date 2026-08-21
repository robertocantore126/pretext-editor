import type { Cursor, Selection } from '../types/doc'

// Document state: what the user is editing. Owned by Agent A.
// Mutations must funnel through model/ and edit/ - never assigned from layout or render.
//
// A1 (docs/PARALLEL-PLAN.md): styles is a per-paragraph Uint8Array parallel to the
// text, one byte per character with bits bold/italic/underline/headline
// (ARCHITECTURE.md §4.5). Every edit splices text and styles in lockstep through
// applyEdit (model/document.ts), so offsets cannot desynchronise.

const initialText =
  'Scrivi qui il tuo documento. Il testo viene impaginato da pretext senza mai toccare il DOM per la misura: incolla un\u2019immagine (Ctrl/Cmd+V) oppure trascinala qui dentro da fuori, poi spostala per vedere il testo ricalcolare la propria larghezza riga per riga attorno ad essa.'

export const doc = {
  paragraphs: [initialText, ''],
  styles: [new Uint8Array(initialText.length), new Uint8Array(0)] as Uint8Array[],
  cursor: { para: 0, offset: 0 } as Cursor,
  selection: null as Selection | null,
}
