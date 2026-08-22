import puppeteer from 'puppeteer'
import fs from 'fs'
import path from 'path'

const BASE = 'http://localhost:5180/'
const DOC = path.resolve('scripts/_buddha-doc.json')
const OUT = 'scripts/_gaps-out.pdf'

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.evaluateOnNewDocument(() => {
  const orig = URL.createObjectURL.bind(URL)
  window.__capBlobs = []
  URL.createObjectURL = (blob) => { window.__capBlobs.push(blob); return orig(blob) }
})
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 60000 })
const input = await page.$('input[type="file"]')
if (!input) throw new Error('no file input')
await input.uploadFile(DOC)
await new Promise((r) => setTimeout(r, 3000))
const btn = await page.$('#btn-export-pdf')
await btn.click()
await new Promise((r) => setTimeout(r, 4000))
const b64 = await page.evaluate(async () => {
  const arr = window.__capBlobs || []
  if (!arr.length) return null
  const buf = new Uint8Array(await arr[arr.length - 1].arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(bin)
})
await browser.close()
if (!b64) { console.error('NO PDF'); process.exit(2) }
fs.writeFileSync(OUT, Buffer.from(b64, 'base64'))
console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes')
