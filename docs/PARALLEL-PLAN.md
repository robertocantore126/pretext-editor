# Parallel work plan — Agent A and Agent B

Splits the work in [ROADMAP.md](./ROADMAP.md) into two tracks that can run at the same time
without touching the same files. Design rationale lives in
[ARCHITECTURE.md](./ARCHITECTURE.md); section references below point there.

## The one rule

**An agent only writes files it owns.** Reading and importing across the boundary is
expected and fine. Writing across it is not — a merge conflict in this project means the
rule was broken, not that the merge was unlucky.

If you need a change in a file you do not own, do not make it. Add a row to the
[Handoff requests](#handoff-requests) table at the bottom of this file (that table is the
one place both agents may append to) and keep working on something else.

## Why the split is drawn where it is

The natural seam is **document model** versus **layout engine**.

- **Agent A** owns what the document *is*: text, styles, cursor, selection, undo, input,
  persistence.
- **Agent B** owns how the document *becomes pixels*: measurement, line breaking,
  incremental layout, painting, images, export renderers.

Left alone this seam leaks in one place: layout and painting both need to know the style of
each character, and Agent A is about to replace the entire representation of styles
(§4.5, `TextMark[]` → `Uint8Array`). If Agent B reads `state.marks` directly, A's first task
breaks B's every file.

Step 0 exists to close that leak before either track starts.

---

## Step 0 — The handshake ✅ done

Landed. Both tracks branch from this commit. Verified with `docs/VERIFY.md`: all checks
pass, `npx tsc --noEmit --noUnusedLocals` is clean, and the ownership audit reports no
B-owned file writing A-owned state.

### 0.1 Introduce the style accessor

New file `src/model/runs.ts`. Every current reader of `state.marks` is converted to call it
and stops touching `state.marks`. The complete list, verified against the tree:

| File | Owner after split | Note |
| --- | --- | --- |
| `layout/paragraph.ts` | B | `getStyleAt` + `computeRuns` |
| `layout/caret-position.ts` | B | per-char style in `pixelToCursor` |
| `measure.ts` | B | `paraHasHeadlineInRange` |
| `render/draw.ts` | B | run extraction while painting |
| `io/pdf.ts`, `io/html.ts` | B | run extraction while exporting |
| `edit/marks.ts` | A | becomes `model/styles.ts`, deleted in A1 |
| `io/json.ts` | A | serialisation — keeps direct access, it is A's own data |
| `main.ts` | frozen | see 0.6 — must stop referencing marks |

Only the B-owned rows strictly need the accessor, but converting all of them keeps a single
way to ask the question.

```ts
export interface Style { bold: boolean; italic: boolean; underline: boolean; headline: boolean }
export interface StyleRun extends Style { start: number; end: number }

/** Contiguous runs of identical style across a paragraph, in order. */
export function getStyleRuns(paraIndex: number): StyleRun[]
export function styleAt(paraIndex: number, offset: number): Style
/** Bumps on any text or style change to the paragraph. Layout uses it as a cache key. */
export function styleVersion(paraIndex: number): number
```

The first implementation just wraps today's `TextMark[]` logic. Agent A later swaps the
insides for style bytes without changing the signature, and Agent B never notices.

### 0.2 Introduce dirty tracking

New file `src/model/dirty.ts`. Agent A's `applyEdit` will call it; Agent B's engine will
consume it. Defining it now lets both code against it before either side is real.

```ts
export function markParagraphDirty(index: number): void
export function markAllDirty(): void
/** Returns and clears the pending dirty range. */
export function takeDirty(): { from: number; to: number } | 'all' | null
```

Initial behaviour: every existing mutation calls `markAllDirty()`, so `relayout()` keeps
doing a full pass. Nothing changes yet.

### 0.3 Introduce selection ranges

New file `src/model/selection.ts`. `render/draw.ts` stops reading `state.selection`
directly and paints whatever this returns — which is what makes multi-paragraph selection
(A's job) land without A editing the renderer (B's file).

```ts
export function getSelectionRanges(): { para: number; start: number; end: number }[]
export function setSelection(anchor: Cursor, focus: Cursor | null): void
export function clearSelection(): void
```

### 0.4 Split the shared barrels

`state.ts` and `types.ts` are the two files both tracks would otherwise fight over.

```
src/state.ts     →  src/state/doc.ts    (A)
                    src/state/view.ts   (B)
                    src/state.ts        (barrel, re-exports both — FROZEN afterwards)

src/types.ts     →  src/types/doc.ts    (A: Cursor, Selection, TextMark, Serialized*)
                    src/types/layout.ts (B: LineInfo, FloatImage)
                    src/types.ts        (barrel — FROZEN afterwards)
```

Field assignment, so there is no ambiguity later:

| `state/doc.ts` (A) | `state/view.ts` (B) |
| --- | --- |
| `paragraphs`, `marks` (→ style bytes) | `lines`, `docWidth`, `docHeight` |
| `cursor`, `selection` | `focused`, `caretVisible`, `dragging` |
| | `images`, `selectedImageId` |
| | `runCache`, `prepared` |

`images` sits on B's side because every writer of it is B's (drag, resize, alpha maps) and
`layout/slots.ts` reads it on the hot path. A reaches images only through Contract 6, never
through state. `runCache` and `prepared` are temporary lodgers — B3 moves them into
`layout/cache.ts` and deletes them from view state.

### 0.5 Move the caret blink to `render/`

`edit/caret.ts` currently holds both ghost-input placement and the blink timer. The blink
becomes a DOM element in B4, so it belongs to B. Move it to `src/render/caret.ts`. Agent A
keeps cursor *movement* in `edit/ops.ts`; Agent B owns everything about how the caret is
drawn.

### 0.6 Drain `main.ts`, pre-wire it, then freeze it

`main.ts` currently assigns `state.marks = [[]]` inside the "Nuovo documento" handler. If it
stays, A1 breaks a frozen file the moment `marks` stops existing. Replace that handler body
with a call into A's model:

```ts
// src/model/document.ts  (A)
export function resetDocument(): void   // clears paragraphs, styles, cursor, selection
```

so the handler becomes `resetDocument(); clearImages(); relayout()` — three calls, all
across owned contracts, none reaching into state.

Then add the init calls both tracks will need, pointing at empty exported stubs in each
agent's own modules:

```ts
initHistory()        // A2  — src/edit/history.ts
initClipboard()      // A4  — src/input/clipboard.ts
initPersistence()    // A5  — src/io/persistence.ts
initVirtualScroll()  // B4  — src/render/viewport.ts
```

`main.ts` is frozen after this, so neither agent ever edits the entry point.

### 0.7 Commit the verification harness

`docs/VERIFY.md` — the browser-console snippets used to measure and smoke-test this editor:
keystroke benchmark at 1k/16k/33k/67k chars, the both-sides-wrap ink check, the image-drop
check. Both agents run these before declaring a task done, so "works on my branch" is
falsifiable. Frozen after step 0.

---

## Ownership

| Path | Owner |
| --- | --- |
| `src/state/doc.ts` | **A** |
| `src/model/` (runs, dirty, selection, styles) | **A** |
| `src/edit/ops.ts`, `src/edit/history.ts` | **A** |
| `src/edit/marks.ts` | **A** (expected to be deleted in A1) |
| `src/input/keyboard.ts`, `src/input/clipboard.ts` | **A** |
| `src/io/json.ts`, `src/io/persistence.ts` | **A** |
| `src/types/doc.ts` | **A** |
| `src/state/view.ts` | **B** |
| `src/layout/` (all) | **B** |
| `src/render/` (all) | **B** |
| `src/measure.ts` | **B** |
| `src/images/images.ts` | **B** |
| `src/input/pointer.ts` | **B** |
| `src/io/pdf.ts`, `src/io/html.ts` | **B** |
| `src/dom.ts`, `src/style.css` | **B** |
| `src/types/layout.ts` | **B** |
| `src/config.ts` | **frozen** — put new constants in your own module |
| `src/main.ts`, `src/state.ts`, `src/types.ts` | **frozen** after 0.4/0.6 |
| `docs/VERIFY.md` | **frozen** after 0.7 |
| `docs/PARALLEL-PLAN.md` | append-only, [handoff table](#handoff-requests) only |

`input/pointer.ts` goes to B deliberately: B4 changes every `clientY → document Y`
conversion in it when the canvas starts scrolling independently. It is the one B-owned file
that writes A-owned data — drag-select sets `state.selection` today. After step 0 it must go
through `setSelection()` (Contract 3) and never assign the field directly.

`io/pdf.ts` and `io/html.ts` go to B because they are renderers — they consume
`state.lines` and style runs exactly like `render/draw.ts` does.

---

## Track A — Document and editing

### A1. Style bytes, `applyEdit`, selection deletion
Roadmap step 1 · §4.5, §4.6

Replace `TextMark[]` with a per-paragraph `Uint8Array` behind the `model/runs.ts` accessor.
Route every mutation through `applyEdit(paraIndex, offset, deleteCount, insertText)`, which
splices text and style bytes together and calls `markParagraphDirty`. Implement
`deleteSelection()` and call it first in insert/backspace/delete. Fill in
`getSelectionRanges()` for the multi-paragraph case.

**Done when:** pressing Enter above a bold run leaves the bold on the same characters;
typing over a selection replaces it; `normalizeMarksForPara` is deleted; `getStyleRuns`
signature is unchanged.

### A2. Undo / redo
Roadmap step 2

Inverse-command stack recorded inside `applyEdit`, coalescing consecutive typed characters.
Ctrl+Z / Ctrl+Shift+Z wired in `input/keyboard.ts`.

**Done when:** 100 keystrokes undo in a handful of steps, not 100; undo restores styles and
cursor position, not just text.

### A3. IME composition
Roadmap step 7

`compositionstart` / `compositionupdate` / `compositionend` on the ghost input. Suppress
the `input` path while composing and expose the preedit string + range so B can render it.

**Requires** a handoff row: B must paint the preedit underline. Agree the accessor
(`getComposition(): { para, offset, text } | null`) before starting.

**Done when:** typing Japanese or Chinese through an IME produces correct text.

### A4. Clipboard
Roadmap step 7

`copy` / `cut` / `paste` writing `text/plain` plus a custom MIME carrying style bytes, so
formatting survives a round trip inside the editor. Ctrl+A select-all.

### A5. Autosave
Roadmap step 7

Debounced IndexedDB persistence with a recovery prompt on load. Uses
`serializeImages()` / `restoreImages()` from B's images module — do not reach into image
internals.

---

## Track B — Layout and rendering

Ordered so the first task has zero dependency on A.

### B1. Silhouette row spans and prefix sums
Roadmap step 6 · §4.7 — **start here, fully isolated**

Build `rowSpans: Int16Array(2 * h)` alongside the alpha map so `computeLineSlots` stops
rescanning pixels per line. Add prefix-summed character widths in `measure.ts` so substring
width is `prefix[b] - prefix[a]`.

**Done when:** dragging an image holds 60 fps on a 30k-char document, and the wrap ink check
in VERIFY.md is unchanged.

### B2. `rich-inline` line breaking
Roadmap step 3 · §4.1

Replace the dead `prepareWithSegments` call and the greedy fitter with
`prepareRichInline` + `layoutNextRichInlineLineRange`, feeding runs from `getStyleRuns()`
and threading the cursor across slots so both-sides wrap survives.

**Done when:** the multi-slot round-trip check passes (text complete and in order across
alternating slot widths, `gapBefore` applied at fragment boundaries), and CJK text breaks
per character instead of running off the line.

### B3. Incremental layout
Roadmap step 4 · §4.2 — **needs Contract 2 live, not A1 landed**

Per-paragraph layout cache keyed on `styleVersion`, `docWidth`, `yStart` and an obstruction
key. Classify paragraphs position-sensitive vs position-independent; translate the latter
instead of re-fitting. Early-exit the walk once the accumulated delta is zero. Consume
`takeDirty()`; fall back to a full pass on `'all'`.

**Done when:** the keystroke benchmark is flat rather than linear — target ≤2 ms at 67k
chars, down from 82 ms.

### B4. Virtualised painting and DOM caret
Roadmap step 5 · §4.3, §4.4

Canvas sized to the viewport inside a scrolling spacer; binary-search `lines` for the
visible band. Caret becomes a CSS-animated div. Update `input/pointer.ts` for the new
coordinate space.

**Done when:** a 100-page document renders at `devicePixelRatio` 2 without going blank, and
an idle editor does zero canvas work.

### B5. Page-aware line placement and caret metrics
Roadmap step 7

Push lines that would straddle a page boundary onto the next page. Make
`pixelToCursor` and vertical movement respect real line heights instead of assuming
`LINE_HEIGHT`, and add a sticky column. Remove the `MAX_LAYOUT_STEPS_PER_PARA` truncation.

### B6. Export fidelity
Roadmap step 7

PDF export currently positions text with jsPDF's Helvetica metrics while layout used
Georgia, so runs drift within the line. Embed the real font or drive the PDF from measured
fragment positions. Same page-straddle fix as B5 applies to both exporters. Add
`serializeImages()` / `restoreImages()` for A5.

---

## Contracts (frozen after step 0)

Both agents code against these. Changing a signature requires a handoff row and agreement.

| # | Module | Implemented by | Consumed by |
| --- | --- | --- | --- |
| 1 | `model/runs.ts` — `getStyleRuns`, `styleAt`, `styleVersion` | A | B |
| 2 | `model/dirty.ts` — `markParagraphDirty`, `takeDirty` | A | B |
| 3 | `model/selection.ts` — `getSelectionRanges`, `setSelection`, `clearSelection`, `setCursor`, `moveCursorToSelectionFocus`, `isCollapsed` | A | B |
| 4 | `layout/caret-position.ts` — `caretPixelPosition`, `pixelToCursor` | B | A |
| 5 | `layout/engine.ts` — `relayout`, `scheduleRelayout` | B | A |
| 6 | `images/images.ts` — `serializeImages`, `restoreImages`, `clearImages` | B | A |

## Sync points

Both branch from the step 0 commit. Merge in any order — with ownership respected there
should be nothing to resolve, and a conflict is a signal to re-read the ownership table.

| Sync | A has landed | B has landed |
| --- | --- | --- |
| 1 | A1 | B1 |
| 2 | A2 | B2, B3 |
| 3 | A3, A4 | B4 |
| 4 | A5 | B5, B6 |

At each sync point run `docs/VERIFY.md` end to end on the merged result. The both-sides
wrap check is the one that must never regress — it is the feature the whole architecture
exists to support.

## Handoff requests

Append only. Do not edit rows you did not write.

| From | To | File / contract | Request | Status |
| --- | --- | --- | --- | --- |
| A | B | `render/draw.ts` | Paint IME preedit underline from `getComposition()` (blocks A3) | open |
| A | B | `images/images.ts` | `serializeImages` / `restoreImages` for IndexedDB (blocks A5) | open |
| — | — | `model/selection.ts` | Contract 3 gained `setCursor` + `moveCursorToSelectionFocus`: `input/pointer.ts` (B) was writing `doc.cursor` directly | resolved in step 0 |
| B | A | `render/draw.ts` | IME preedit underline painted from `getComposition()` (B2–B6 landed) | resolved |
| B | A | `images/images.ts` + `io/persistence.ts` | `serializeImages`/`restoreImages` (Blob-based) + `addImageFromBlob` implemented in `images.ts`; `io/persistence.ts` (A) may swap its data-URL image path for them | implemented, awaiting wiring |
| B | A | `edit/ops.ts` | B5: `moveVertical` delegates to `layout/caret-position.ts` (`moveCursorVertical`: real line heights + sticky column); `moveLeft`/`moveRight` call `resetStickyX` | resolved in B5 (B edited A-owned file per B5 charter) |
| A | B | `render/draw.ts` | A3 landed (A): accessor is `getComposition(): { para, offset, text } | null` in `model/composition.ts` (A-owned), written by `input/keyboard.ts`. Paint the preedit underline at the caret from it. | A side done, B open |
| A | B | `images/images.ts` | A5 landed (A) but serializes images via `view.images` + `convertImageToDataURL` (same as `io/json.ts`) until Contract 6's `serializeImages`/`restoreImages` land; switch to them + Blob storage when ready. | A side done, B open |
