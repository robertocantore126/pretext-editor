import { PAGE_GAP, PAGE_HEIGHT } from '../config'

// Maps between continuous document Y and on-screen Y, which has a gap between pages.
// Deliberately dependency-free so it can be imported from anywhere without cycles.

export function docToVisualY(docY: number): number {
  return docY + Math.floor(docY / PAGE_HEIGHT) * PAGE_GAP
}

export function visualToDocY(visualY: number): number {
  const pageSize = PAGE_HEIGHT + PAGE_GAP
  const pageIndex = Math.floor(visualY / pageSize)
  const pageStart = pageIndex * pageSize
  const within = visualY - pageStart
  if (within > PAGE_HEIGHT) {
    return pageIndex * PAGE_HEIGHT
  }
  return pageIndex * PAGE_HEIGHT + within
}
