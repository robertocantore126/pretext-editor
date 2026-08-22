import { FONT, FONT_FAMILY, INK, PAD_X, PAD_Y, PAGE_GAP, PAGE_HEIGHT } from '../config'
import { convertImageToDataURL } from '../images/images'
import { decoration, decorationPolyline } from '../model/decorations'
import { getStyleRunsInRange, styleFontSize } from '../model/runs'
import { measureTextWidthOnPara } from '../measure'
import { titleFont, TITLE_SPACE_ABOVE } from '../render/title'
import { materializeAll } from '../layout/engine'
import { view } from '../state/view'

export function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Mirrors layout/paragraph.ts: inter-word gaps are whitespace runs followed by
 * a non-space character. Used to compute a justified line's painted width.
 */
function countInteriorGaps(text: string): number {
  let count = 0
  let inWs = false
  for (let i = 0; i < text.length; i++) {
    if (/[ \t\n\f\r]/.test(text[i])) inWs = true
    else if (inWs) {
      count++
      inWs = false
    }
  }
  return count
}

export async function exportHTML() {
  // An export is the whole document by definition: materialize every paragraph
  // first — view.lines normally holds only the viewport band (docs/LAZY-LAYOUT.md
  // §4), and exporting the window would silently truncate the file.
  materializeAll()
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
  const pageW = Math.round(view.docWidth + PAD_X * 2)
  const css = `
  body{margin:0;padding:20px;background:#f0e6ff;font-family: ${FONT_FAMILY}}
  .doc{width:${pageW}px;margin:0 auto}
  .page{position:relative;width:${pageW}px;height:${PAGE_HEIGHT + PAD_Y * 2}px;background:#f7f5f1;border:1px solid #d3d0c8;margin-bottom:${PAGE_GAP}px;box-sizing:border-box;}
  .line{position:absolute;white-space:pre}
  .doc-title{position:absolute;white-space:pre;color:${INK}}
  .deco{position:absolute;overflow:visible;pointer-events:none}
  .img{position:absolute}
  `

  let bodyHtml = ''
  for (let pi = 0; pi < pageCount; pi++) {
    const pageTop = pi * PAGE_HEIGHT
    let pageInner = ''
    // lines
    for (const line of view.lines) {
      if (line.yTop < pageTop || line.yTop >= pageTop + PAGE_HEIGHT) continue
      const top = PAD_Y + (line.yTop - pageTop)
      const left = PAD_X + line.x + (line.justifyOffset || 0)
      // build inner HTML by runs
      let runs: string[] = []
      // Decorations are drawn beside the text, not inside it: an SVG positioned
      // over the line, one per decorated run, using the same polyline the canvas
      // and the PDF use.
      const decos: string[] = []
      const globalStart = line.startOffset
      for (const style of getStyleRunsInRange(line.paraIndex, globalStart, line.endOffset)) {
        const raw = line.text.slice(style.start - globalStart, style.end - globalStart)
        const custom = style.underline ? decoration(style.decoration) : null
        if (custom) {
          const runX = measureTextWidthOnPara(line.paraIndex, line.text.slice(0, style.start - globalStart), globalStart)
          const runW = measureTextWidthOnPara(line.paraIndex, raw, style.start)
          const size = styleFontSize(style)
          const { points, thickness } = decorationPolyline(custom, runW, size)
          const d = points.map(([px, py]) => `${px.toFixed(2)},${py.toFixed(2)}`).join(' ')
          const maxY = Math.max(...points.map((p) => p[1])) + thickness
          decos.push(
            `<svg class="deco" width="${runW.toFixed(2)}" height="${maxY.toFixed(2)}" ` +
            `style="left:${(left + runX).toFixed(2)}px;top:${(top + size * 0.92).toFixed(2)}px">` +
            `<polyline points="${d}" fill="none" stroke="${style.color}" stroke-width="${thickness.toFixed(2)}" ` +
            `stroke-linejoin="round" stroke-linecap="round"/></svg>`
          )
        }
        const segText = escapeHtml(raw)
        let segHtml = segText
        if (style.strike) segHtml = `<s>${segHtml}</s>`
        if (style.underline) segHtml = `<u>${segHtml}</u>`
        if (style.italic) segHtml = `<i>${segHtml}</i>`
        if (style.bold) segHtml = `<b>${segHtml}</b>`
        // Rich styles: colour/background are paint-only, so they survive as CSS.
        const inline: string[] = []
        if (style.color && style.color !== INK) inline.push(`color:${style.color}`)
        if (style.background) inline.push(`background:${style.background}`)
        if (style.letterSpacing) inline.push(`letter-spacing:${style.letterSpacing}px`)
        if (style.headline) inline.push(`font-size:${Math.round(style.fontSize * 1.6)}px`)
        if (inline.length > 0) segHtml = `<span style="${inline.join(';')}">${segHtml}</span>`
        runs.push(segHtml)
      }
      // Justified lines (RICH-TEXT-MODEL.md §7): the layout spread the words by
      // justifyGap; here the div is given the painted width and text-align:justify
      // lets the browser do the same spreading over the same width.
      let lineStyle = `left:${left}px;top:${top}px;font:${FONT};`
      if (line.justifyGap && line.justifyGap > 0) {
        const paintedW = line.width + countInteriorGaps(line.text) * line.justifyGap
        lineStyle += `width:${paintedW.toFixed(2)}px;text-align:justify;white-space:normal;`
      }
      pageInner += `<div class="line" style="${lineStyle}">${runs.join('')}</div>` + decos.join('')
    }
    // Each tab heads the page it opens, exactly as on screen (docs/TABS.md).
    for (const s of view.sections) {
      if (!s.title || s.y < pageTop || s.y >= pageTop + PAGE_HEIGHT) continue
      const top = PAD_Y + (s.y - pageTop) + TITLE_SPACE_ABOVE
      pageInner += `<div class="doc-title" style="left:${PAD_X}px;top:${top}px;font:${titleFont(s.level)};">${escapeHtml(s.title)}</div>`
    }
    // images on page
    for (const im of imgs) {
      const imTop = im.y
      const imBottom = im.y + im.h
      if (imTop < pageTop + PAGE_HEIGHT && imBottom > pageTop) {
        const yOnPage = PAD_Y + (im.y - pageTop)
        const xOnPage = PAD_X + im.x
        pageInner += `<img class="img" src="${im.dataUrl}" style="left:${xOnPage}px;top:${yOnPage}px;width:${im.w}px;height:${im.h}px;"/>`
      }
    }
    bodyHtml += `<div class="page">${pageInner}</div>`
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div class="doc">${bodyHtml}</div></body></html>`
  const blob = new Blob([html], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'pretext-export.html'
  a.click()
  URL.revokeObjectURL(url)
}
