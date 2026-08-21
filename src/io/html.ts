import { FONT, FONT_FAMILY, INK, PAD_X, PAD_Y, PAGE_GAP, PAGE_HEIGHT } from '../config'
import { convertImageToDataURL } from '../images/images'
import { getStyleRunsInRange } from '../model/runs'
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
      const globalStart = line.startOffset
      for (const style of getStyleRunsInRange(line.paraIndex, globalStart, line.endOffset)) {
        const segText = escapeHtml(line.text.slice(style.start - globalStart, style.end - globalStart))
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
      pageInner += `<div class="line" style="${lineStyle}">${runs.join('')}</div>`
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
