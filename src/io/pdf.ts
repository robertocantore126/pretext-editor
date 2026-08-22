import { jsPDF } from 'jspdf'
import { FONT, FONT_FAMILY, FONT_SIZE, INK, LINE_HEIGHT, PAD_X, PAGE_HEIGHT } from '../config'
import { measureCtx } from '../dom'
import { convertImageToDataURL } from '../images/images'
import { decoration, decorationPolyline } from '../model/decorations'
import { fontForStyle, getStyleRunsInRange, styleFontSize } from '../model/runs'
import { doc } from '../state/doc'
import { titleFont, titleFontSize, TITLE_SPACE_ABOVE } from '../render/title'
import { view } from '../state/view'

// The PDF is a *transcription of the paint*, not a second layout pass.
//
// Everything on screen is positioned by the layout in CSS pixels: `view.lines`
// is a list of fragments, each already carrying the absolute x its words start
// at (layout/paragraph.ts measured them with the run's own font). So this file
// never re-measures and never re-justifies — it walks the same fragments as
// render/draw.ts, in the same order, with the same measurement (`measureCtx`,
// the very canvas the layout used), and only changes the ink's destination.
// A width invented here instead of taken from the layout drifts as soon as the
// PDF's glyphs are not the screen's: too narrow leaves a gap after every word,
// too wide swallows the space — and the comma — before the next run.

/**
 * CSS px -> PDF point (1 px = 1/96 in, 1 pt = 1/72 in).
 *
 * The document is a jsPDF in *points*, and every length crossing this boundary
 * is multiplied by PT. jsPDF's `unit: 'px'` cannot be used: it scales
 * coordinates by 96/72 but emits font sizes raw, so a 17 px run was drawn at 17
 * pt inside a space where 1 px was 1.333 pt — every glyph 25 % too small in its
 * own slot — and the sheet came out 12.9 x 19.6 inches, which no printer prints
 * at 1:1.
 */
const PT = 72 / 96

// Fonts.
//
// "The document font" is not one font. A pasted article keeps the source page's
// stack on every run (`InlineStyle.fontFamily`, taken from the computed style),
// the layout measured each run with it, and the fragment x positions encode
// those widths — so each run has to resolve its own stack to an embedded family
// here, or it misses the slot the layout gave it.
//
// All of these carry OS/2 fsType 8 (editable embedding), which permits putting
// them in a document. Georgia stops at Latin Extended-A and has no ṇ ṃ ṣ ṛ —
// the Romanized Sanskrit of a Buddhism article — so it falls back per codepoint
// to Liberation Serif (SIL OFL 1.1); the sans and mono faces cover those
// themselves. Everything is registered Identity-H, so codepoints map straight
// through, and only the families a document actually uses are fetched.
import georgiaRegularUrl from './fonts/Georgia-Regular.ttf'
import georgiaBoldUrl from './fonts/Georgia-Bold.ttf'
import georgiaItalicUrl from './fonts/Georgia-Italic.ttf'
import georgiaBoldItalicUrl from './fonts/Georgia-BoldItalic.ttf'
import liberationRegularUrl from './fonts/LiberationSerif-Regular.ttf'
import liberationBoldUrl from './fonts/LiberationSerif-Bold.ttf'
import liberationItalicUrl from './fonts/LiberationSerif-Italic.ttf'
import liberationBoldItalicUrl from './fonts/LiberationSerif-BoldItalic.ttf'
import arialRegularUrl from './fonts/Arial-Regular.ttf'
import arialBoldUrl from './fonts/Arial-Bold.ttf'
import arialItalicUrl from './fonts/Arial-Italic.ttf'
import arialBoldItalicUrl from './fonts/Arial-BoldItalic.ttf'
import segoeRegularUrl from './fonts/SegoeUI-Regular.ttf'
import segoeBoldUrl from './fonts/SegoeUI-Bold.ttf'
import segoeItalicUrl from './fonts/SegoeUI-Italic.ttf'
import segoeBoldItalicUrl from './fonts/SegoeUI-BoldItalic.ttf'
import courierRegularUrl from './fonts/CourierNew-Regular.ttf'
import courierBoldUrl from './fonts/CourierNew-Bold.ttf'
import courierItalicUrl from './fonts/CourierNew-Italic.ttf'
import courierBoldItalicUrl from './fonts/CourierNew-BoldItalic.ttf'

type Variant = 'normal' | 'bold' | 'italic' | 'bolditalic'
/** `unicode` is never chosen by a run: it only catches what Georgia cannot draw. */
type FamilyKey = 'serif' | 'sans' | 'ui' | 'mono' | 'unicode'

interface FamilySpec {
  /** The name this family is registered under inside the PDF. */
  pdfName: string
  files: Record<Variant, { file: string; url: string }>
  /** Where a codepoint this family has no glyph for is drawn instead. */
  fallback?: FamilyKey
}

const file = (name: string, url: string) => ({ file: name, url })

const FAMILIES: Record<FamilyKey, FamilySpec> = {
  serif: {
    pdfName: 'Serif',
    fallback: 'unicode',
    files: {
      normal: file('Georgia-Regular.ttf', georgiaRegularUrl),
      bold: file('Georgia-Bold.ttf', georgiaBoldUrl),
      italic: file('Georgia-Italic.ttf', georgiaItalicUrl),
      bolditalic: file('Georgia-BoldItalic.ttf', georgiaBoldItalicUrl),
    },
  },
  sans: {
    pdfName: 'Sans',
    files: {
      normal: file('Arial-Regular.ttf', arialRegularUrl),
      bold: file('Arial-Bold.ttf', arialBoldUrl),
      italic: file('Arial-Italic.ttf', arialItalicUrl),
      bolditalic: file('Arial-BoldItalic.ttf', arialBoldItalicUrl),
    },
  },
  ui: {
    pdfName: 'SansUI',
    files: {
      normal: file('SegoeUI-Regular.ttf', segoeRegularUrl),
      bold: file('SegoeUI-Bold.ttf', segoeBoldUrl),
      italic: file('SegoeUI-Italic.ttf', segoeItalicUrl),
      bolditalic: file('SegoeUI-BoldItalic.ttf', segoeBoldItalicUrl),
    },
  },
  mono: {
    pdfName: 'Mono',
    files: {
      normal: file('CourierNew-Regular.ttf', courierRegularUrl),
      bold: file('CourierNew-Bold.ttf', courierBoldUrl),
      italic: file('CourierNew-Italic.ttf', courierItalicUrl),
      bolditalic: file('CourierNew-BoldItalic.ttf', courierBoldItalicUrl),
    },
  },
  unicode: {
    pdfName: 'Unicode',
    files: {
      normal: file('LiberationSerif-Regular.ttf', liberationRegularUrl),
      bold: file('LiberationSerif-Bold.ttf', liberationBoldUrl),
      italic: file('LiberationSerif-Italic.ttf', liberationItalicUrl),
      bolditalic: file('LiberationSerif-BoldItalic.ttf', liberationBoldItalicUrl),
    },
  },
}

/**
 * A CSS font stack -> the embedded family standing in for it. The first name
 * that is recognised wins, the same way the browser takes the first name it
 * has installed, so `"Segoe UI", Arial, sans-serif` and `"Georgia", serif` land
 * where the screen put them. An unknown stack falls to the editor's own default.
 */
const FAMILY_NAMES: Array<[RegExp, FamilyKey]> = [
  [/^(georgia|times|times new roman|palatino|palatino linotype|iowan old style|garamond|book antiqua|cambria|constantia|liberation serif|serif|ui-serif)$/, 'serif'],
  [/^(segoe ui|segoe ui variable|system-ui|-apple-system|blinkmacsystemfont|ui-sans-serif|calibri)$/, 'ui'],
  [/^(arial|helvetica|helvetica neue|liberation sans|roboto|lato|open sans|noto sans|tahoma|verdana|nimbus sans|sans-serif)$/, 'sans'],
  [/^(courier|courier new|consolas|menlo|monaco|monospace|ui-monospace|liberation mono|dejavu sans mono|sfmono-regular)$/, 'mono'],
]

function familyKeyFor(stack: string): FamilyKey {
  for (const raw of stack.split(',')) {
    const name = raw.trim().replace(/^["']|["']$/g, '').toLowerCase()
    for (const [re, key] of FAMILY_NAMES) if (re.test(name)) return key
  }
  return 'serif'
}

/**
 * The codepoints a TrueType file has a glyph for, from its `cmap`.
 *
 * Needed because jsPDF draws a missing codepoint as .notdef — a blank or a box,
 * silently. Formats 4 (BMP) and 12 (full range) cover every font shipped here.
 */
function cmapCodepoints(buf: ArrayBuffer): Set<number> {
  const view = new DataView(buf)
  const has = new Set<number>()
  const numTables = view.getUint16(4)
  let cmapOff = 0
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    const tag = String.fromCharCode(
      view.getUint8(rec), view.getUint8(rec + 1), view.getUint8(rec + 2), view.getUint8(rec + 3)
    )
    if (tag === 'cmap') cmapOff = view.getUint32(rec + 8)
  }
  if (!cmapOff) return has
  let best = 0
  let bestFormat = 0
  const n = view.getUint16(cmapOff + 2)
  for (let i = 0; i < n; i++) {
    const rec = cmapOff + 4 + i * 8
    const platform = view.getUint16(rec)
    const encoding = view.getUint16(rec + 2)
    const sub = cmapOff + view.getUint32(rec + 4)
    const format = view.getUint16(sub)
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))
    if (!unicode) continue
    // Format 12 wins: it is the one that carries anything above the BMP.
    if (format === 12 || (format === 4 && bestFormat !== 12)) {
      best = sub
      bestFormat = format
    }
  }
  if (!best) return has
  if (bestFormat === 4) {
    const segX2 = view.getUint16(best + 6)
    const endO = best + 14
    const startO = endO + segX2 + 2
    for (let s = 0; s < segX2 / 2; s++) {
      const end = view.getUint16(endO + s * 2)
      const start = view.getUint16(startO + s * 2)
      if (start === 0xffff) continue
      for (let c = start; c <= end && c !== 0xffff; c++) has.add(c)
    }
  } else {
    const groups = view.getUint32(best + 12)
    for (let g = 0; g < groups; g++) {
      const o = best + 16 + g * 12
      const start = view.getUint32(o)
      const end = view.getUint32(o + 4)
      for (let c = start; c <= end; c++) has.add(c)
    }
  }
  return has
}

/** Fetch a font once: base64 for jsPDF's VFS, plus what it can actually draw. */
async function loadFont(url: string): Promise<{ base64: string; codepoints: Set<number> }> {
  const res = await fetch(url)
  const raw = await res.arrayBuffer()
  const bytes = new Uint8Array(raw)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return { base64: btoa(bin), codepoints: cmapCodepoints(raw) }
}

/**
 * Register the families this document needs, and report what each can draw —
 * the intersection over its four weights, so a character is only claimed when
 * bold and italic have it too. Loading all of them would move a dozen megabytes
 * of TTF for a document that uses one.
 */
async function registerFonts(pdf: jsPDF, keys: Set<FamilyKey>): Promise<Map<FamilyKey, Set<number>>> {
  for (const key of [...keys]) {
    const fb = FAMILIES[key].fallback
    if (fb) keys.add(fb)
  }
  const coverage = new Map<FamilyKey, Set<number>>()
  await Promise.all(
    [...keys].map(async (key) => {
      const spec = FAMILIES[key]
      const variants = Object.keys(spec.files) as Variant[]
      const loaded = await Promise.all(variants.map((v) => loadFont(spec.files[v].url)))
      let covered: Set<number> | null = null
      variants.forEach((v, i) => {
        pdf.addFileToVFS(spec.files[v].file, loaded[i].base64)
        pdf.addFont(spec.files[v].file, spec.pdfName, v, undefined, 'Identity-H')
        if (covered === null) covered = loaded[i].codepoints
        else for (const c of covered) if (!loaded[i].codepoints.has(c)) covered.delete(c)
      })
      coverage.set(key, covered ?? new Set<number>())
    })
  )
  return coverage
}

/** Every family the document asks for, including the editor's own default. */
function familiesUsed(): Set<FamilyKey> {
  const keys = new Set<FamilyKey>([familyKeyFor(FONT_FAMILY)])
  for (const entry of doc.styleTable) if (entry?.fontFamily) keys.add(familyKeyFor(entry.fontFamily))
  return keys
}

/**
 * Any CSS colour -> [r, g, b]. The canvas normalises `red`, `rgb(…)`, `#abc`
 * and the rest to `#rrggbb` (or `rgba(…)`) on read-back, so the exporter
 * accepts exactly the colours the painter accepts.
 */
function toRGB(css: string): [number, number, number] {
  measureCtx.fillStyle = '#000000'
  measureCtx.fillStyle = css
  const v = String(measureCtx.fillStyle)
  if (v.startsWith('#')) {
    return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)]
  }
  const m = v.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const [r, g, b] = m[1].split(',').map((x) => parseFloat(x))
    return [r | 0, g | 0, b | 0]
  }
  return [0, 0, 0]
}

function variantOf(style: { bold: boolean; italic: boolean }): Variant {
  if (style.bold && style.italic) return 'bolditalic'
  if (style.bold) return 'bold'
  if (style.italic) return 'italic'
  return 'normal'
}

/** Which program page a document Y falls on. */
function pageOf(docY: number): number {
  return Math.floor(docY / PAGE_HEIGHT)
}

export async function exportPDF() {
  // BUGHUNT C1: unserializable images are skipped, not fatal.
  const imgs = (await Promise.all(
    view.images.map(async (im) => {
      if (!im.loaded) return null
      const dataUrl = await convertImageToDataURL(im.img)
      if (dataUrl === null) return null
      return { ...im, dataUrl }
    })
  )).filter((e): e is NonNullable<typeof e> => e !== null)

  const pageCount = Math.max(1, Math.ceil(view.docHeight / PAGE_HEIGHT))
  // The sheet is exactly one program page: content is 0-based vertically and
  // PAD_X-inset horizontally, so a page and what fits on it coincide with the
  // editor and an image is only ever cut by a real page boundary.
  const pageW = view.docWidth + PAD_X * 2
  const pageH = PAGE_HEIGHT
  const pdf = new jsPDF({ unit: 'pt', format: [pageW * PT, pageH * PT] })
  const coverage = await registerFonts(pdf, familiesUsed())

  // One bucket per page instead of rescanning every fragment for every page:
  // fragments are per word, so a long document has tens of thousands of them.
  const linesByPage: (typeof view.lines)[] = Array.from({ length: pageCount }, () => [])
  for (const line of view.lines) {
    const p = pageOf(line.yTop)
    if (p >= 0 && p < pageCount) linesByPage[p].push(line)
  }
  const titlesByPage: (typeof view.sections)[] = Array.from({ length: pageCount }, () => [])
  for (const s of view.sections) {
    if (!s.title) continue
    const p = pageOf(s.y)
    if (p >= 0 && p < pageCount) titlesByPage[p].push(s)
  }

  /** Split text where the chosen family runs out of glyphs. One entry when it does not. */
  const splitByCoverage = (text: string, key: FamilyKey): Array<{ text: string; key: FamilyKey }> => {
    const has = coverage.get(key)
    const fb = FAMILIES[key].fallback
    const out: Array<{ text: string; key: FamilyKey }> = []
    for (const ch of text) {
      const usable = !fb || !has || has.has(ch.codePointAt(0)!) ? key : fb
      const last = out[out.length - 1]
      if (last && last.key === usable) last.text += ch
      else out.push({ text: ch, key: usable })
    }
    return out
  }

  /** What the embedded face will actually paint, in CSS px. */
  const inkWidth = (text: string, key: FamilyKey, variant: Variant, fontSize: number) => {
    pdf.setFont(FAMILIES[key].pdfName, variant)
    pdf.setFontSize(fontSize * PT)
    return pdf.getTextWidth(text) / PT
  }

  /**
   * Paint one span so that it occupies exactly `slot` — the width the layout
   * measured for it and positioned everything after it by.
   *
   * The correction is spread over the characters as `charSpace`. When the
   * embedded face is the one the layout measured it is ~0 and nothing moves;
   * when it cannot be (a run naming a font not embedded here), the text still
   * starts and ends where the editor put it instead of overrunning the next run
   * or leaving a hole. `letterSpacing` needs no separate handling: the layout
   * already counted it into `slot`.
   */
  const paintText = (
    text: string,
    xPx: number,
    baselineYPx: number,
    key: FamilyKey,
    variant: Variant,
    fontSize: number,
    slot: number
  ) => {
    if (!text) return
    const spans = splitByCoverage(text, key)
    let ink = 0
    for (const span of spans) ink += inkWidth(span.text, span.key, variant, fontSize)
    const glyphs = [...text].length
    const charSpace = glyphs > 0 ? (slot - ink) / glyphs : 0
    const opts = charSpace ? ({ charSpace: charSpace * PT } as any) : undefined
    let cx = xPx
    for (const span of spans) {
      const w = inkWidth(span.text, span.key, variant, fontSize)
      pdf.text(span.text, cx * PT, baselineYPx * PT, opts)
      cx += w + charSpace * [...span.text].length
    }
  }
  /**
   * A hand-drawn underline (model/decorations.ts), transcribed. The polyline
   * comes from the same function the canvas uses, so the PDF cannot draw a
   * different squiggle than the screen — only in points instead of pixels.
   */
  const drawDecoration = (
    _pdf: typeof pdf,
    def: NonNullable<ReturnType<typeof decoration>>,
    xStart: number,
    baselineYPx: number,
    width: number,
    fontSize: number,
    css: string
  ) => {
    const { points, thickness } = decorationPolyline(def, width, fontSize)
    if (points.length < 2) return
    const [r, g, b] = toRGB(css)
    pdf.setDrawColor(r, g, b)
    pdf.setLineWidth(thickness * PT)
    pdf.setLineJoin('round')
    pdf.setLineCap('round')
    // jsPDF's lines() takes deltas from a starting point.
    const deltas = points.slice(1).map(([px, py], i) => [(px - points[i][0]) * PT, (py - points[i][1]) * PT])
    pdf.lines(deltas, (xStart + points[0][0]) * PT, (baselineYPx + points[0][1]) * PT)
    pdf.setLineWidth(1 * PT)
  }
  const rule = (x0: number, x1: number, y: number, css: string) => {
    const [r, g, b] = toRGB(css)
    pdf.setDrawColor(r, g, b)
    pdf.setLineWidth(1 * PT)
    pdf.line(x0 * PT, y * PT, x1 * PT, y * PT)
  }

  for (let pi = 0; pi < pageCount; pi++) {
    if (pi > 0) pdf.addPage([pageW * PT, pageH * PT], 'portrait')
    // The sheet, in the editor's paper colour.
    pdf.setFillColor(247, 245, 241)
    pdf.rect(0, 0, pageW * PT, pageH * PT, 'F')

    // Each tab heads the page it opens (docs/TABS.md).
    for (const s of titlesByPage[pi]) {
      const size = titleFontSize(s.level)
      measureCtx.font = titleFont(s.level)
      pdf.setTextColor(...toRGB(INK))
      const y = s.y - pi * PAGE_HEIGHT + TITLE_SPACE_ABOVE + size * 0.92
      paintText(s.title, PAD_X, y, familyKeyFor(FONT_FAMILY), 'bold', size, measureCtx.measureText(s.title).width)
    }

    for (const line of linesByPage[pi]) {
      if (!line.text) continue
      const lineTopY = line.yTop - pi * PAGE_HEIGHT
      const lineHeight = line.height || LINE_HEIGHT
      const globalStart = line.startOffset

      // List markers live in the indent gutter of the first line (RICH-TEXT-MODEL.md §4.2).
      const bAttrs = doc.blockAttrs[line.paraIndex]
      if (line.startOffset === 0 && bAttrs?.kind === 'listItem' && bAttrs.list?.marker) {
        const marker = bAttrs.list.marker
        measureCtx.font = FONT
        const markerW = measureCtx.measureText(marker).width
        pdf.setTextColor(...toRGB(INK))
        const y = lineTopY + lineHeight * 0.76
        paintText(marker, PAD_X + line.x - markerW - 10, y, familyKeyFor(FONT_FAMILY), 'normal', FONT_SIZE, markerW)
      }

      // Justified lines (RICH-TEXT-MODEL.md §7): pretext broke the line and
      // layoutParagraph distributed the slack as justifyGap/justifyOffset, so
      // the words are painted one segment at a time with each inter-word gap
      // widened — exactly as render/draw.ts does it.
      let xPos = PAD_X + line.x + (line.justifyOffset || 0)
      for (const style of getStyleRunsInRange(line.paraIndex, globalStart, line.endOffset)) {
        const segText = line.text.slice(style.start - globalStart, style.end - globalStart)
        const fontSize = styleFontSize(style)
        // The measurement is the layout's own: same canvas, same font string.
        measureCtx.font = fontForStyle(style)
        const key = familyKeyFor(style.fontFamily)
        const variant = variantOf(style)
        const [tr, tg, tb] = toRGB(style.color)
        const ls = style.letterSpacing || 0
        const runStart = xPos
        const baselineShift =
          style.baseline === 'super' ? -fontSize * 0.28 : style.baseline === 'sub' ? fontSize * 0.18 : 0
        const baselineY = lineTopY + fontSize * 0.92 + baselineShift
        const paintBackground = (x: number, w: number) => {
          if (!style.background) return
          const [br, bg, bb] = toRGB(style.background)
          pdf.setFillColor(br, bg, bb)
          pdf.rect(x * PT, (lineTopY + 2) * PT, w * PT, (lineHeight - 5) * PT, 'F')
        }

        if (line.justifyGap && line.justifyGap > 0) {
          const parts = segText.split(/([ \t\n\f\r]+)/).filter((p) => p !== '')
          for (let k = 0; k < parts.length; k++) {
            const part = parts[k]
            // Letter spacing is per character; the very last char of the run has
            // none, matching the layout's measurement (BUGHUNT M3).
            const pw =
              measureCtx.measureText(part).width + (part.length - (k === parts.length - 1 ? 1 : 0)) * ls
            paintBackground(xPos, pw)
            pdf.setTextColor(tr, tg, tb)
            paintText(part, xPos, baselineY, key, variant, fontSize, pw)
            xPos += pw
            if (k + 1 < parts.length && /^[ \t\n\f\r]+$/.test(part)) xPos += line.justifyGap
          }
        } else {
          // BUGHUNT M3: canvas measureText ignores letter-spacing; the layout
          // (and pretext) widens every char except the last by it.
          const w = measureCtx.measureText(segText).width + (segText.length - 1) * ls
          paintBackground(xPos, w)
          pdf.setTextColor(tr, tg, tb)
          paintText(segText, xPos, baselineY, key, variant, fontSize, w)
          xPos += w
        }

        const runEnd = xPos
        if (style.underline) {
          const custom = decoration(style.decoration)
          if (custom) drawDecoration(pdf, custom, runStart, baselineY, runEnd - runStart, styleFontSize(style), style.color)
          else rule(runStart, runEnd, baselineY + 2, style.color)
        }
        if (style.strike) rule(runStart, runEnd, baselineY - fontSize * 0.42, style.color)
      }
    }

    // Images last: on screen they are DOM elements above the canvas. A picture
    // crossing a boundary is drawn on both pages at a y the sheet clips, which
    // splits it exactly where the page does.
    for (const im of imgs) {
      if (im.y < (pi + 1) * PAGE_HEIGHT && im.y + im.h > pi * PAGE_HEIGHT) {
        const yOnPage = im.y - pi * PAGE_HEIGHT
        try {
          pdf.addImage(im.dataUrl, (PAD_X + im.x) * PT, yOnPage * PT, im.w * PT, im.h * PT)
        } catch {}
      }
    }
  }
  pdf.save('pretext.pdf')
}
