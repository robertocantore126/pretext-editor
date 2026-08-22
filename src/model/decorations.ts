// Hand-drawn underlines (docs/DECORATIONS.md). Owned by Agent A — it is document
// data: a decoration id travels in the interned style table and must survive a
// save like any other attribute.
//
// A decoration is a **polyline in a unit cell**, not an SVG path. That is a
// deliberate limitation: canvas, the HTML export and the PDF export all have to
// draw the same mark, and a polyline is the one shape all three speak natively
// (lineTo, <polyline>, jsPDF's lines). An arbitrary path would need a parser
// here and a flattener in the PDF, and the two would drift.
//
// Coordinates: x runs 0..1 across the cell, y runs 0..1 *downward* from the top
// of the cell. The cell's own size in pixels is `cellWidth` / `height`, given at
// FONT_SIZE and scaled with the run's font, so a decoration under a heading is
// proportionally bigger instead of a thin thread.

export interface Decoration {
  id: string
  label: string
  /** Points of one cell, x and y both in 0..1. */
  points: Array<[number, number]>
  /** Cell width in px at the reference font size. */
  cellWidth: number
  /** Cell height in px at the reference font size. */
  height: number
  /** Distance from the baseline to the top of the cell, in px at the reference size. */
  offsetY: number
  /** Stroke width in px at the reference size. */
  thickness: number
  /**
   * `tile` repeats the cell at its natural width — a wave keeps its wavelength
   * whatever the word's length. `stretch` fits exactly one cell to the run,
   * which is what a single gesture (a swoosh with a start and an end) wants.
   */
  mode: 'tile' | 'stretch'
}

export const DECORATION_REFERENCE_SIZE = 17

/** A wave sampled into points, with the amplitude wandering so it reads as a hand. */
function wave(samples: number, waves: number, jitter: number[]): Array<[number, number]> {
  const points: Array<[number, number]> = []
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    const swing = Math.sin(t * Math.PI * 2 * waves)
    const wobble = jitter[i % jitter.length]
    points.push([t, 0.5 + swing * 0.42 * (1 + wobble)])
  }
  return points
}

const BUILT_INS: Decoration[] = [
  {
    id: 'squiggle',
    label: 'Ondulata',
    points: wave(18, 2, [0, 0.14, -0.08, 0.05, -0.16, 0.1]),
    cellWidth: 26,
    height: 6,
    offsetY: 3,
    thickness: 1.7,
    mode: 'tile',
  },
  {
    id: 'rough',
    label: 'Tratto a mano',
    // Nearly straight, but never twice at the same height: a ruler drawn by hand.
    points: [
      [0, 0.62], [0.12, 0.45], [0.26, 0.58], [0.4, 0.4], [0.55, 0.55],
      [0.7, 0.38], [0.84, 0.52], [1, 0.42],
    ],
    cellWidth: 42,
    height: 5,
    offsetY: 3,
    thickness: 2.1,
    mode: 'tile',
  },
  {
    id: 'zigzag',
    label: 'Zigzag',
    points: [[0, 0.9], [0.25, 0.1], [0.5, 0.9], [0.75, 0.1], [1, 0.9]],
    cellWidth: 14,
    height: 6,
    offsetY: 3,
    thickness: 1.6,
    mode: 'tile',
  },
  {
    id: 'swoosh',
    label: 'Svolazzo',
    // One gesture for the whole run: it starts thin on the left, dips, and
    // curls up past the end — so it stretches instead of repeating.
    points: [
      [0, 0.45], [0.08, 0.62], [0.2, 0.75], [0.35, 0.8], [0.5, 0.72],
      [0.65, 0.6], [0.78, 0.52], [0.88, 0.5], [0.95, 0.58], [0.99, 0.72], [1, 0.9],
    ],
    cellWidth: 120,
    height: 9,
    offsetY: 2,
    thickness: 2.2,
    mode: 'stretch',
  },
]

const registry = new Map<string, Decoration>(BUILT_INS.map((d) => [d.id, d]))

export function decorations(): Decoration[] {
  return [...registry.values()]
}

export function decoration(id: string | null | undefined): Decoration | null {
  if (!id) return null
  return registry.get(id) ?? null
}

/**
 * Add your own. Draw it anywhere, sample the stroke into points, normalise them
 * into the unit cell and hand it over. Registering an id a document already
 * uses replaces it everywhere at once, which is the point of keeping the shape
 * out of the style table and only the id in it.
 */
export function registerDecoration(def: Decoration): void {
  if (!def.id || !Array.isArray(def.points) || def.points.length < 2) {
    throw new Error('a decoration needs an id and at least two points')
  }
  registry.set(def.id, def)
}

/**
 * The polyline to draw for a run, in pixels relative to (runStart, baseline).
 * One place decides tiling, scaling and phase; canvas, HTML and PDF all call it
 * so the three cannot disagree about where the ink goes.
 */
export function decorationPolyline(
  def: Decoration,
  width: number,
  fontSize: number
): { points: Array<[number, number]>; thickness: number } {
  const scale = fontSize / DECORATION_REFERENCE_SIZE
  const cell = def.cellWidth * scale
  const height = def.height * scale
  const top = def.offsetY * scale
  const out: Array<[number, number]> = []

  if (def.mode === 'stretch' || width <= cell) {
    for (const [x, y] of def.points) out.push([x * width, top + y * height])
    return { points: out, thickness: def.thickness * scale }
  }

  // Tile a whole number of cells and spread the remainder across them, so the
  // wave ends exactly at the end of the word instead of being cut mid-swing.
  const count = Math.max(1, Math.round(width / cell))
  const step = width / count
  for (let c = 0; c < count; c++) {
    // The first point of a cell repeats the last of the previous one.
    for (let i = c === 0 ? 0 : 1; i < def.points.length; i++) {
      const [x, y] = def.points[i]
      out.push([c * step + x * step, top + y * height])
    }
  }
  return { points: out, thickness: def.thickness * scale }
}
