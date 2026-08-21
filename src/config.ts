// Document metrics, fonts and page geometry.

export const FONT_SIZE = 17
export const LINE_HEIGHT = 27
export const FONT_FAMILY = `"Georgia", "Iowan Old Style", "Palatino Linotype", serif`
export const FONT = `${FONT_SIZE}px ${FONT_FAMILY}`
export const PAD_X = 48
export const PAD_Y = 40
export const PAGE_HEIGHT = 1060
export const PAGE_GAP = 24
export const PARA_GAP = 8
export const MIN_LINE_WIDTH = 40 // below this we push the line down instead of trying to fit text
export const MAX_LAYOUT_STEPS_PER_PARA = 4000 // safety guard against runaway loops

export const INK = '#2a2420'
export const CARET_COLOR = '#7c3aed'
