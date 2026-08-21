import { PAD_X, PAD_Y } from '../config'
import { ghostInput } from '../dom'
import { caretPixelPosition } from '../layout/caret-position'
import { docToVisualY } from '../layout/pagination'

// Ghost-input placement. How the caret is *drawn* lives in render/caret.ts (Agent B).

export function repositionGhostInput() {
  const pos = caretPixelPosition()
  if (!pos) return
  const visualY = docToVisualY(pos.y)
  ghostInput.style.left = PAD_X + pos.x + 'px'
  ghostInput.style.top = PAD_Y + visualY + 'px'
}
