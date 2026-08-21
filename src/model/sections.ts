// Tabs, as sections of one continuous document (docs/TABS.md). Owned by Agent A.
//
// The document is a single roll of paper. A tab is a bookmark that folds it: it
// marks the paragraph where a section starts, gives it a title, and makes the
// layout begin that section on a fresh page so writing in one tab never runs
// into the next one's page. Clicking a tab scrolls the roll to that point —
// nothing is loaded or swapped, because there is nothing to swap.
//
// The marker lives on the paragraph (BlockAttrs.section), never in a separate
// index list: applyEdit already splices blockAttrs alongside the text, so splits,
// merges and paragraph inserts move it correctly with no maintenance at all.

import { doc } from '../state/doc'

export interface SectionMark {
  id: string
  title: string
  level: 0 | 1
}

export interface SectionRef extends SectionMark {
  /** Index of the paragraph that opens the section. */
  paraIndex: number
}

let counter = 0
export function newSectionId(): string {
  counter += 1
  return `s${Date.now().toString(36)}${counter}`
}

export const DEFAULT_FIRST_TITLE = 'Documento'

/**
 * Every section, in document order. Paragraph 0 always opens one even when it
 * carries no marker (a fresh or imported document): a roll of paper with no
 * bookmark at the top still has a beginning, and the panel must never be empty.
 */
export function sections(): SectionRef[] {
  const out: SectionRef[] = []
  for (let i = 0; i < doc.blockAttrs.length; i++) {
    const mark = doc.blockAttrs[i]?.section
    if (mark) out.push({ ...mark, paraIndex: i })
    else if (i === 0) out.push({ id: 'implicit-first', title: DEFAULT_FIRST_TITLE, level: 0, paraIndex: 0 })
  }
  return out
}

/** The section a paragraph belongs to: the nearest marker at or above it. */
export function sectionAt(paraIndex: number): SectionRef | null {
  const list = sections()
  let found: SectionRef | null = null
  for (const s of list) {
    if (s.paraIndex <= paraIndex) found = s
    else break
  }
  return found
}

export function findSection(id: string): SectionRef | null {
  return sections().find((s) => s.id === id) ?? null
}

/**
 * Where a section ends: the paragraph before the next marker, or the last
 * paragraph. Used by delete (which absorbs the section into the previous one)
 * and by the active-tab highlight.
 */
export function sectionRange(id: string): { start: number; end: number } | null {
  const list = sections()
  const index = list.findIndex((s) => s.id === id)
  if (index === -1) return null
  const start = list[index].paraIndex
  const end = index + 1 < list.length ? list[index + 1].paraIndex - 1 : doc.paragraphs.length - 1
  return { start, end }
}

/** Write a marker onto a paragraph, creating the section. */
export function setSectionMark(paraIndex: number, mark: SectionMark | undefined): void {
  const attrs = doc.blockAttrs[paraIndex]
  if (!attrs) return
  if (mark) attrs.section = mark
  else delete attrs.section
}

// ---- change notification ----------------------------------------------
// The panel is a view of the section list, and the list changes both from tab
// operations and from ordinary typing (a section moves down the roll as the one
// above it grows). The layout signals it when the computed list actually
// differs, so the panel re-renders on a real change and not on every keystroke.

const listeners: Array<() => void> = []

export function subscribeSections(listener: () => void): void {
  listeners.push(listener)
}

export function notifySections(): void {
  for (const listener of listeners) listener()
}

/** A title that is not already taken, so the panel never shows two of the same. */
export function uniqueTitle(base: string): string {
  const taken = new Set(sections().map((s) => s.title))
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`
    if (!taken.has(candidate)) return candidate
  }
}
