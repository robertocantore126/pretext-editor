import { FONT, FONT_FAMILY, FONT_SIZE, PAD_X, PAD_Y, PAGE_GAP, PAGE_HEIGHT } from '../config'
import { convertImageToDataURL } from '../images/images'
import { getStyleRunsInRange } from '../model/runs'
import { view } from '../state/view'

export function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function exportHTML() {
  const imgs = await Promise.all(view.images.map(async (im) => ({ ...im, dataUrl: await convertImageToDataURL(im.img) })))
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
      let left = PAD_X + line.x
      // build inner HTML by runs
      let runs: string[] = []
      const globalStart = line.startOffset
      for (const style of getStyleRunsInRange(line.paraIndex, globalStart, line.endOffset)) {
        const segText = escapeHtml(line.text.slice(style.start - globalStart, style.end - globalStart))
        let segHtml = segText
        if (style.underline) segHtml = `<u>${segHtml}</u>`
        if (style.italic) segHtml = `<i>${segHtml}</i>`
        if (style.bold) segHtml = `<b>${segHtml}</b>`
        // B6: headline runs keep their larger size in the export.
        if (style.headline) segHtml = `<span style="font-size:${Math.round(FONT_SIZE * 1.6)}px">${segHtml}</span>`
        runs.push(segHtml)
      }
      pageInner += `<div class="line" style="left:${left}px;top:${top}px;font:${FONT};">${runs.join('')}</div>`
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
