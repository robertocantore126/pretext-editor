import { FONT } from './config'
import { measureCtx } from './dom'
import { hasHeadlineInRange } from './model/runs'
import { runCache } from './layout/cache'

// Text measurement helpers backed by runCache (layout/cache.ts).

export function measureSubWidth(text: string): number {
  measureCtx.font = FONT
  return measureCtx.measureText(text).width
}
export function paraHasHeadlineInRange(paraIndex: number, start: number, end: number) {
  return hasHeadlineInRange(paraIndex, start, end)
}
export function measureTextWidthOnPara(paraIndex: number, text: string, globalStart: number) {
  // use runCache if available
  const runs = runCache[paraIndex] || []
  if (text.length === 0) return 0
  let remaining = text.length
  let cursor = globalStart
  let acc = 0
  for (const r of runs) {
    if (r.end <= cursor) continue
    if (remaining <= 0) break
    const runLocalStart = Math.max(0, cursor - r.start)
    const take = Math.min(r.end - (r.start + runLocalStart), remaining)
    if (take <= 0) continue
    // Prefix sums: substring width is prefix[b] - prefix[a] (ARCHITECTURE.md §4.7).
    acc += r.prefix[runLocalStart + take] - r.prefix[runLocalStart]
    cursor += take
    remaining -= take
  }
  return acc
}
