// Gate runner: drives the dev server in headless Chromium and runs the
// differential gates and stress checks from the console.
//
//   node scripts/gate-runner.mjs <url> [--quick]
//
// <url> defaults to http://localhost:5175. With --quick, uses a smaller
// document (200 pages) so the run is fast; the reference measurements use the
// default (2000 pages) via `node scripts/gate-runner.mjs` with no flag.

import puppeteer from 'puppeteer'

const url = process.argv[2] || 'http://localhost:5175'
const quick = process.argv.includes('--quick')

const pages = quick ? 200 : 2000
const images = quick ? 40 : 400
const sections = quick ? 8 : 20

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1400, height: 900 })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })

  await page.evaluate(() => console.log('READY'))

  // Build the stress document.
  const buildMs = await page.evaluate(async ({ pages, images, sections }) => {
    const t0 = performance.now()
    const built = await window.pretextStress.generate({ pages, images, sections, seed: 7 })
    return { built, ms: performance.now() - t0 }
  }, { pages, images, sections })
  console.log('BUILD', JSON.stringify({ paragraphs: buildMs.built.paragraphs, chars: buildMs.built.characters, images: buildMs.built.images, ms: Math.round(buildMs.ms) }))

  const replace = await page.evaluate(() => window.pretextStress.compareReplaceAgainstRefit(500))
  console.log('REPLACE_GATE', JSON.stringify({ checked: replace.checked, skipped: replace.skipped, mismatches: replace.mismatches.length }))
  if (replace.mismatches.length > 0) {
    console.log('REPLACE_MISMATCHES', JSON.stringify(replace.mismatches.slice(0, 3), null, 2))
  }

  const heights = await page.evaluate(() => window.pretextStress.checkHeightIndex())
  console.log('HEIGHT_GATE', JSON.stringify({ checked: heights.checked, mismatches: heights.mismatches.length, totalExpected: Math.round(heights.totalExpected), totalActual: Math.round(heights.totalActual) }))
  if (heights.mismatches.length > 0) {
    console.log('HEIGHT_MISMATCHES', JSON.stringify(heights.mismatches.slice(0, 3), null, 2))
  }

  const report = await page.evaluate(() => window.pretextStress.benchmark())
  console.log('BENCH', JSON.stringify({
    typing: report.typing.map((t) => [t.where, t.medianMs]),
    structural: report.structural.map((t) => [t.where, t.medianMs]),
    layout: report.layout.fullRelayoutMs,
  }))
  console.log('CHECKS', JSON.stringify(report.checks))

  // Worst-case Enter near the top of a big document.
  const worst = await page.evaluate(async () => {
    const dm = await import('/src/model/document.ts')
    const eng = await import('/src/layout/engine.ts')
    const samples = []
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      dm.applyEdit(0, 2, 0, '\n')
      eng.relayout()
      samples.push(Math.round((performance.now() - t0) * 100) / 100)
      dm.applyEdit(0, 2, 1, '')
      eng.relayout()
    }
    return samples
  })
  console.log('WORST_ENTER', JSON.stringify(worst))

  // Idle pass: nothing dirty.
  const idle = await page.evaluate(async () => {
    const eng = await import('/src/layout/engine.ts')
    const samples = []
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      eng.relayout()
      samples.push(Math.round((performance.now() - t0) * 100) / 100)
    }
    return samples
  })
  console.log('IDLE_PASS', JSON.stringify(idle))

  const fuzz = await page.evaluate(() => window.pretextStress.fuzz(300, 5))
  console.log('FUZZ', JSON.stringify({ steps: fuzz.steps, failures: fuzz.failures.length, ms: fuzz.ms }))
  if (fuzz.failures.length > 0) console.log('FUZZ_FAILURES', JSON.stringify(fuzz.failures.slice(0, 3)))

  // Lazy-vs-eager differential gate (rebuilds the document inside).
  const lazy = await page.evaluate(async (opts) => window.pretextStress.compareLazyAgainstEager(opts), { pages, images, sections, seed: 7 })
  console.log('LAZY_GATE', JSON.stringify({ snapshotted: lazy.snapshotted, positions: lazy.positions, checks: lazy.checks, mismatches: lazy.mismatches.length, docHeightExact: lazy.docHeightExact }))
  if (lazy.mismatches.length > 0) console.log('LAZY_MISMATCHES', JSON.stringify(lazy.mismatches.slice(0, 3), null, 2))

  const stability = await page.evaluate(() => window.pretextStress.checkScrollStability())
  console.log('SCROLL_STABILITY', JSON.stringify({ failures: stability.failures.length }))
  if (stability.failures.length > 0) console.log('STABILITY_FAILURES', JSON.stringify(stability.failures, null, 2))

  console.log('PAGE_ERRORS', JSON.stringify(errors))
} finally {
  await browser.close()
}
