import { jsPDF } from 'jspdf'
import { PAD_X, PAD_Y, PAGE_HEIGHT } from '../config'
import { convertImageToDataURL } from '../images/images'
import { measureTextWidthOnPara } from '../measure'
import { getStyleRunsInRange, styleFontSize } from '../model/runs'
import { view } from '../state/view'

export async function exportPDF() {
  const imgs = await Promise.all(
    view.images.map(async (im) => ({ ...im, dataUrl: await convertImageToDataURL(im.img) }))
  )
  const pageCount = Math.max(1, Math.ceil(view.docHeight / PAGE_HEIGHT))
  const pageW = Math.round(view.docWidth + PAD_X * 2)
  const pageH = Math.round(PAGE_HEIGHT + PAD_Y * 2)
  const pdf = new jsPDF({ unit: 'px', format: [pageW, pageH] })
  for (let pi = 0; pi < pageCount; pi++) {
    if (pi > 0) pdf.addPage([pageW, pageH], 'portrait')
    // background
    pdf.setFillColor(247, 245, 241)
    pdf.rect(0, 0, pageW, pageH, 'F')
    for (const line of view.lines) {
      if (line.yTop < pi * PAGE_HEIGHT || line.yTop >= (pi + 1) * PAGE_HEIGHT) continue
      // B6: advance runs with the same measurement the layout used, so runs do
      // not drift within the line even though jsPDF's Helvetica metrics differ
      // from the on-screen font (ARCHITECTURE.md §3.6, ROADMAP step 7).
      let xPos = PAD_X + line.x
      const globalStart = line.startOffset
      for (const style of getStyleRunsInRange(line.paraIndex, globalStart, line.endOffset)) {
        const segText = line.text.slice(style.start - globalStart, style.end - globalStart)
        let fontStyle = 'normal'
        if (style.bold && style.italic) fontStyle = 'bolditalic'
        else if (style.bold) fontStyle = 'bold'
        else if (style.italic) fontStyle = 'italic'
        try {
          pdf.setFont(undefined as any, fontStyle as any)
        } catch {}
        const fontSize = styleFontSize(style)
        pdf.setFontSize(fontSize)
        const baseline = fontSize * 0.92
        pdf.text(segText, xPos, PAD_Y + (line.yTop - pi * PAGE_HEIGHT) + baseline)
        const segW = measureTextWidthOnPara(line.paraIndex, segText, style.start)
        if (style.underline) {
          const uy = PAD_Y + (line.yTop - pi * PAGE_HEIGHT) + baseline + 2
          pdf.setDrawColor(42, 36, 32)
          pdf.setLineWidth(1)
          pdf.line(xPos, uy, xPos + segW, uy)
        }
        xPos += segW
      }
    }
    for (const im of imgs) {
      const imTop = im.y
      const imBottom = im.y + im.h
      if (imTop < (pi + 1) * PAGE_HEIGHT && imBottom > pi * PAGE_HEIGHT) {
        const yOnPage = PAD_Y + (im.y - pi * PAGE_HEIGHT)
        try {
          pdf.addImage(im.dataUrl, 'PNG', PAD_X + im.x, yOnPage, im.w, im.h)
        } catch {}
      }
    }
  }
  pdf.save('pretext.pdf')
}
