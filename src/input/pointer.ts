import { PAD_X, PAD_Y } from '../config'
import { docWrap, ghostInput } from '../dom'
import { repositionGhostInput } from '../edit/caret'
import { resetCaretBlink } from '../render/caret'
import { addImageFromFile, deselectImage } from '../images/images'
import { pixelToCursor, resetStickyX } from '../layout/caret-position'
import { visualToDocY } from '../layout/pagination'
import { draw } from '../render/draw'
import { sectionTitleAt, startTitleRename } from '../render/title'
import {
  clearSelection,
  isCollapsed,
  moveCursorToSelectionFocus,
  setCursor,
  setSelection,
} from '../model/selection'
import { view } from '../state/view'

export function initPointer() {

  docWrap.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.img-handle')) return
    const rect = docWrap.getBoundingClientRect()
    const px = e.clientX - rect.left - PAD_X
    // B4: the document scrolls inside .doc-wrap, so client offsets become
    // document offsets only after adding the current scrollTop.
    const py = docWrap.scrollTop + (e.clientY - rect.top) - PAD_Y
    // A title band belongs to the tab, not to the text: clicking it renames the
    // tab in place instead of putting the caret in the paragraph below
    // (docs/TABS.md).
    const titleHit = sectionTitleAt(visualToDocY(py))
    if (titleHit) {
      deselectImage()
      startTitleRename(titleHit)
      return
    }
    deselectImage()
    resetStickyX()
    const c = pixelToCursor(px, py)
    setCursor(c)
    setSelection(c, c)
    view.selectingText = true
    // Position the ghost input BEFORE focusing it. Focusing an unpositioned textarea
    // makes the browser scroll it into view - on the first click that jumped the page
    // ~600px, and every drag coordinate after it was computed against the moved rect.
    repositionGhostInput()
    ghostInput.focus()
    resetCaretBlink()
    draw()
    const onMove = (ev: MouseEvent) => {
      if (!view.selectingText) return
      const r = docWrap.getBoundingClientRect()
      const mx = ev.clientX - r.left - PAD_X
      const my = docWrap.scrollTop + (ev.clientY - r.top) - PAD_Y
      setSelection(c, pixelToCursor(mx, my))
      draw()
    }
    const onUp = (ev: MouseEvent) => {
      ;view.selectingText = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (isCollapsed()) {
        clearSelection()
      } else {
        moveCursorToSelectionFocus()
      }
      repositionGhostInput()
      draw()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  })
  docWrap.addEventListener('dragover', (e) => {
    e.preventDefault()
    docWrap.classList.add('dropzone-active')
  })
  docWrap.addEventListener('dragleave', () => {
    docWrap.classList.remove('dropzone-active')
  })
  docWrap.addEventListener('drop', (e) => {
    e.preventDefault()
    docWrap.classList.remove('dropzone-active')
    const rect = docWrap.getBoundingClientRect()
    const dropX = e.clientX - rect.left - PAD_X
    const dropY = docWrap.scrollTop + (e.clientY - rect.top) - PAD_Y
    const files = e.dataTransfer?.files
    if (!files) return
    Array.from(files)
      .filter((f) => f.type.startsWith('image/'))
      .forEach((f, i) => addImageFromFile(f, dropX + i * 16, dropY + i * 16))
  })
}
