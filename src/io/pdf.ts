import { jsPDF } from 'jspdf'
import { PAD_X, PAD_Y, PAGE_HEIGHT } from '../config'
import { convertImageToDataURL } from '../images/images'
import { measureTextWidthOnPara } from '../measure'
import { getStyleRunsInRange, styleFontSize } from '../model/runs'
import { view } from '../state/view'

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
      const globalStart = line.startOffset
      const runs = Array.from(getStyleRunsInRange(line.paraIndex, globalStart, line.endOffset))
      const yBase = PAD_Y + (line.yTop - pi * PAGE_HEIGHT)
      // Justified lines (RICH-TEXT-MODEL.md §7): a single-run line is drawn with
      // jsPDF's built-in justify across the painted width. Multi-run justified
      // lines stay left-aligned so per-run re-justification cannot collide at
      // run boundaries. Center/right are already correct: line.x carries the
      // alignment shift from the layout.
      const jGap = line.justifyGap && line.justifyGap > 0 ? line.justifyGap : 0
      if (jGap > 0 && runs.length === 1) {
        const style = runs[0]
        const segText = line.text.slice(style.start - globalStart, style.end - globalStart)
        let fontStyle = 'normal'
        if (style.bold && style.italic) fontStyle = 'bolditalic'
        else if (style.bold) fontStyle = 'bold'
        else if (style.italic) fontStyle = 'italic'
        try {
          pdf.setFont(undefined as any, fontStyle as any)
        } catch {}
        pdf.setFontSize(styleFontSize(style))
        const paintedW = line.width + countInteriorGaps(line.text) * jGap
        const jx = PAD_X + line.x + (line.justifyOffset || 0)
        const baseline = styleFontSize(style) * 0.92
        pdf.text(segText, jx, yBase + baseline, { align: 'justify', maxWidth: paintedW })
        if (style.underline) {
          pdf.setDrawColor(42, 36, 32)
          pdf.setLineWidth(1)
          pdf.line(jx, yBase + baseline + 2, jx + paintedW, yBase + baseline + 2)
        }
        continue
      }
      // B6: advance runs with the same measurement the layout used, so runs do
      // not drift within the line even though jsPDF's Helvetica metrics differ
      // from the on-screen font (ARCHITECTURE.md §3.6, ROADMAP step 7).
      let xPos = PAD_X + line.x
      for (const style of runs) {
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
        pdf.text(segText, xPos, yBase + baseline)
        const segW = measureTextWidthOnPara(line.paraIndex, segText, style.start)
        if (style.underline) {
          const uy = yBase + baseline + 2
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
