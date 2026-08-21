// Entry point: wires the toolbar, installs the input handlers, and boots the
// first layout. See docs/ARCHITECTURE.md for how the modules fit together.
//
// FROZEN (docs/PARALLEL-PLAN.md §0.6). Neither agent edits this file: it only calls
// across owned contracts, and every init hook either track needs is already wired.
//
// Exception, on the record (docs/TABS.md §5): the two-agent phase is closed and the
// tab panel needs an init point, so it gets one import and one call below.

import { importInput } from './dom'
import { downloadTrace, installTracer } from './debug/tracer'
import { installStressHarness } from './debug/stress'
import { initTabsPanel } from './ui/tabs-panel'
import { initHistory } from './edit/history'
import { applySelectionMark, toggleHeadlineForPara } from './edit/marks'
import { clearImages, initImageInteractions } from './images/images'
import { initClipboard } from './input/clipboard'
import { initKeyboard } from './input/keyboard'
import { initPointer } from './input/pointer'
import { exportHTML } from './io/html'
import { exportDocument, initImportInput } from './io/json'
import { exportPDF } from './io/pdf'
import { initPersistence } from './io/persistence'
import { relayout } from './layout/engine'
import { resetDocument } from './model/document'
import { initVirtualScroll } from './render/viewport'

// --------------------------------------------------------------------------
// Toolbar
// --------------------------------------------------------------------------

document.getElementById('btn-clear')!.addEventListener('click', () => {
  if (!confirm('Cancellare il documento e tutte le immagini?')) return
  resetDocument()
  clearImages()
  relayout()
})

document.getElementById('btn-bold')!.addEventListener('click', () => applySelectionMark('bold'))
document.getElementById('btn-italic')!.addEventListener('click', () => applySelectionMark('italic'))
document.getElementById('btn-underline')!.addEventListener('click', () => applySelectionMark('underline'))
document.getElementById('btn-headline')!.addEventListener('click', () => toggleHeadlineForPara())

document.getElementById('btn-export')!.addEventListener('click', async () => {
  try {
    await exportHTML()
  } catch (error) {
    alert('Errore durante l’esportazione del documento.')
  }
})

document.getElementById('btn-export-json')!.addEventListener('click', async () => {
  try {
    await exportDocument()
  } catch (error) {
    alert('Errore durante l’esportazione JSON.')
  }
})

document.getElementById('btn-export-pdf')!.addEventListener('click', async () => {
  try {
    await exportPDF()
  } catch (error) {
    alert('Errore durante l’esportazione PDF.')
  }
})

document.getElementById('btn-import')!.addEventListener('click', () => {
  importInput.click()
})

document.getElementById('btn-trace')!.addEventListener('click', () => {
  downloadTrace()
})

// --------------------------------------------------------------------------
// Input + window events
// --------------------------------------------------------------------------

// First, so it catches errors thrown by everything below (docs/DIAGNOSTICS.md).
installTracer()
installStressHarness()

initImportInput()
initKeyboard()
initPointer()
initImageInteractions()

// Track A
initHistory()      // A2
initClipboard()    // A4
initPersistence()  // A5
// Track B
initVirtualScroll() // B4
initTabsPanel()     // docs/TABS.md

let resizeRaf: number | undefined
window.addEventListener('resize', () => {
  if (resizeRaf) cancelAnimationFrame(resizeRaf)
  resizeRaf = requestAnimationFrame(() => relayout())
})

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

relayout()
