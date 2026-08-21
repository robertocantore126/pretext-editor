// Stress harness (docs/DIAGNOSTICS.md): build a document far bigger than anyone
// would type by hand, then measure the things that get slow first.
//
// Two rules it follows, both learned the hard way in this codebase:
//
// 1. It writes through the real door. The text goes in through applyEdit, the
//    images through addImageFromDataURL, the tabs through the section marker —
//    seeding `doc.paragraphs` directly would skip exactly the code a stress test
//    exists to stress, and would pass while the real path drowned.
// 2. The generated data varies where it counts. Uniform paragraphs of identical
//    length measure nothing: they hit one cache line, one break decision, one
//    obstruction pattern. Lengths, styles, alignment, image placement and
//    silhouettes all vary, because that is what a real document does.

import { addImageFromDataURL, clearImages } from '../images/images'
import { relayout } from '../layout/engine'
import { applyEdit, resetDocument } from '../model/document'
import { markAllDirty } from '../model/dirty'
import { newSectionId, setSectionMark } from '../model/sections'
import { applySelectionMark } from '../model/styles'
import { draw } from '../render/draw'
import { doc } from '../state/doc'
import { view } from '../state/view'
import { docWrap } from '../dom'
import { PAD_X, PAD_Y } from '../config'
import { pointerToDocument } from '../layout/coords'
import { pixelToCursor } from '../layout/caret-position'
import { docToVisualY } from '../layout/pagination'
import { trace } from './tracer'

/** Deterministic PRNG, so two runs of the same size are comparable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = (
  'nel mezzo del cammin di nostra vita mi ritrovai per una selva oscura che la diritta via era ' +
  'smarrita ahi quanto a dir qual era e cosa dura esta selva selvaggia e aspra e forte che nel ' +
  'pensier rinova la paura tant e amara che poco e piu morte ma per trattar del ben ch i vi ' +
  'trovai diro de l altre cose ch i v ho scorte io non so ben ridir com i v intrai tant era pien ' +
  'di sonno a quel punto che la verace via abbandonai'
).split(' ')

function paragraph(rand: () => number, words: number): string {
  const out: string[] = []
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(rand() * WORDS.length)])
  const text = out.join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1) + '.'
}

/** A small PNG with transparency, so the silhouette wrap has something to chew on. */
function makeImageDataURL(kind: number): string {
  const size = 120
  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const g = cv.getContext('2d')!
  g.clearRect(0, 0, size, size)
  g.fillStyle = ['#7c3aed', '#d64545', '#2a7f62', '#c98a1b'][kind % 4]
  if (kind % 3 === 0) {
    g.beginPath()
    g.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2)
    g.fill()
  } else if (kind % 3 === 1) {
    // A triangle: the row spans change down the shape, unlike a circle's.
    g.beginPath()
    g.moveTo(size / 2, 2)
    g.lineTo(size - 2, size - 2)
    g.lineTo(2, size - 2)
    g.closePath()
    g.fill()
  } else {
    g.fillRect(6, 6, size - 12, size - 12)
  }
  return cv.toDataURL('image/png')
}

export interface StressOptions {
  /** Roughly how many printed pages of text. A page is ~3500 characters. */
  pages?: number
  images?: number
  /** How many tabs to fold the roll into. */
  sections?: number
  seed?: number
}

export interface StressReport {
  built: {
    paragraphs: number
    characters: number
    images: number
    sections: number
    buildMs: number
    firstLayoutMs: number
    pagesRendered: number
  }
  layout: { fullRelayoutMs: number[]; medianMs: number }
  typing: { where: string; medianMs: number; samples: number[] }[]
  /** Enter and merging Backspace: the edits that change the paragraph count. */
  structural: { where: string; medianMs: number; samples: number[] }[]
  paint: { scrollTop: number; drawMs: number }[]
  navigation: { toSectionMs: number[] }
  checks: {
    offsetInvariantViolations: number
    sectionsNotOnPageBoundary: string[]
    linesSpillingAcrossSections: number
    overlappingParagraphs: number
    hitTestMisses: number
  }
  memoryMB?: number
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? Math.round(s[s.length >> 1] * 100) / 100 : 0
}

export async function generateStressDocument(options: StressOptions = {}): Promise<StressReport['built']> {
  const pages = options.pages ?? 200
  const imageCount = options.images ?? 40
  const sectionCount = options.sections ?? 8
  const rand = mulberry32(options.seed ?? 1)
  const start = performance.now()

  resetDocument()
  clearImages()

  // Vary the paragraph lengths: a page of identical paragraphs exercises one
  // break decision over and over.
  const targetChars = pages * 3500
  const paragraphs: string[] = []
  let chars = 0
  while (chars < targetChars) {
    const words = 8 + Math.floor(rand() * rand() * 120)
    const p = paragraph(rand, words)
    paragraphs.push(p)
    chars += p.length + 1
  }

  // One insert through the real chokepoint, not an assignment to doc.paragraphs.
  applyEdit(0, 0, 0, paragraphs.join('\n'))

  // Alignment and styles on a scattered minority, the way a real document has
  // them: justify exercises the paint-time spread, bold changes run boundaries.
  for (let i = 0; i < doc.paragraphs.length; i++) {
    if (i % 7 === 3) doc.blockAttrs[i].align = 'justify'
    if (i % 11 === 5) doc.blockAttrs[i].align = 'center'
  }
  const styleTargets = Math.min(200, Math.floor(doc.paragraphs.length / 4))
  for (let k = 0; k < styleTargets; k++) {
    const p = Math.floor(rand() * doc.paragraphs.length)
    const len = doc.paragraphs[p].length
    if (len < 20) continue
    const s = Math.floor(rand() * (len - 12))
    doc.selection = { anchor: { para: p, offset: s }, focus: { para: p, offset: Math.min(len, s + 10) } }
    doc.cursor = { para: p, offset: s }
    applySelectionMark(k % 3 === 0 ? 'bold' : k % 3 === 1 ? 'italic' : 'underline')
  }
  doc.selection = null
  doc.cursor = { para: 0, offset: 0 }

  // Tabs: fold the roll at even intervals.
  const step = Math.max(1, Math.floor(doc.paragraphs.length / (sectionCount + 1)))
  for (let s = 1; s <= sectionCount; s++) {
    const index = Math.min(doc.paragraphs.length - 1, s * step)
    setSectionMark(index, { id: newSectionId(), title: `Capitolo ${s}`, level: s % 4 === 0 ? 1 : 0 })
  }

  markAllDirty()
  const layoutStart = performance.now()
  relayout()
  const firstLayoutMs = Math.round((performance.now() - layoutStart) * 100) / 100

  // Images spread down the whole roll, some near the margins so the wrap has to
  // work on both sides, all through the real entry point.
  for (let i = 0; i < imageCount; i++) {
    const y = Math.max(0, (view.docHeight * (i + 0.5)) / imageCount)
    const w = 90 + Math.floor(rand() * 120)
    const x = Math.floor(rand() * Math.max(1, view.docWidth - w))
    addImageFromDataURL(makeImageDataURL(i), x, Math.round(y), w, w)
  }
  // Wait for the decodes: an image that has not loaded obstructs nothing, and
  // benchmarking before they land measures the wrong document.
  const deadline = performance.now() + 20000
  while (performance.now() < deadline && view.images.some((im) => !im.loaded)) {
    await new Promise((r) => setTimeout(r, 50))
  }
  markAllDirty()
  relayout()

  const built = {
    paragraphs: doc.paragraphs.length,
    characters: doc.paragraphs.reduce((n, p) => n + p.length, 0),
    images: view.images.length,
    sections: view.sections.length,
    buildMs: Math.round((performance.now() - start) * 100) / 100,
    firstLayoutMs,
    pagesRendered: Math.max(1, Math.ceil(view.docHeight / 1060)),
  }
  trace('mark', 'stress document generated', built as unknown as Record<string, unknown>)
  return built
}

export async function runStressBenchmark(): Promise<StressReport> {
  const built = {
    paragraphs: doc.paragraphs.length,
    characters: doc.paragraphs.reduce((n, p) => n + p.length, 0),
    images: view.images.length,
    sections: view.sections.length,
    buildMs: 0,
    firstLayoutMs: 0,
    pagesRendered: Math.max(1, Math.ceil(view.docHeight / 1060)),
  }

  // Full relayout, three times: the first pays for cold caches.
  const full: number[] = []
  for (let i = 0; i < 3; i++) {
    markAllDirty()
    const t = performance.now()
    relayout()
    full.push(Math.round((performance.now() - t) * 100) / 100)
  }

  // Typing at the top, the middle and the end. The interesting number is the
  // top of a long document: everything below it may have to move.
  const spots: { where: string; para: number }[] = [
    { where: 'inizio', para: 0 },
    { where: 'metà', para: Math.floor(doc.paragraphs.length / 2) },
    { where: 'fine', para: doc.paragraphs.length - 1 },
  ]
  const typing = spots.map(({ where, para }) => {
    const samples: number[] = []
    for (let i = 0; i < 10; i++) {
      const offset = Math.min(doc.paragraphs[para].length, 5)
      const t = performance.now()
      applyEdit(para, offset, 0, 'x')
      relayout()
      samples.push(Math.round((performance.now() - t) * 100) / 100)
    }
    // Put the paragraph back.
    applyEdit(para, Math.min(doc.paragraphs[para].length, 5), 10, '')
    relayout()
    return { where, medianMs: median(samples), samples }
  })

  // Structural edits: Enter and a merging Backspace. These change the paragraph
  // *count*, which used to invalidate the whole document — the benchmark only
  // typed characters, so it reported 1.2 ms while pressing Enter cost 500 ms in
  // a real document. Measure the thing the user actually feels.
  const structural = spots.map(({ where, para }) => {
    const samples: number[] = []
    for (let i = 0; i < 6; i++) {
      const at = Math.min(doc.paragraphs[para].length, 5)
      const t0 = performance.now()
      applyEdit(para, at, 0, '\n')
      relayout()
      samples.push(Math.round((performance.now() - t0) * 100) / 100)
      // Undo it by merging back, and time that too: it is the same class of edit.
      const t1 = performance.now()
      applyEdit(para, at, 1, '')
      relayout()
      samples.push(Math.round((performance.now() - t1) * 100) / 100)
    }
    return { where, medianMs: median(samples), samples }
  })

  // Painting at three scroll positions: the canvas is viewport-sized, so this
  // must not grow with the document.
  const paint = [0, Math.floor(view.docHeight / 2), Math.max(0, view.docHeight - 800)].map((scrollTop) => {
    docWrap.scrollTop = scrollTop
    const t = performance.now()
    draw()
    return { scrollTop, drawMs: Math.round((performance.now() - t) * 100) / 100 }
  })

  // Jumping between tabs.
  const navigation: number[] = []
  for (const s of view.sections) {
    const t = performance.now()
    docWrap.scrollTop = s.y
    draw()
    navigation.push(Math.round((performance.now() - t) * 100) / 100)
  }
  docWrap.scrollTop = 0
  draw()

  // Correctness under load, not just speed: a stress run that gets fast answers
  // wrong is worse than a slow one.
  let violations = 0
  for (const line of view.lines) {
    const source = doc.paragraphs[line.paraIndex]
    if (source !== undefined && source.slice(line.startOffset, line.endOffset) !== line.text) violations++
  }
  const notOnBoundary: string[] = []
  let spill = 0
  for (let i = 1; i < view.sections.length; i++) {
    const s = view.sections[i]
    if (s.y % 1060 !== 0) notOnBoundary.push(s.title)
    spill += view.lines.filter((l) => l.paraIndex < s.paraIndex && l.yTop >= s.y).length
  }

  const report: StressReport = {
    built,
    layout: { fullRelayoutMs: full, medianMs: median(full) },
    typing,
    structural,
    paint,
    navigation: { toSectionMs: navigation },
    checks: {
      offsetInvariantViolations: violations,
      sectionsNotOnPageBoundary: notOnBoundary,
      linesSpillingAcrossSections: spill,
      overlappingParagraphs: overlappingParagraphs().length,
      hitTestMisses: checkHitTesting().length,
    },
    memoryMB: (performance as any).memory
      ? Math.round((performance as any).memory.usedJSHeapSize / 1048576)
      : undefined,
  }
  trace('mark', 'stress benchmark', report as unknown as Record<string, unknown>)
  return report
}

/** Generate, then measure. The one call a report should contain. */
export async function runStress(options: StressOptions = {}): Promise<StressReport> {
  const built = await generateStressDocument(options)
  const report = await runStressBenchmark()
  report.built = built
  return report
}


/**
 * Random editing, checked after every step. This is the guard for the
 * index-keyed caches: splits and merges re-key paraCache, runCache and the
 * paragraph versions, and a re-keying bug shows up as a paragraph rendering
 * another one's lines — which no timing ever catches. After each edit every
 * emitted line must still be a verbatim slice of the paragraph it claims.
 */

/**
 * Paragraphs must stack down the page: the top of paragraph i+1 is never above
 * the bottom of paragraph i. The offset check catches a paragraph painting the
 * *text* of another; this catches it painting in the *place* of another, which
 * is what a stale cached position looks like on screen — two paragraphs on top
 * of each other. Different failure, same class, and no timing sees either.
 */
export function overlappingParagraphs(): Array<{ paraIndex: number; top: number; previousBottom: number }> {
  const bands = new Map<number, { min: number; max: number }>()
  for (const line of view.lines) {
    const band = bands.get(line.paraIndex)
    const bottom = line.yTop + (line.height || 0)
    if (!band) bands.set(line.paraIndex, { min: line.yTop, max: bottom })
    else {
      band.min = Math.min(band.min, line.yTop)
      band.max = Math.max(band.max, bottom)
    }
  }
  const indices = [...bands.keys()].sort((a, b) => a - b)
  const out: Array<{ paraIndex: number; top: number; previousBottom: number }> = []
  for (let i = 1; i < indices.length; i++) {
    const previous = bands.get(indices[i - 1])!
    const current = bands.get(indices[i])!
    if (current.min < previous.max - 0.5) {
      out.push({ paraIndex: indices[i], top: current.min, previousBottom: previous.max })
    }
  }
  return out
}


/**
 * Click where a line is painted and the caret must land in that line. Sampled
 * down the whole document, and in the gaps between paragraphs as well as on the
 * text, because document Y and visual Y agree at the top of the document and
 * drift by PAGE_GAP per page below it: a unit mix-up is invisible on page one
 * and teleports you pages away on page fifty. Goes through the same conversion
 * the mouse does (layout/coords.ts), so it tests the real path.
 */
export function checkHitTesting(samples = 40): Array<{ paraIndex: number; got: number; y: number; where: string }> {
  const rect = docWrap.getBoundingClientRect()
  const misses: Array<{ paraIndex: number; got: number; y: number; where: string }> = []
  const lines = view.lines
  if (lines.length === 0) return misses
  const step = Math.max(1, Math.floor(lines.length / samples))
  for (let i = 0; i < lines.length; i += step) {
    const line = lines[i]
    const height = line.height || 27
    const probes: Array<{ y: number; where: string }> = [
      { y: line.yTop + height / 2, where: 'on the line' },
      { y: line.yTop + height + 3, where: 'in the gap below' },
    ]
    for (const probe of probes) {
      const clientY = rect.top + PAD_Y + docToVisualY(probe.y) - docWrap.scrollTop
      const clientX = rect.left + PAD_X + Math.min(20, line.width)
      const point = pointerToDocument(clientX, clientY)
      const got = pixelToCursor(point.x, point.y)
      // One paragraph either way is a legitimate answer in a gap; more than that
      // means the coordinate itself was wrong.
      if (Math.abs(got.para - line.paraIndex) > 1) {
        misses.push({ paraIndex: line.paraIndex, got: got.para, y: Math.round(probe.y), where: probe.where })
      }
    }
  }
  return misses
}

const NEWLINE = String.fromCharCode(10)

export function runEditFuzz(steps = 300, seed = 3): { steps: number; failures: unknown[]; ms: number } {
  const rand = mulberry32(seed)
  const failures: unknown[] = []
  const start = performance.now()
  for (let step = 0; step < steps && failures.length < 5; step++) {
    const para = Math.floor(rand() * doc.paragraphs.length)
    const len = doc.paragraphs[para].length
    const offset = Math.floor(rand() * (len + 1))
    const roll = rand()
    if (roll < 0.3) applyEdit(para, offset, 0, NEWLINE)                       // split
    else if (roll < 0.55 && para + 1 < doc.paragraphs.length) applyEdit(para, len, 1, '')  // merge
    else if (roll < 0.75) applyEdit(para, offset, 0, 'xyz')                 // type
    else if (roll < 0.9) applyEdit(para, offset, Math.min(40, len - offset), '')  // delete a run
    else applyEdit(para, offset, Math.min(80, len - offset), 'uno' + NEWLINE + 'due')    // replace across a split
    relayout()
    // Twice: a stale cached position only shows on the *second* pass, when the
    // entry is reused verbatim at a y it no longer agrees with.
    relayout()
    const overlaps = overlappingParagraphs()
    if (overlaps.length > 0) failures.push({ step, kind: 'overlap', ...overlaps[0], count: overlaps.length })
    for (const line of view.lines) {
      const source = doc.paragraphs[line.paraIndex]
      if (source === undefined || source.slice(line.startOffset, line.endOffset) !== line.text) {
        failures.push({
          step,
          paraIndex: line.paraIndex,
          startOffset: line.startOffset,
          endOffset: line.endOffset,
          painted: line.text.slice(0, 50),
          expected: (source ?? '(missing paragraph)').slice(line.startOffset, line.endOffset).slice(0, 50),
        })
        break
      }
    }
  }
  const result = { steps, failures, ms: Math.round(performance.now() - start) }
  trace('mark', 'edit fuzz', result as unknown as Record<string, unknown>)
  return result
}

export function installStressHarness(): void {
  ;(window as any).pretextStress = { generate: generateStressDocument, benchmark: runStressBenchmark, run: runStress, fuzz: runEditFuzz }
}
