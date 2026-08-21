// A5 - Debounced IndexedDB autosave + recovery on load.
// Owned by Agent A (docs/PARALLEL-PLAN.md).
//
// Subscribes to the model's edit hook (model/document.ts), so main.ts (frozen)
// never changes. The saved payload is the v2 rich format (interned style table +
// per-char ids + block attrs, RICH-TEXT-MODEL.md §4.1); legacy byte-array
// autosaves are migrated on restore. Images are serialized as data URLs through
// the same path io/json.ts already uses (view.images + convertImageToDataURL);
// a handoff row in docs/PARALLEL-PLAN.md asks B for serializeImages/restoreImages
// + Blob storage to replace that.

import { repositionGhostInput } from '../edit/caret'
import { initHistory } from '../edit/history'
import { markAllDirty } from '../model/dirty'
import { reinternTable, styleIdsFromBytes } from '../model/styles'
import { subscribeChanged, subscribeReset } from '../model/document'
import { relayout } from '../layout/engine'
import { addImageFromDataURL, clearImages, convertImageToDataURL } from '../images/images'
import { ghostInput } from '../dom'
import { defaultBlockAttrs, doc } from '../state/doc'
import { view } from '../state/view'

const DB_NAME = 'pretext-editor'
const STORE = 'doc'
const KEY = 'autosave'
const SAVE_DEBOUNCE_MS = 800

let dbPromise: Promise<IDBDatabase> | null = null
let saveTimer: number | undefined
// Set once the user edits or resets this session; suppresses the recovery prompt
// if the IndexedDB read resolves after the user has already started working.
let touchedThisSession = false

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const req = action(tx.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
        tx.onerror = () => reject(tx.error)
      })
  )
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = window.setTimeout(saveNow, SAVE_DEBOUNCE_MS)
}

async function saveNow(): Promise<void> {
  saveTimer = undefined
  try {
    // One image must never veto the whole autosave (BUGHUNT C1): unloaded or
    // unserializable (tainted cross-origin) images are skipped, not fatal.
    const images = (await Promise.all(
      view.images.map(async (im) => {
        if (!im.loaded) return null
        const dataUrl = await convertImageToDataURL(im.img)
        if (dataUrl === null) return null
        return {
          x: im.x,
          y: im.y,
          w: im.w,
          h: im.h,
          type: im.img.src.startsWith('data:') ? im.img.src.split(';')[0].slice(5) : 'image/png',
          dataUrl,
        }
      })
    )).filter((e): e is NonNullable<typeof e> => e !== null)
    const payload = {
      version: 2,
      paragraphs: doc.paragraphs.slice(),
      styleTable: doc.styleTable,
      styleIds: doc.styleIds.map((s) => Array.from(s)),
      blockAttrs: doc.blockAttrs.map((a) => ({ ...a })),
      cursor: { para: doc.cursor.para, offset: doc.cursor.offset },
      selection: doc.selection
        ? {
            anchor: { para: doc.selection.anchor.para, offset: doc.selection.anchor.offset },
            focus: { para: doc.selection.focus.para, offset: doc.selection.focus.offset },
          }
        : null,
      images,
    }
    await withStore('readwrite', (store) => store.put(payload, KEY))
  } catch {
    // Autosave must never crash the editor; IndexedDB may be unavailable.
  }
}

function clearSaved(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = undefined
  withStore('readwrite', (store) => store.delete(KEY)).catch(() => {})
}

function applySaved(saved: any): void {
  doc.paragraphs = saved.paragraphs.map((p: unknown) => String(p))
  if (saved.version === 2 && Array.isArray(saved.styleIds) && Array.isArray(saved.styleTable)) {
    // Re-intern the serialized table so indices and the key map stay in sync.
    const remap = reinternTable(saved.styleTable)
    doc.styleIds = saved.styleIds.map((arr: any) =>
      Uint16Array.from(arr.map((old: number) => remap[old] ?? 0))
    )
  } else if (Array.isArray(saved.styles)) {
    // Legacy byte-array autosave: convert the old bits onto the table.
    doc.styleIds = doc.paragraphs.map((_, i) => {
      const arr = Array.isArray(saved.styles[i]) ? saved.styles[i] : undefined
      if (arr && arr.length === doc.paragraphs[i].length) return styleIdsFromBytes(Uint8Array.from(arr))
      return new Uint16Array(doc.paragraphs[i].length)
    })
  } else {
    doc.styleIds = doc.paragraphs.map((t) => new Uint16Array(t.length))
  }
  doc.blockAttrs = Array.isArray(saved.blockAttrs)
    ? doc.paragraphs.map((_, i) => ({ ...defaultBlockAttrs(), ...(saved.blockAttrs[i] ?? {}) }))
    : doc.paragraphs.map(() => defaultBlockAttrs())
  doc.cursor =
    saved.cursor && typeof saved.cursor.para === 'number' && typeof saved.cursor.offset === 'number'
      ? { para: saved.cursor.para, offset: saved.cursor.offset }
      : { para: 0, offset: 0 }
  doc.selection =
    saved.selection && saved.selection.anchor && saved.selection.focus
      ? { anchor: saved.selection.anchor, focus: saved.selection.focus }
      : null
  clearImages()
  for (const im of saved.images ?? []) {
    if (!im || typeof im.dataUrl !== 'string') continue
    addImageFromDataURL(im.dataUrl, im.x ?? 0, im.y ?? 0, im.w ?? 160, im.h ?? 160)
  }
  // The restored document has no undo history.
  initHistory()
  markAllDirty()
  relayout()
  repositionGhostInput()
}

function showRecoveryPrompt(saved: any): void {
  const overlay = document.createElement('div')
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(42,36,32,0.35);display:flex;align-items:center;justify-content:center;z-index:1000;'
  const card = document.createElement('div')
  card.style.cssText =
    'background:#fff;border-radius:8px;padding:24px 28px;max-width:420px;box-shadow:0 8px 32px rgba(0,0,0,0.25);font:17px Georgia,serif;color:#2a2420;'
  const text = document.createElement('p')
  text.style.margin = '0 0 16px'
  text.textContent = 'È stato trovato un documento non salvato. Ripristinarlo?'
  const row = document.createElement('div')
  row.style.display = 'flex'
  row.style.gap = '8px'
  row.style.justifyContent = 'flex-end'
  const restore = document.createElement('button')
  restore.textContent = 'Ripristina'
  restore.style.cssText = 'padding:6px 14px;cursor:pointer;'
  const discard = document.createElement('button')
  discard.textContent = 'Scarta'
  discard.style.cssText = 'padding:6px 14px;cursor:pointer;'
  row.appendChild(discard)
  row.appendChild(restore)
  card.appendChild(text)
  card.appendChild(row)
  overlay.appendChild(card)
  document.body.appendChild(overlay)

  const close = (action: 'restore' | 'discard') => {
    overlay.remove()
    if (action === 'restore') {
      applySaved(saved)
    } else {
      // Drop the record, otherwise the same prompt returns on every load until
      // the user happens to type something that overwrites it.
      clearSaved()
      ghostInput.focus()
    }
  }
  restore.addEventListener('click', () => close('restore'))
  discard.addEventListener('click', () => close('discard'))
}

async function maybeRestore(): Promise<void> {
  try {
    const saved = await withStore<any>('readonly', (store) => store.get(KEY))
    if (!saved || !Array.isArray(saved.paragraphs)) return
    // Only prompt on a fresh boot, before the user has touched anything.
    if (touchedThisSession) return
    showRecoveryPrompt(saved)
  } catch {
    // No storage available: start fresh silently.
  }
}

export function initPersistence(): void {
  // subscribeChanged, not subscribeEdits: style edits and image mutations are
  // document changes too and must autosave (BUGHUNT C2/H2).
  subscribeChanged(() => {
    touchedThisSession = true
    scheduleSave()
  })
  subscribeReset(() => {
    touchedThisSession = true
    clearSaved()
  })
  maybeRestore()
}
