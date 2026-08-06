import fs from 'fs'
import path from 'path'
import puppeteer from 'puppeteer'

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length < 2) {
    console.error('Usage: node scripts/export-pdf.js input.html output.pdf')
    process.exit(2)
  }
  const [inFile, outFile] = argv
  const absIn = path.resolve(inFile)
  if (!fs.existsSync(absIn)) {
    console.error('Input file not found:', absIn)
    process.exit(2)
  }
  const html = fs.readFileSync(absIn, 'utf8')
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle0' })
    await page.pdf({ path: outFile, printBackground: true })
    console.log('Wrote PDF to', outFile)
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
