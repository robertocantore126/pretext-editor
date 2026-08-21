// The tab panel (docs/TABS.md). Owned by Agent B — it is view code.
//
// The rows are bookmarks into one continuous document, not files: clicking one
// unrolls the page to that point, it does not load anything. The list is
// rendered from view.sections, which the layout recomputes on every pass, so
// what you see is always where the tabs actually are on the roll.

import { ghostInput } from '../dom'
import { addSection, activeSectionId, deleteSection, goToSection, renameSection } from '../edit/sections'
import { subscribeSections } from '../model/sections'
import { setTitleRenameCommit } from '../render/title'
import { view } from '../state/view'
import type { SectionLayout } from '../state/view'

const panel = document.createElement('aside')
panel.className = 'tabs-panel'

const header = document.createElement('div')
header.className = 'tabs-header'
header.textContent = 'Schede'
panel.appendChild(header)

const list = document.createElement('div')
list.className = 'tabs-list'
panel.appendChild(list)

const addRoot = document.createElement('button')
addRoot.type = 'button'
addRoot.className = 'tabs-add'
addRoot.textContent = '+ Nuova scheda'
addRoot.addEventListener('click', () => {
  const id = addSection(0)
  renamingId = id
  render()
})
panel.appendChild(addRoot)

/** Which row is being renamed, so a re-render keeps the editor open. */
let renamingId: string | null = null

function iconButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'tab-action'
  button.textContent = label
  button.title = title
  button.addEventListener('click', (e) => {
    // Without this the row underneath would also scroll the document.
    e.stopPropagation()
    onClick()
  })
  return button
}

function renderRow(section: SectionLayout, active: boolean): HTMLElement {
  const row = document.createElement('div')
  row.className = 'tab-row' + (active ? ' is-active' : '') + (section.level === 1 ? ' is-child' : '')
  row.addEventListener('click', () => {
    goToSection(section.id)
    ghostInput.focus()
  })

  const label = document.createElement('span')
  label.className = 'tab-title'
  // User text: textContent, never innerHTML.
  label.textContent = section.title
  label.title = section.title + ' — doppio clic per rinominare'
  label.addEventListener('dblclick', (e) => {
    e.stopPropagation()
    renamingId = section.id
    render()
  })
  row.appendChild(label)

  const actions = document.createElement('div')
  actions.className = 'tab-actions'
  if (section.level === 0) {
    actions.appendChild(
      iconButton('+', 'Aggiungi sottoscheda', () => {
        const id = addSection(1)
        renamingId = id
        render()
      })
    )
  }
  actions.appendChild(
    iconButton('×', 'Elimina scheda e il suo contenuto', () => {
      if (!confirm(`Eliminare “${section.title}” e il testo che contiene? Puoi annullare con Ctrl+Z.`)) return
      if (!deleteSection(section.id)) alert('Non puoi eliminare l’unica scheda del documento.')
    })
  )
  row.appendChild(actions)
  return row
}

function renderRenameRow(section: SectionLayout): HTMLElement {
  const row = document.createElement('div')
  row.className = 'tab-row is-renaming' + (section.level === 1 ? ' is-child' : '')
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'tab-rename'
  input.value = section.title
  const commit = (save: boolean) => {
    if (renamingId !== section.id) return
    renamingId = null
    if (save) renameSection(section.id, input.value)
    else render()
    ghostInput.focus()
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true)
    else if (e.key === 'Escape') commit(false)
    e.stopPropagation()
  })
  input.addEventListener('blur', () => commit(true))
  row.appendChild(input)
  // Focus after the row is in the document, or the caret has nowhere to land.
  queueMicrotask(() => {
    input.focus()
    input.select()
  })
  return row
}

function render(): void {
  const active = activeSectionId()
  list.textContent = ''
  for (const section of view.sections) {
    list.appendChild(section.id === renamingId ? renderRenameRow(section) : renderRow(section, section.id === active))
  }
}

export function initTabsPanel(): void {
  document.body.classList.add('has-tabs')
  document.body.appendChild(panel)
  // Renaming from the title on the page goes through the same model call as
  // renaming from this list; render/ cannot import edit/ without a cycle.
  setTitleRenameCommit((id, title) => renameSection(id, title))
  subscribeSections(render)
  render()
}
