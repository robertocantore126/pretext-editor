# Architecture

This document describes how the editor works today, what is measurably wrong with it, and
the architecture we are moving toward. It is the reference for the work in
[ROADMAP.md](./ROADMAP.md).

## 1. What this editor is

A canvas-rendered document editor whose defining feature is **free-positioned floating
images that text flows around on both sides**.

That last part is the hard constraint that determines every other decision. An image can
sit anywhere in the document — including the middle of a column — and a single visual line
of text may be split into two or more fragments flowing to the left and to the right of it.
CSS floats cannot express this (they only shrink line boxes from the edges), which is why
layout is computed by hand rather than delegated to the browser.

Everything else in the design follows from paying that price:

- Text is measured and broken by our own layout code, then painted to `<canvas>`.
- Images are DOM elements overlaid on the canvas, so they can be dragged and resized with
  normal pointer events.
- A hidden `<textarea>` ("ghost input") receives keystrokes, because a canvas cannot.

## 2. Current pipeline

```
keystroke ──> edit op ──> relayout() ─┬─> layoutParagraph()  (for EVERY paragraph)
                                      │      ├─ computeRuns()      measure every char
                                      │      ├─ computeLineSlots() free x-ranges per line
                                      │      └─ greedy fit         chars into each slot
                                      └─> draw()               paint EVERY line
```

**`computeLineSlots(y, lineH, docWidth)`** is the core of the wrap feature. For a given
horizontal band it collects the x-intervals occupied by every overlapping image, merges
them, and returns the free gaps as slots. Images with an alpha map contribute their
silhouette bounds for that band rather than their bounding box, so text hugs a cut-out PNG.

**`layoutParagraph`** walks down the paragraph and, for each line, asks `computeLineSlots`
for the free slots at that `y`, then fills each slot in turn from the running text
position. Filling two slots at the same `y` is what produces text on both sides of an
image.

**Pagination** is applied after the fact: text is laid out as one infinite column, then
`docToVisualY` inserts a `PAGE_GAP` every `PAGE_HEIGHT` pixels for display.

## 3. Measured problems

All figures below were measured in Chrome on a 67,200-character document (~25 pages).

### 3.1 The pretext integration has never executed

`layoutParagraph` calls:

```ts
prepareWithSegments(preparedSegs.map(s => ({ text: s.text, attrs: s.style, width: s.width })))
```

The real signature is `prepareWithSegments(text: string, font: string, options?)`. Passing
an array throws `TypeError: Cannot read properties of undefined (reading 'match')` on
**every** call. The error is swallowed by an empty `catch`, so 100% of layout silently
falls through to the hand-written greedy fitter beneath it.

Consequence: the greedy fitter is the real engine, and it breaks lines by scanning
characters looking for spaces. It has no Unicode segmentation, no CJK or Thai line
breaking, no grapheme clustering, and no emoji width correction.

### 3.2 Layout is O(entire document) per keystroke

`relayout()` re-runs `computeRuns()` for every paragraph, which calls `measureText` once per
character, and `getStyleAt` loops over all marks per character.

| Document size | Per keystroke |
| --- | --- |
| 15.8k chars | 21 ms |
| 32.7k chars | 42 ms |
| 67.2k chars | **82 ms** |

82 ms is roughly 12 fps while typing.

### 3.3 Painting is O(entire document), and never stops

`draw()` repaints every line in the document, including the thousands off-screen — 8 ms at
67k chars. The caret blink timer calls it **every 530 ms on a completely idle editor**.

### 3.4 The canvas has a hard size ceiling

The canvas is sized to the whole document: 29,324 px tall at 67k chars, ~25M pixels
(~100 MB) at `devicePixelRatio` 1. At dpr 2 the backing store would be 58,648 px, past the
per-dimension limit in many browser versions — at which point the document renders blank.
This is a wall that no amount of layout optimisation gets past.

### 3.5 Formatting corrupts on any edit

`state.paragraphs` is spliced in four places. `state.marks` is spliced in **zero**. Press
Enter and every mark below the split attaches to the wrong paragraph. Marks also hold
absolute offsets that are never shifted on insert or delete, so typing one character before
a bold run slides the formatting permanently out of alignment.

### 3.6 Editing gaps

- Typing with a selection active inserts at the caret instead of replacing the selection.
- Multi-paragraph selections are not rendered at all.
- No undo/redo, no Ctrl+A/C/X, no clipboard handling for text.
- No `compositionstart`/`compositionend`, so any IME (CJK) input produces garbage.
- No persistence — a refresh loses the document.
- `MAX_LAYOUT_STEPS_PER_PARA` silently truncates very long paragraphs.
- `pixelToCursor` and `moveVertical` assume `LINE_HEIGHT`, so the caret is misplaced on
  taller headline lines. Vertical arrows have no sticky column.
- Lines straddling a page boundary bleed into the page gap; export splits them.

## 4. Target architecture

### 4.1 Line breaking: pretext `rich-inline`

`@chenglou/pretext/rich-inline` is the API that matches this editor, and critically it
supports the multi-slot case. Prepare the paragraph once from its styled runs, then call
`layoutNextRichInlineLineRange(prepared, slotWidth, cursor)` per slot, threading
`range.end` back in as the next `start`:

```
slot 180 → [item0 "Nel mezzo del cammin "]
slot 240 → [item0 "di nostra vita"] [item1 gapBefore 4.1 "mi ritrovai per "]
slot 180 → [item1 "una selva oscura"]  [item2 gapBefore 4.1 "che "]
slot 240 → [item2 "la diritta via era smarrita."]
```

Each fragment carries `itemIndex` (which style run, hence which font), `text`, `gapBefore`
and `occupiedWidth`, so rendering is:

```ts
x += frag.gapBefore
ctx.font = fontFor(frag.itemIndex)
ctx.fillText(frag.text, x, baseline)
x += frag.occupiedWidth
```

This replaces the greedy fitter and brings correct Unicode behaviour with it.

### 4.2 Incremental layout: obstruction bands

A paragraph's line breaking depends on **where it sits vertically**, because that decides
which images obstruct it. So `paragraph → lines` cannot be cached on text alone.

The dependency is sparse, though. Classify each paragraph:

- **Position-sensitive** — intersects an image's vertical band, or straddles a page
  boundary. Must be re-fitted if it moves.
- **Position-independent** — everything else. If it moves, add a delta to its `yTop`. No
  re-fit, no re-measure.

Cache per paragraph:

```ts
{ textVersion, styleVersion, docWidth, yStart, obstructionKey, lines, height }
```

`relayout` walks top-down accumulating `y` and **exits early as soon as the accumulated
delta is zero and the obstruction key is unchanged** — nothing below can have moved. Typing
inside a paragraph usually does not change its line count, so the walk terminates after one
or two paragraphs. That is the O(1) common case.

Target: **~0.5–2 ms per keystroke at 67k chars.**

### 4.3 Virtualised painting

Size the canvas to the viewport, not the document. Put it in a scroll container over a
full-height spacer div, binary-search the `lines` array (sorted by `yTop`) for the visible
band, and paint only those lines.

This removes the 8 ms paint, the ~100 MB allocation, and the size ceiling in 3.4 at once.
Documents become unbounded.

### 4.4 Caret off the canvas

An absolutely positioned 2 px div with a CSS keyframe blink. Zero canvas work when idle.

### 4.5 Style bytes instead of offset marks

Replace `TextMark[]` with a `Uint8Array` parallel to each paragraph's text, one byte per
character, bits for bold/italic/underline/headline:

```ts
paragraphs: { text: string, style: Uint8Array }[]
```

Every edit splices both in lockstep, so offsets cannot desynchronise — the bug class in 3.5
becomes unrepresentable. It also deletes `normalizeMarksForPara` entirely and turns
`getStyleAt`'s per-character loop over all marks into a single byte read. Cost is 1 byte per
character: 66 KB on a 66k-character document.

### 4.6 A single mutation chokepoint

Every edit routes through one function:

```ts
applyEdit(paraIndex, offset, deleteCount, insertText)
```

This is where text and style bytes are spliced together, where undo entries are recorded,
where `deleteSelection()` is called first, and where the dirty-paragraph index is marked for
incremental layout. Most of section 3.6 is fixed by having this exist.

### 4.7 Precomputed silhouette rows

When the alpha map is built, also build `rowSpans: Int16Array(2 * h)` holding
`[minX, maxX]` per row. `computeLineSlots` currently rescans every pixel of every
overlapping image for every line on every relayout; with row spans it becomes two array
reads. This matters most while dragging an image, when it runs for every affected line at
60 fps.

## 5. Module layout

```
src/
  config.ts              constants: fonts, metrics, page geometry, colours
  types.ts               shared interfaces
  state.ts               the mutable document + view state
  dom.ts                 the DOM scaffold, created once and exported
  measure.ts             canvas measurement, run widths, style lookup

  layout/
    pagination.ts        docToVisualY / visualToDocY  (dependency-free)
    caret-position.ts    cursor <-> pixel geometry: lineForCursor, pixelToCursor
    slots.ts             computeLineSlots: free x-ranges given floating images
    paragraph.ts         layoutParagraph: runs, slot filling, line production
    engine.ts            relayout orchestration + scheduleRelayout

  render/
    draw.ts              canvas painting

  edit/
    caret.ts             ghost input placement + caret blink
    ops.ts               insert / split / backspace / delete / cursor movement
    marks.ts             mark application, normalisation, headline toggle

  images/
    images.ts            float image lifecycle, drag/resize, alpha maps

  io/
    json.ts              document export / import
    html.ts              HTML export
    pdf.ts               PDF export (jsPDF)

  input/
    keyboard.ts          ghost input events, document-level key handling
    pointer.ts           click-to-place-caret, drag-select, file drop

  main.ts                toolbar wiring, window events, boot
```

### Import direction

The one rule that keeps this acyclic: **`layout/` and `render/` never import `engine`.**

`render/draw.ts` needs the caret's pixel position, and the caret blink needs to redraw —
which is a cycle if both live in one module. So the *geometry* (`lineForCursor`,
`caretPixelPosition`, `pixelToCursor`) sits in `layout/caret-position.ts`, which is pure and
importable from anywhere, while the *behaviour* (blink timer, ghost input placement) sits in
`edit/caret.ts`, which is free to import `render/draw`. `layout/pagination.ts` is split out
for the same reason.

Roughly, dependencies flow:

```
config, types  →  state, dom  →  measure  →  layout/*  →  render/draw
                                                              ↓
                            input/*  ←  edit/*, images/*, io/*
```
