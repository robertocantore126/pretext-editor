// A3 (docs/PARALLEL-PLAN.md): live IME composition state.
//
// Agent A (input/keyboard.ts) writes it; Agent B (render/draw.ts, via the open
// handoff row) reads getComposition() to paint the preedit underline at the
// caret. The caret does not move while composing: para/offset are the cursor
// position captured at compositionstart.

let state: { para: number; offset: number; text: string } | null = null

/** The live preedit, or null when no composition is in flight. */
export function getComposition(): { para: number; offset: number; text: string } | null {
  return state
}

export function isComposing(): boolean {
  return state !== null
}

export function setComposition(s: { para: number; offset: number; text: string } | null): void {
  state = s
}
