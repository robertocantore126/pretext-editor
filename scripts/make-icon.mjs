// Generates icon.ico (256x256, PNG-in-ICO) for the launcher shortcut.
// Pure Node: draws a paper sheet with text lines and the app's purple caret,
// encodes a PNG (zlib + CRC32), wraps it in an ICO container. No dependencies.
//
// Usage: node scripts/make-icon.mjs   (writes ./icon.ico)

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SS = 2 // supersampling factor for anti-aliased edges
const SIZE = 256
const W = SIZE * SS

const px = Buffer.alloc(W * W * 4) // RGBA, premultiplied not needed

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= W || y >= W) return
  const i = (y * W + x) * 4
  px[i] = r
  px[i + 1] = g
  px[i + 2] = b
  px[i + 3] = a
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t)
}

function inRoundedRect(x, y, x0, y0, w, h, r) {
  if (x < x0 || y < y0 || x >= x0 + w || y >= y0 + h) return false
  const cx = Math.min(Math.max(x, x0 + r), x0 + w - 1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y0 + h - 1 - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

// ---- background: rounded square, vertical purple gradient -------------------
for (let y = 0; y < W; y++) {
  const t = y / (W - 1)
  const r = lerp(0x8b, 0x4b, t) // #7c3aed -> #4b1f6f-ish, brightened for AA
  const g = lerp(0x58, 0x1f, t)
  const b = lerp(0xed, 0x6f, t)
  for (let x = 0; x < W; x++) {
    if (inRoundedRect(x, y, 0, 0, W, W, 112)) set(x, y, r, g, b)
  }
}

// ---- paper sheet ------------------------------------------------------------
const PX0 = 88, PY0 = 80, PW = 336, PH = 352, PR = 32
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    if (inRoundedRect(x, y, PX0, PY0, PW, PH, PR)) set(x, y, 0xf9, 0xf6, 0xf0)
  }
}

// ---- text lines (dark grey bars) --------------------------------------------
const INK = [0x2a, 0x24, 0x20]
const line = (x, y, w, h) => {
  for (let yy = 0; yy < W; yy++) {
    for (let xx = 0; xx < W; xx++) {
      if (inRoundedRect(xx, yy, x, y, w, h, 12)) set(xx, yy, INK[0], INK[1], INK[2])
    }
  }
}
line(128, 168, 256, 28)
line(128, 216, 256, 28)
line(128, 264, 200, 28) // paragraph break
line(128, 312, 256, 28)
line(128, 360, 256, 28)

// ---- the app's caret: purple bar on the second line --------------------------
for (let yy = 0; yy < W; yy++) {
  for (let xx = 0; xx < W; xx++) {
    if (inRoundedRect(xx, yy, 348, 216, 14, 28, 7)) set(xx, yy, 0x7c, 0x3a, 0xed)
  }
}

// ---- downsample to 256 (simple box filter) ----------------------------------
const out = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const i = ((y * SS + dy) * W + x * SS + dx) * 4
        r += px[i]
        g += px[i + 1]
        b += px[i + 2]
        a += px[i + 3]
      }
    }
    const n = SS * SS
    const o = (y * SIZE + x) * 4
    out[o] = Math.round(r / n)
    out[o + 1] = Math.round(g / n)
    out[o + 2] = Math.round(b / n)
    out[o + 3] = Math.round(a / n)
  }
}

// ---- PNG encode --------------------------------------------------------------
function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function pngFromRgba(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const png = pngFromRgba(SIZE, SIZE, out)

// ---- ICO wrap (single 256x256 PNG entry) -------------------------------------
const ico = Buffer.alloc(22 + png.length)
ico.writeUInt16LE(0, 0) // reserved
ico.writeUInt16LE(1, 2) // type: icon
ico.writeUInt16LE(1, 4) // image count
ico[6] = 0 // width 256 (0 means 256)
ico[7] = 0 // height 256
ico[10] = 1 // planes
ico.writeUInt16LE(32, 12) // bpp
ico.writeUInt32LE(png.length, 14)
ico.writeUInt32LE(22, 18) // data offset
png.copy(ico, 22)

const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'icon.ico')
writeFileSync(dest, ico)
console.log('icona scritta:', dest, ico.length, 'byte')
