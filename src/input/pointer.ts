import { docWrap, ghostInput } from '../dom'
import { repositionGhostInput } from '../edit/caret'
import { resetCaretBlink } from '../render/caret'
import { addImageFromFile, deselectImage } from '../images/images'
import { pixelToCursor, resetStickyX } from '../layout/caret-position'
import { pointerToDocument } from '../layout/coords'
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
    const { x: px, y: py } = pointerToDocument(e.clientX, e.clientY)
    // A title band belongs to the tab, not to the text: clicking it renames the
    // tab in place instead of putting the caret in the paragraph below
    // (docs/TABS.md).
    const titleHit = sectionTitleAt(py)
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
      const m = pointerToDocument(ev.clientX, ev.clientY)
      setSelection(c, pixelToCursor(m.x, m.y))
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
    // Images are stored in document Y. Dropping used to pass a visual Y, so the
    // image landed lower by the page gaps above the drop point — pages later,
    // deep in a long document.
    const { x: dropX, y: dropY } = pointerToDocument(e.clientX, e.clientY)
    const files = e.dataTransfer?.files
    if (!files) return
    Array.from(files)
      .filter((f) => f.type.startsWith('image/'))
      .forEach((f, i) => addImageFromFile(f, dropX + i * 16, dropY + i * 16))
  })
}
