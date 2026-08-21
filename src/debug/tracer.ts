// Event tracer (docs/DIAGNOSTICS.md): a ring buffer of the last N things that
// happened, dumpable as JSON so a bug report carries evidence instead of a
// description.
//
// The rule that makes it worth having: it records what the editor *did*, not
// what someone thinks it did. Every entry is written at the moment the code
// runs, with the numbers it actually used — timings, offsets, paragraph counts —
// so a trace can be read back without re-deriving anything.
//
// A leaf module on purpose: it imports only state, so any layer can call trace()
// without creating an import cycle.

import { doc } from '../state/doc'
import { view } from '../state/view'

export type TraceKind =
  | 'edit'
  | 'layout'
  | 'draw'
  | 'key'
  | 'pointer'
  | 'section'
  | 'image'
  | 'io'
  | 'warn'
  | 'error'
  | 'mark'

export interface TraceEvent {
  /** Milliseconds since the page loaded, at 0.1 ms resolution. */
  t: number
  kind: TraceKind
  what: string
  data?: Record<string, unknown>
}

const CAPACITY = 800
const buffer: (TraceEvent | undefined)[] = new Array(CAPACITY)
let writeIndex = 0
let dropped = 0
let enabled = true

export function setTracing(on: boolean): void {
  enabled = on
}

export function trace(kind: TraceKind, what: string, data?: Record<string, unknown>): void {
  if (!enabled) return
  if (buffer[writeIndex] !== undefined) dropped++
  buffer[writeIndex] = { t: Math.round(performance.now() * 10) / 10, kind, what, data }
  writeIndex = (writeIndex + 1) % CAPACITY
}

/** The buffer in chronological order, oldest first. */
export function events(): TraceEvent[] {
  const out: TraceEvent[] = []
  for (let i = 0; i < CAPACITY; i++) {
    const entry = buffer[(writeIndex + i) % CAPACITY]
    if (entry) out.push(entry)
  }
  return out
}

export function clearTrace(): void {
  buffer.fill(undefined)
  writeIndex = 0
  dropped = 0
}

/**
 * A time-measuring wrapper for a hot path. Returns whatever the function
 * returns, and records the duration plus whatever the caller wants to attach.
 */
export function timed<T>(kind: TraceKind, what: string, fn: () => T, data?: () => Record<string, unknown>): T {
  if (!enabled) return fn()
  const start = performance.now()
  const result = fn()
  const ms = Math.round((performance.now() - start) * 100) / 100
  trace(kind, what, { ms, ...(data ? data() : {}) })
  return result
}

// ---- the dump ----------------------------------------------------------

/**
 * The state of the document at dump time, so the events can be read against
 * the thing they happened to. Text is included by default: a layout or offset
 * bug is usually not reproducible without it. Pass { text: false } for a
 * redacted dump that keeps only the shape.
 */
function documentSnapshot(includeText: boolean) {
  return {
    paragraphs: doc.paragraphs.length,
    totalChars: doc.paragraphs.reduce((n, p) => n + p.length, 0),
    paragraphLengths: doc.paragraphs.map((p) => p.length),
    text: includeText ? doc.paragraphs : undefined,
    styleTableSize: doc.styleTable.length,
    cursor: { ...doc.cursor },
    selection: doc.selection ? { anchor: { ...doc.selection.anchor }, focus: { ...doc.selection.focus } } : null,
    blockAttrs: doc.blockAttrs.map((a, i) => ({
      i,
      kind: a.kind,
      align: a.align,
      section: a.section ? { ...a.section } : undefined,
    })).filter((a) => a.kind !== 'paragraph' || a.align !== 'left' || a.section),
  }
}

function viewSnapshot() {
  return {
    docWidth: view.docWidth,
    docHeight: Math.round(view.docHeight),
    lines: view.lines.length,
    sections: view.sections.map((s) => ({ ...s })),
    images: view.images.map((im) => ({
      id: im.id,
      x: Math.round(im.x),
      y: Math.round(im.y),
      w: Math.round(im.w),
      h: Math.round(im.h),
      loaded: im.loaded,
      silhouette: !!im.alphaMap,
      silhouetteUnavailable: !!im.silhouetteUnavailable,
      srcKind: im.img.src.slice(0, 5),
    })),
  }
}

/**
 * The offset invariant of FIXPLAN.md §0, checked at dump time. A trace taken
 * while it is broken should say so out loud rather than leave it to be
 * rediscovered from the events.
 */
function invariantCheck() {
  const violations: Array<{ paraIndex: number; startOffset: number; endOffset: number; painted: string; expected: string }> = []
  for (const line of view.lines) {
    const source = doc.paragraphs[line.paraIndex]
    if (source === undefined) continue
    const expected = source.slice(line.startOffset, line.endOffset)
    if (expected !== line.text) {
      violations.push({
        paraIndex: line.paraIndex,
        startOffset: line.startOffset,
        endOffset: line.endOffset,
        painted: line.text.slice(0, 60),
        expected: expected.slice(0, 60),
      })
    }
  }
  return { offsetInvariantViolations: violations.length, examples: violations.slice(0, 5) }
}

export function dumpTrace(options: { text?: boolean } = {}): Record<string, unknown> {
  const includeText = options.text !== false
  return {
    format: 'pretext-trace/1',
    takenAt: new Date().toISOString(),
    uptimeMs: Math.round(performance.now()),
    textIncluded: includeText,
    environment: {
      userAgent: navigator.userAgent,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      memoryMB: (performance as any).memory
        ? Math.round((performance as any).memory.usedJSHeapSize / 1048576)
        : undefined,
    },
    document: documentSnapshot(includeText),
    view: viewSnapshot(),
    checks: invariantCheck(),
    events: { capacity: CAPACITY, dropped, list: events() },
  }
}

export function downloadTrace(options: { text?: boolean } = {}): void {
  const blob = new Blob([JSON.stringify(dumpTrace(options), null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `pretext-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  a.click()
  URL.revokeObjectURL(url)
}

// ---- automatic capture -------------------------------------------------

let installed = false

/**
 * Catch what nobody remembered to instrument: uncaught errors, rejected
 * promises, and every console.warn/error — which is where this codebase puts
 * its loud fallbacks (the offset-alignment fallback, the tainted-canvas
 * silhouette). Those are exactly the lines a bug report needs and the ones a
 * user never thinks to copy.
 */
export function installTracer(): void {
  if (installed) return
  installed = true

  window.addEventListener('error', (e) => {
    trace('error', e.message, { source: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack?.slice(0, 800) })
  })
  window.addEventListener('unhandledrejection', (e) => {
    const reason: any = e.reason
    trace('error', 'unhandled rejection: ' + (reason?.message ?? String(reason)), { stack: reason?.stack?.slice(0, 800) })
  })

  const realWarn = console.warn
  console.warn = (...args: unknown[]) => {
    trace('warn', String(args[0]).slice(0, 200), { args: args.slice(1).map(shorten) })
    realWarn(...args)
  }
  const realError = console.error
  console.error = (...args: unknown[]) => {
    trace('error', String(args[0]).slice(0, 200), { args: args.slice(1).map(shorten) })
    realError(...args)
  }

  // Reachable from the console for a quick look without downloading anything.
  ;(window as any).pretextTrace = dumpTrace
  ;(window as any).pretextTraceDownload = downloadTrace

  trace('mark', 'tracer installed')
}

function shorten(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, 200)
  if (value && typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'string' ? v.slice(0, 120) : v)))
    } catch {
      return String(value)
    }
  }
  return value
}
