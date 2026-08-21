import { docWrap, ghostInput } from '../dom'
import { caretPixelPosition } from '../layout/caret-position'
import { relayout, scheduleRelayout } from '../layout/engine'
import { notifyChanged } from '../model/document'
import { draw } from '../render/draw'
import { view } from '../state/view'
import type { FloatImage } from '../types'

// Floating image lifecycle: creation, selection, drag/resize, and the alpha map
// that lets text wrap the silhouette rather than the bounding box.

let imgCounter = 0

/** Where a newly created image should end up. */
type Placement =
  | { kind: 'fixed'; x: number; y: number; w: number; h: number }
  /** Size from the natural dimensions, position from the drop point or the caret. */
  | { kind: 'auto'; dropX?: number; dropY?: number }

/**
 * Serializes an image to a data URL, or null when it cannot be serialized:
 * a cross-origin image without CORS taints the canvas (toDataURL throws), and
 * an image that never loaded has nothing to draw. Callers must skip nulls so
 * one bad image cannot veto a whole autosave or export (BUGHUNT C1/M7).
 */
export function convertImageToDataURL(img: HTMLImageElement): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      if (!img.naturalWidth || !img.naturalHeight) {
        resolve(null)
        return
      }
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx2 = canvas.getContext('2d')!
      ctx2.drawImage(img, 0, 0)
      resolve(canvas.toDataURL('image/png'))
    } catch {
      // Tainted canvas (cross-origin image without CORS) or any other failure.
      resolve(null)
    }
  })
}

/**
 * Builds the DOM handle for a floating image and wires drag/resize/delete.
 * Both entry points below funnel through here; they differ only in how the
 * image is sized and positioned once it has loaded.
 */
function createFloatImage(src: string, placement: Placement): FloatImage {
  const imgEl = new Image()
  const wrapper = document.createElement('div')
  wrapper.className = 'img-handle'
  wrapper.appendChild(imgEl)
  const grip = document.createElement('div')
  grip.className = 'resize-grip'
  const del = document.createElement('div')
  del.className = 'delete-btn'
  del.textContent = '×'
  wrapper.appendChild(grip)
  wrapper.appendChild(del)
  docWrap.appendChild(wrapper)
  imgEl.style.width = '100%'
  imgEl.style.height = '100%'
  imgEl.style.display = 'block'
  imgEl.style.userSelect = 'none'
  imgEl.draggable = false

  const id = 'img-' + ++imgCounter
  const rec: FloatImage =
    placement.kind === 'fixed'
      ? { id, img: imgEl, wrapper, x: placement.x, y: placement.y, w: placement.w, h: placement.h, loaded: false, objectUrl: src }
      : { id, img: imgEl, wrapper, x: 0, y: 0, w: 160, h: 160, loaded: false, objectUrl: src }
  view.images.push(rec)
  notifyChanged()

  imgEl.onload = () => {
    if (placement.kind === 'auto') {
      const maxDim = Math.min(260, Math.max(120, view.docWidth * 0.42))
      let w = imgEl.naturalWidth
      let h = imgEl.naturalHeight
      if (w > maxDim) {
        h = h * (maxDim / w)
        w = maxDim
      }
      rec.w = Math.round(w)
      rec.h = Math.round(h)

      let x: number
      let y: number
      if (placement.dropX !== undefined && placement.dropY !== undefined) {
        x = placement.dropX - rec.w / 2
        y = placement.dropY - rec.h / 2
      } else {
        const caret = caretPixelPosition() || { x: 0, y: 0 }
        if (caret.x > view.docWidth / 2) {
          x = view.docWidth - rec.w
        } else {
          x = 0
        }
        y = caret.y
      }
      rec.x = Math.max(0, Math.min(view.docWidth - rec.w, x))
      rec.y = Math.max(0, y)
    }
    rec.loaded = true
    relayout()
    buildAlphaMapForImage(rec)
  }
  imgEl.src = src

  const beginDrag = (e: MouseEvent, mode: 'move' | 'resize') => {
    e.stopPropagation()
    selectImage(id)
    view.dragging = {
      id,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      origX: rec.x,
      origY: rec.y,
      origW: rec.w,
      origH: rec.h,
      aspect: rec.w / rec.h,
    }
  }
  wrapper.addEventListener('mousedown', (e) => beginDrag(e, 'move'))
  grip.addEventListener('mousedown', (e) => beginDrag(e, 'resize'))
  del.addEventListener('mousedown', (e) => e.stopPropagation())
  del.addEventListener('click', (e) => {
    e.stopPropagation()
    deleteImage(id)
  })

  return rec
}

export function addImageFromDataURL(dataUrl: string, x: number, y: number, w: number, h: number) {
  createFloatImage(dataUrl, { kind: 'fixed', x, y, w, h })
}

export function addImageFromFile(file: File | Blob, dropX?: number, dropY?: number) {
  createFloatImage(URL.createObjectURL(file), { kind: 'auto', dropX, dropY })
}

export function addImageFromBlob(blob: Blob, x: number, y: number, w: number, h: number) {
  createFloatImage(URL.createObjectURL(blob), { kind: 'fixed', x, y, w, h })
}

// RICH-TEXT-MODEL.md §12: cap on how large a remote image may be to import as
// a local blob. Oversized images fall back to the live URL: display works,
// persistence degrades — but a paste of a full web page stays bounded.
const MAX_REMOTE_IMAGE_BYTES = 8 * 1024 * 1024

/**
 * Adds an image from a URL string (remote or data:), auto-sized at the caret.
 * Used by the HTML importer (RICH-TEXT-MODEL.md §9). Remote URLs are fetched
 * into a local blob first, so the image survives a reload through
 * serializeImages/restoreImages without a CORS taint on save; data:/blob: URLs
 * pass through untouched.
 */
export function addImageFromSrc(src: string) {
  if (/^https?:/i.test(src)) {
    fetch(src, { mode: 'cors' })
      .then((res) => {
        if (!res.ok) throw new Error('fetch failed')
        return res.blob()
      })
      .then((blob) => {
        if (blob.size > MAX_REMOTE_IMAGE_BYTES) throw new Error('image too large')
        createFloatImage(URL.createObjectURL(blob), { kind: 'auto' })
      })
      .catch(() => {
        // CORS/network failure or size cap: fall back to showing the remote URL
        // directly. Display works; persisting it may fail, but the paste still
        // succeeds.
        createFloatImage(src, { kind: 'auto' })
      })
    return
  }
  createFloatImage(src, { kind: 'auto' })
}

/**
 * Serializes every floating image for persistence (handoff A -> B, blocks A5):
 * geometry plus the image bytes as a Blob, so IndexedDB can store them without
 * base64 data URLs. Object URLs are fetched; data: URLs fall back to canvas.
 */
export async function serializeImages(): Promise<{ x: number; y: number; w: number; h: number; type: string; blob: Blob }[]> {
  const out: { x: number; y: number; w: number; h: number; type: string; blob: Blob }[] = []
  for (const im of view.images) {
    let blob: Blob | null = null
    try {
      const res = await fetch(im.img.src)
      if (res.ok) blob = await res.blob()
    } catch {
      blob = null
    }
    if (!blob) {
      blob = await new Promise<Blob>((resolve) => {
        const c = document.createElement('canvas')
        c.width = im.img.naturalWidth || im.w
        c.height = im.img.naturalHeight || im.h
        const g = c.getContext('2d')!
        g.drawImage(im.img, 0, 0)
        c.toBlob((b) => resolve(b ?? new Blob()), 'image/png')
      })
    }
    const type = im.img.src.startsWith('data:') ? im.img.src.split(';')[0].slice(5) : blob.type || 'image/png'
    out.push({ x: im.x, y: im.y, w: im.w, h: im.h, type, blob })
  }
  return out
}

/** Restores images saved by serializeImages, keeping their geometry. */
export async function restoreImages(saved: { x?: number; y?: number; w?: number; h?: number; blob?: Blob }[]): Promise<void> {
  for (const im of saved) {
    if (!im || !(im.blob instanceof Blob)) continue
    addImageFromBlob(im.blob, im.x ?? 0, im.y ?? 0, im.w ?? 160, im.h ?? 160)
  }
}

/** Only blob: URLs own memory that needs releasing; data: URLs must not be revoked. */
function releaseImageUrl(url: string) {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}

export function selectImage(id: string) {
  view.selectedImageId = id
  for (const im of view.images) im.wrapper.classList.toggle('selected', im.id === id)
  // blurring is deliberate: typing must not land in the document while an image
  // is selected. input/keyboard.ts has a document-level listener for Backspace.
  ghostInput.blur()
}

export function deselectImage() {
  view.selectedImageId = null
  for (const im of view.images) im.wrapper.classList.remove('selected')
}

export function deleteImage(id: string) {
  const idx = view.images.findIndex((i) => i.id === id)
  if (idx === -1) return
  releaseImageUrl(view.images[idx].objectUrl)
  view.images[idx].wrapper.remove()
  view.images.splice(idx, 1)
  if (view.selectedImageId === id) view.selectedImageId = null
  notifyChanged()
  relayout()
}

/** Drops every image and releases its memory. Used by "new document" and import. */
export function clearImages() {
  for (const im of view.images) {
    releaseImageUrl(im.objectUrl)
    im.wrapper.remove()
  }
  view.images = []
  view.selectedImageId = null
}

export function buildAlphaMapForImage(rec: FloatImage, sampleFactor = 3) {
  if (!rec.loaded) return
  try {
    const dw = Math.max(2, Math.floor(rec.w / sampleFactor))
    const dh = Math.max(2, Math.floor(rec.h / sampleFactor))
    const oc = document.createElement('canvas')
    oc.width = dw
    oc.height = dh
    const octx = oc.getContext('2d')!
    octx.clearRect(0, 0, dw, dh)
    // draw image scaled to downsampled size
    octx.drawImage(rec.img, 0, 0, dw, dh)
    const imgd = octx.getImageData(0, 0, dw, dh)
    const data = new Uint8Array(dw * dh)
    for (let i = 0; i < dw * dh; i++) {
      const alpha = imgd.data[i * 4 + 3]
      data[i] = alpha > 25 ? 1 : 0
    }
    // Precompute [minX, maxX] per row so computeLineSlots does two array reads
    // per row instead of rescanning every pixel (ARCHITECTURE.md §4.7).
    const rowSpans = new Int16Array(dh * 2)
    for (let r = 0; r < dh; r++) {
      let rowMin = -1
      let rowMax = -1
      for (let cx = 0; cx < dw; cx++) {
        if (data[r * dw + cx]) {
          if (rowMin === -1) rowMin = cx
          rowMax = cx
        }
      }
      rowSpans[r * 2] = rowMin
      rowSpans[r * 2 + 1] = rowMax
    }
    rec.alphaMap = { w: dw, h: dh, data, rowSpans, scale: sampleFactor }
  } catch (err) {
    // ignore
  }
}

export function initImageInteractions() {
  window.addEventListener('mousemove', (e) => {
    const d = view.dragging
    if (!d) return
    const rec = view.images.find((i) => i.id === d.id)
    if (!rec) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (d.mode === 'move') {
      rec.x = Math.max(0, Math.min(view.docWidth - rec.w, d.origX + dx))
      rec.y = Math.max(0, d.origY + dy)
    } else {
      const newW = Math.max(40, d.origW + dx)
      rec.w = Math.round(newW)
      rec.h = Math.round(newW / d.aspect)
    }
    // Geometry changes must reach the autosave (BUGHUNT H2); the debounce
    // collapses the per-frame spam into one save after the drag settles.
    notifyChanged()
    scheduleRelayout()
  })
  window.addEventListener('mouseup', () => {
    const d = view.dragging
    if (d && d.mode === 'resize') {
      // The silhouette is sampled once at load; rebuild it for the new box so
      // the wrap follows the resized shape (BUGHUNT M11).
      const rec = view.images.find((i) => i.id === d.id)
      if (rec) buildAlphaMapForImage(rec)
    }
    view.dragging = null
  })

  // click elsewhere deselects images (mousedown on doc-wrap already handles text areas;
  // this also covers clicking outside the card entirely)
  document.addEventListener('mousedown', (e) => {
    if (!(e.target as HTMLElement).closest('.doc-wrap')) {
      deselectImage()
      draw()
    }
  })
}
