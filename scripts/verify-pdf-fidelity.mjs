// Does the PDF print what the editor shows?
//
// The export is a transcription of the paint (src/io/pdf.ts), so the only
// honest test is to put the two pictures on top of each other: load a fixture
// through the running dev server, screenshot the editor, export the PDF,
// rasterise page 1 at 96 dpi — one raster pixel per CSS pixel — and diff.
//
// A correct export leaves only glyph *outlines* in the diff: Chrome and the PDF
// rasteriser anti-alias differently, so edges never agree to the byte. Filled
// shapes, doubled words or a shifted block mean the export drifted from the
// layout, which is the failure this exists to catch.
//
//   node scripts/verify-pdf-fidelity.mjs [--base http://localhost:5190/] [--out .]
//
// Needs the dev server running and `pdftoppm` (poppler) on PATH.

import puppeteer from 'puppeteer'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const BASE = arg('base', 'http://localhost:5190/')
const OUT = arg('out', path.join(os.tmpdir(), 'pretext-pdf-fidelity'))
fs.mkdirSync(OUT, { recursive: true })

// ---- fixture -------------------------------------------------------------
// One page exercising everything the exporter has to carry across: colour,
// bold/italic, superscript, background, strike, underline, a link, an image
// text wraps around, a justified paragraph, and the Sanskrit diacritics that
// have no glyph in Georgia (ṇ ṛ) next to the ones that do (ā ś).

function png(w, h, pixel) {
  let table = null
  const crc32 = (buf) => {
    if (!table) {
      table = []
      for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        table[n] = c
      }
    }
    let c = 0xffffffff
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
    return c ^ 0xffffffff
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const raw = Buffer.alloc((w * 3 + 1) * h)
  let o = 0
  for (let y = 0; y < h; y++) {
    raw[o++] = 0
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y)
      raw[o++] = r
      raw[o++] = g
      raw[o++] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function fixture() {
  const W = 300
  const H = 200
  const image = png(W, H, (x, y) => {
    if (Math.hypot(x - W / 2, y - H / 2) < 70) return [214, 158, 46]
    return (x + y) % 40 < 20 ? [120, 160, 190] : [90, 130, 165]
  })
  const p1 =
    'Buddhism, also known as Buddhadharma and Dharmavinaya (transl. "doctrines and disciplines"), is an Indian religion and philosophy based on teachings attributed to the Buddha, a śramaṇa and religious teacher who lived in the 6th or 5th century BCE.[7] It is the world\'s fourth-largest religion,[8][9] with about 320 million followers, known as Buddhists, who comprise 4.1% of the global population.[10]'
  const p2 =
    'According to tradition, the Buddha taught a path of cultivation that leads to awakening and liberation from dukkha (often translated as "suffering") by attaining nirvana, the blowing out of the passions. He regarded this path as a Middle Way between extreme asceticism and sensory indulgence, and also between the extremes of eternalism and nihilism. Other commonly observed elements include the Triple Gem, the taking of monastic vows, and the cultivation of perfections (pāramitā).'
  // Two font stacks, because a real document has more than one: a paste keeps
  // the source page's family on every run (p1, the Wikipedia case) while text
  // typed in the editor carries its own default (p2). Drawing both in one face
  // is what used to make runs overrun their slot and eat the space before the
  // next one, so the fixture has to contain the mix.
  const sans = {
    fontFamily: '"Segoe UI", Arial, sans-serif', fontSize: 17, fontWeight: 400, italic: false,
    underline: false, strike: false, color: '#2a2420', background: null, letterSpacing: 0,
    baseline: 'normal', linkHref: null, headline: false,
  }
  const serif = { ...sans, fontFamily: '"Georgia", "Iowan Old Style", "Palatino Linotype", serif' }
  const variants = (base) => [
    base,
    { ...base, color: '#3366cc', linkHref: 'https://example.com' },
    { ...base, fontWeight: 700 },
    { ...base, italic: true },
    { ...base, color: '#3366cc', baseline: 'super', fontSize: 12 },
    { ...base, underline: true, color: '#3366cc', linkHref: 'https://example.org' },
    { ...base, background: '#ffe680' },
    { ...base, strike: true },
    { ...base, fontFamily: 'monospace' },
  ]
  const styleTable = [...variants(sans), ...variants(serif)]
  const SANS = 0
  const SERIF = 9
  const ids = (text, at, spans) => {
    const a = new Array(text.length).fill(at)
    for (const [needle, id] of spans.map(([n, o]) => [n, at + o])) {
      let from = 0
      for (;;) {
        const i = text.indexOf(needle, from)
        if (i < 0) break
        for (let k = i; k < i + needle.length; k++) a[k] = id
        from = i + needle.length
      }
    }
    return a
  }
  const block = (align) => ({
    kind: 'paragraph', align, indentLeft: 0, indentRight: 0, indentFirstLine: 0,
    spaceBefore: 0, spaceAfter: 0, lineHeight: null, list: null,
  })
  return {
    version: 2,
    paragraphs: [p1, p2],
    styleTable,
    styleIds: [
      ids(p1, SANS, [['Buddhism', 2], ['Buddhadharma', 2], ['Dharmavinaya', 2], ['Indian religion', 1],
        ['philosophy', 1], ['teachings', 1], ['the Buddha', 1], ['śramaṇa', 3], ['BCE', 1],
        ['[7]', 4], ['[8]', 4], ['[9]', 4], ['[10]', 4], ['Buddhists', 1],
        ["world's fourth-largest religion", 1]]),
      ids(p2, SERIF, [['cultivation', 1], ['awakening', 1], ['liberation', 1], ['dukkha', 3], ['nirvana', 1],
        ['Middle Way', 1], ['eternalism', 6], ['nihilism', 7], ['Triple Gem', 5],
        ['monastic vows', 1], ['pāramitā', 3], ['the passions', 8]]),
    ],
    blockAttrs: [block('left'), block('justify')],
    images: [{ x: 380, y: 120, w: W, h: H, type: 'image/png', dataUrl: 'data:image/png;base64,' + image.toString('base64') }],
  }
}

// ---- run -----------------------------------------------------------------

const docPath = path.join(OUT, 'fixture.json')
fs.writeFileSync(docPath, JSON.stringify(fixture()))

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1000, height: 1500, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
// jsPDF hands the file over as a blob URL; keep the blob so we can read it back.
await page.evaluateOnNewDocument(() => {
  const orig = URL.createObjectURL.bind(URL)
  window.__blobs = []
  URL.createObjectURL = (blob) => {
    window.__blobs.push(blob)
    return orig(blob)
  }
})
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 60000 })
const input = await page.$('input[type="file"]')
if (!input) throw new Error('no import input on the page — is this the editor?')
await input.uploadFile(docPath)
await new Promise((r) => setTimeout(r, 2500))

const editorPng = path.join(OUT, 'editor.png')
await (await page.$('.doc-wrap')).screenshot({ path: editorPng })
await (await page.$('#btn-export-pdf')).click()
await new Promise((r) => setTimeout(r, 6000))
const b64 = await page.evaluate(async () => {
  const arr = window.__blobs || []
  if (!arr.length) return null
  const buf = new Uint8Array(await arr[arr.length - 1].arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(bin)
})
if (!b64) {
  await browser.close()
  console.error('the export produced no file')
  process.exit(2)
}
const pdfPath = path.join(OUT, 'export.pdf')
fs.writeFileSync(pdfPath, Buffer.from(b64, 'base64'))

// 96 dpi: the sheet is the program page in points, so one raster pixel is one
// CSS pixel and the two images are directly comparable.
execFileSync('pdftoppm', ['-r', '96', '-png', '-f', '1', '-l', '1', pdfPath, path.join(OUT, 'page')], {
  stdio: ['ignore', 'ignore', 'ignore'],
})
const pdfPng = path.join(OUT, 'page-1.png')

// The editor puts document y=0 at PAD_Y; the sheet puts it at 0.
const PAD_Y = 40
const toUrl = (p) => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64')
await page.setContent('<body style="margin:0">')
const res = await page.evaluate(
  async (aSrc, bSrc, offY) => {
    const load = (src) =>
      new Promise((r) => {
        const i = new Image()
        i.onload = () => r(i)
        i.src = src
      })
    const [a, b] = await Promise.all([load(aSrc), load(bSrc)])
    const w = Math.min(a.width, b.width)
    const h = Math.min(a.height - offY, b.height)
    const pixels = (img, dy) => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const x = c.getContext('2d')
      x.drawImage(img, 0, dy, w, h, 0, 0, w, h)
      return x.getImageData(0, 0, w, h).data
    }
    const A = pixels(a, offY)
    const B = pixels(b, 0)
    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    const octx = out.getContext('2d')
    const od = octx.createImageData(w, h)
    let differ = 0
    // A displaced word paints a *solid* blob; anti-aliasing paints outlines.
    // Counting 3x3 neighbourhoods that differ throughout separates the two.
    const bad = new Uint8Array(w * h)
    for (let i = 0, p = 0; i < A.length; i += 4, p++) {
      const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]))
      if (d > 32) {
        differ++
        bad[p] = 1
      }
      od.data[i] = d > 32 ? 255 : 255 - d
      od.data[i + 1] = d > 32 ? 0 : 255 - d
      od.data[i + 2] = d > 32 ? 0 : 255 - d
      od.data[i + 3] = 255
    }
    let solid = 0
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let n = 0
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += bad[(y + dy) * w + (x + dx)]
        if (n === 9) solid++
      }
    }
    octx.putImageData(od, 0, 0)
    return { w, h, differ, solid, png: out.toDataURL('image/png') }
  },
  toUrl(editorPng),
  toUrl(pdfPng),
  PAD_Y
)
const diffPath = path.join(OUT, 'diff.png')
fs.writeFileSync(diffPath, Buffer.from(res.png.split(',')[1], 'base64'))
await browser.close()

const area = res.w * res.h
console.log(`compared ${res.w}x${res.h}`)
console.log(`  edge pixels differing : ${res.differ} (${((100 * res.differ) / area).toFixed(2)}% — anti-aliasing, expected)`)
console.log(`  solid 3x3 blocks      : ${res.solid} (${((100 * res.solid) / area).toFixed(3)}% — displacement, must be ~0)`)
console.log(`  editor  ${editorPng}`)
console.log(`  pdf     ${pdfPng}`)
console.log(`  diff    ${diffPath}`)
// A shifted word or a wrong colour fills whole neighbourhoods; outlines do not.
// The floor is not zero: Chrome hints Georgia's stems onto the pixel grid and
// the PDF rasteriser does not, so a stem can sit a fraction of a pixel apart,
// and the image's edge is anti-aliased on one side only. A correct export
// measures ~0.2 %; a run of the broken exporter measured over 10 %.
process.exit(res.solid > area * 0.01 ? 1 : 0)
