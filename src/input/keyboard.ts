import { ghostInput } from '../dom'
import { trace } from '../debug/tracer'
import { repositionGhostInput } from '../edit/caret'
import { resetCaretBlink, stopCaretBlink } from '../render/caret'
import { undo, redo } from '../edit/history'
import {
  backspaceAtCursor,
  deleteForwardAtCursor,
  insertTextAtCursor,
  moveLeft,
  moveRight,
  moveVertical,
  splitParagraphAtCursor,
} from '../edit/ops'
import { applySelectionMark } from '../edit/marks'
import { getComposition, isComposing, setComposition } from '../model/composition'
import { addImageFromFile, deleteImage, deselectImage } from '../images/images'
import { draw } from '../render/draw'
import { doc } from '../state/doc'
import { view } from '../state/view'

// A3 - IME composition. While a composition is in flight the browser owns the
// ghost input's value (the preedit); we suppress the 'input' path and only
// commit through applyEdit at compositionend. suppressNextInput swallows the
// trailing 'input' event the browser fires after compositionend, which would
// otherwise double-insert the committed text.
let suppressNextInput = false

export function initKeyboard() {
  ghostInput.addEventListener('focus', () => {
    view.focused = true
    resetCaretBlink()
    draw()
  })
  ghostInput.addEventListener('blur', () => {
    view.focused = false
    stopCaretBlink()
    draw()
  })

  ghostInput.addEventListener('compositionstart', () => {
    suppressNextInput = false
    setComposition({ para: doc.cursor.para, offset: doc.cursor.offset, text: '' })
  })
  ghostInput.addEventListener('compositionupdate', (e) => {
    const c = getComposition()
    if (c) setComposition({ para: c.para, offset: c.offset, text: (e as CompositionEvent).data ?? '' })
  })
  ghostInput.addEventListener('compositionend', (e) => {
    setComposition(null)
    const data = (e as CompositionEvent).data ?? ghostInput.value
    suppressNextInput = true
    if (data) insertTextAtCursor(data)
    ghostInput.value = ''
    repositionGhostInput()
  })

  ghostInput.addEventListener('input', () => {
    if (isComposing() || suppressNextInput) {
      ghostInput.value = ''
      suppressNextInput = false
      return
    }
    const val = ghostInput.value
    ghostInput.value = ''
    if (val) insertTextAtCursor(val)
    repositionGhostInput()
  })

  ghostInput.addEventListener('keydown', (e) => {
    // The key's name only, never the character typed: the trace records which
    // command ran, and the text is in the dump only if the reporter chose to
    // include it (docs/DIAGNOSTICS.md).
    if (e.key.length > 1 || e.ctrlKey || e.metaKey) {
      trace('key', e.key, {
        ctrl: e.ctrlKey || undefined,
        shift: e.shiftKey || undefined,
        composing: isComposing() || undefined,
        cursor: { ...doc.cursor },
      })
    }
    if (view.selectedImageId && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault()
      deleteImage(view.selectedImageId)
      return
    }
    // Editing keys must not fire while an IME composition is in flight - the
    // Enter/arrows/backspace belong to the IME until it commits.
    if (isComposing()) return

    // Formatting shortcuts. Same entry point as the toolbar buttons, so one
    // Ctrl+Z undoes a keyboard bold exactly like a clicked one.
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const mark = ({ b: 'bold', i: 'italic', u: 'underline' } as const)[e.key.toLowerCase()]
      if (mark) {
        // The browser has its own bold/italic/underline on a focused textarea;
        // without this it would fight us for the keystroke.
        e.preventDefault()
        applySelectionMark(mark)
        repositionGhostInput()
        return
      }
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
      repositionGhostInput()
      return
    }

    switch (e.key) {
      case 'Enter':
        e.preventDefault()
        splitParagraphAtCursor()
        repositionGhostInput()
        break
      case 'Backspace':
        e.preventDefault()
        backspaceAtCursor()
        repositionGhostInput()
        break
      case 'Delete':
        e.preventDefault()
        deleteForwardAtCursor()
        repositionGhostInput()
        break
      case 'ArrowLeft':
        e.preventDefault()
        moveLeft()
        break
      case 'ArrowRight':
        e.preventDefault()
        moveRight()
        break
      case 'ArrowUp':
        e.preventDefault()
        moveVertical(-1)
        break
      case 'ArrowDown':
        e.preventDefault()
        moveVertical(1)
        break
      default:
        break
    }
  })

  ghostInput.addEventListener('paste', (e: ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) addImageFromFile(file)
        return
      }
    }
    // otherwise text paste is handled by input/clipboard.ts (A4), which
    // preventDefaults before the default insertion can fire 'input'.
  })
  // selecting an image blurs the hidden text input on purpose (so typing doesn't
  // land in the document while an image is selected), so Backspace/Delete for a
  // selected image needs its own document-level listener rather than relying on
  // ghostInput's keydown handler.
  document.addEventListener('keydown', (e) => {
    if (view.selectedImageId && document.activeElement !== ghostInput) {
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        deleteImage(view.selectedImageId)
      } else if (e.key === 'Escape') {
        deselectImage()
        draw()
      }
    }
  })
}
