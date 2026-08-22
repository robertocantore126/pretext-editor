import { FONT, PAD_X, PAD_Y } from './config'

// The DOM scaffold, created once at module load and shared by every module.
//
// B4 layout (docs/PARALLEL-PLAN.md): .doc-wrap is the scroll container;
// .doc-viewport is a zero-height sticky wrapper that pins the viewport-sized
// canvas to the visible top; .doc-spacer carries the full document height and
// holds the floating images, ghost input and empty hint, which therefore
// scroll with the content.

export const app = document.getElementById('app')!

export const toolbar = document.createElement('div')
toolbar.className = 'toolbar'
toolbar.innerHTML = `
  <h1>Editor pretext</h1>
  <button id="btn-clear" type="button">Nuovo documento</button>
  <button id="btn-bold" type="button">Grassetto</button>
  <button id="btn-italic" type="button">Corsivo</button>
  <button id="btn-underline" type="button">Sottolineato</button>
  <button id="btn-headline" type="button">Titolo</button>
  <select id="sel-deco" title="Sottolineatura disegnata a mano"></select>
  <button id="btn-export" type="button">Esporta (HTML)</button>
  <button id="btn-export-json" type="button">Esporta JSON</button>
  <button id="btn-export-pdf" type="button">Esporta PDF</button>
  <button id="btn-import" type="button">Importa</button>
  <button id="btn-trace" type="button" title="Scarica un JSON con gli ultimi eventi, per capire un problema">Diagnostica</button>
`
app.appendChild(toolbar)

export const hint = document.createElement('div')
hint.className = 'hint'
hint.textContent = 'Clicca ed inizia a scrivere. Incolla un\u2019immagine con Ctrl/Cmd+V oppure trascinala qui dentro dal tuo computer.'
app.appendChild(hint)

export const docWrap = document.createElement('div')
docWrap.className = 'doc-wrap'
docWrap.tabIndex = 0
app.appendChild(docWrap)

export const docViewport = document.createElement('div')
docViewport.className = 'doc-viewport'
docWrap.appendChild(docViewport)

export const canvas = document.createElement('canvas')
canvas.className = 'doc-canvas'
docViewport.appendChild(canvas)

export const docSpacer = document.createElement('div')
docSpacer.className = 'doc-spacer'
docWrap.appendChild(docSpacer)

export const emptyHint = document.createElement('div')
emptyHint.className = 'empty-hint'
emptyHint.style.left = PAD_X + 'px'
emptyHint.style.top = PAD_Y + 'px'
emptyHint.style.font = FONT
emptyHint.textContent = ''
docSpacer.appendChild(emptyHint)

export const ghostInput = document.createElement('textarea')
ghostInput.className = 'caret-input'
ghostInput.setAttribute('autocapitalize', 'off')
ghostInput.setAttribute('autocomplete', 'off')
ghostInput.setAttribute('spellcheck', 'false')
docSpacer.appendChild(ghostInput)

docWrap.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.img-handle')) return
  // A title rename is in flight (docs/TABS.md §7): stealing focus here would
  // blur it and close the editor on the same click that opened it.
  if (document.querySelector('.doc-title-input')) return
  ghostInput.focus()
})

export const importInput = document.createElement('input')
importInput.type = 'file'
importInput.accept = '.json,application/json'
importInput.style.display = 'none'
docSpacer.appendChild(importInput)
export const ctx = canvas.getContext('2d')!
export const measureCanvas = document.createElement('canvas')
export const measureCtx = measureCanvas.getContext('2d')!
measureCtx.font = FONT
