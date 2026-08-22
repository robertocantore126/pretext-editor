# Lazy layout — plan for the next agent

Goal: stop paying for the whole document on every edit. Today `relayout()` visits every
paragraph on every pass. At 2,579 pages that is 39,914 visits for one keystroke, and the
work that cannot be skipped inside those visits is what is left of the latency.

This document is written to be executed without reading the whole codebase first. Read
`docs/DIAGNOSTICS.md` §3 for the measurements it starts from, and keep this file open while
working: every stage ends with a gate you must actually run.

---

## 0. Where things stand, in numbers

Measured on 2,579 pages / 39,914 paragraphs / 6.96M characters / 400 images / 90,055 lines
(`pretextStress.run({ pages: 2000, images: 400, sections: 20, seed: 7 })`):

| Operation | Now |
| --- | --- |
| Idle pass (nothing dirty) | 6.8–9.5 ms |
| Typing one character | 6.6–10.4 ms |
| Enter, typical | 30–108 ms |
| **Enter, worst case** | **1.2 s** |
| First layout of the document | ~5.7 s |

The worst case is the target. Its cause is known and measured, not guessed: pressing Enter
near the top shifts everything below by a non-page amount, and every paragraph that *touches*
a page boundary must then be re-broken, because B5's rule pushes a line that would straddle
the boundary onto the next page. That is about two paragraphs per boundary — ~4,800 of them
at this size.

The trace tells you this directly. Every `layout` event carries `refits`, `refitReasons` and
`translations`; a pass that re-breaks 4,800 paragraphs with `refitReasons.page` high is the
one being described here. **Use that instrumentation instead of reasoning about the code**:
it was added precisely because a duration alone does not say what was expensive.

---

## 1. The rule the whole plan rests on

Line breaking is expensive. Line *placement* is arithmetic.

`layoutParagraph` does two different things in one pass:

1. decides where the text breaks — calls into pretext, measures glyphs, walks obstruction
   slots. This depends on the text, the styles, the column width, and on the images that
   overlap the paragraph's band;
2. decides where each broken line sits — adds `lineH`, and pushes a line past a page
   boundary when it would straddle one. This depends only on the paragraph's y.

Everything below is about not doing (1) when only (2) changed.

---

## 2. Stage A — re-place instead of re-break (do this first)

This is the smallest change that removes most of the 1.2 s, and the later stages need it
anyway.

**When it applies.** A paragraph whose cached layout is valid in every respect except its y,
*and* whose band is not overlapped by any image, either before or after the move. With no
image in the band, `computeLineSlots` returns the full column at every y, so the breaks
cannot depend on where the paragraph sits. The only y-dependence left is the page push.

**What to do.** Add to `layout/paragraph.ts`:

```ts
/**
 * Re-place a paragraph's cached lines at a new y without breaking it again.
 * Only valid when nothing that decides the breaks has changed — see the caller's
 * guard. Returns the new height, and mutates the lines' yTop in place (the
 * engine's translate path already relies on in-place movement; cloning here
 * would leave the cache disagreeing with itself, which is docs/BUGHUNT.md's
 * overlap bug all over again).
 */
export function replaceParagraphLines(lines: LineInfo[], startY: number, attrs: BlockAttrs): number
```

It walks the cached lines in order, applying `pushPastPageBoundary` exactly as
`layoutParagraph` does, and returns `y - y0 + attrs.spaceAfter` the same way. Lift the push
helper so both use one copy — two implementations of the same rule will diverge.

In `layout/engine.ts`, in the branch that currently decides `mustRefit`: when the only
failing condition is `paginationChanged`, and `imagesNear(...)` reports nothing overlapping
the band at either the old or the new y, call the re-place path instead of `layoutParagraph`.

**Gate.** A differential one, and it is not optional:

```js
// same document, same y: re-placing must produce exactly what re-breaking produces
pretextStress.compareReplaceAgainstRefit(500)   // you will write this
```

For 500 randomly chosen paragraphs, lay out the paragraph both ways at the same y and assert
the resulting lines are equal in `text`, `startOffset`, `endOffset`, `x`, `yTop`, `height`.
Any difference means the guard is wrong, not that the comparison is too strict.

Then re-run the standard checks (§6). Expect the worst-case Enter to drop by roughly the
ratio of boundary-touching paragraphs that have no image near them — on the reference
document, most of them.

---

## 3. Stage B — a height index

Every pass currently walks from paragraph 0 to accumulate `y`. Even when no paragraph is
re-broken, that is 39,914 iterations. To place a paragraph without walking, the engine needs
`yOf(paragraphIndex)` in better than linear time.

Add `src/layout/heights.ts`:

```ts
/**
 * Prefix sums over paragraph heights, as a Fenwick tree: yOf(i) and
 * paragraphAtY(y) in O(log n), setHeight(i, h) in O(log n). Splices (paragraph
 * inserted or removed) rebuild the affected suffix — model/dirty.ts already
 * reports them, see how layout/cache.ts consumes takeShifts().
 */
export function setHeight(paraIndex: number, height: number): void
export function yOf(paraIndex: number): number
export function paragraphAtY(y: number): number
export function totalHeight(): number
export function spliceHeights(at: number, removed: number, inserted: number): void
```

Two details that will bite otherwise:

- **`PARA_GAP` and section folds are part of the offset, not of the height.** Decide once
  where they live — cleanest is to store, per paragraph, the height *plus* whatever gap
  precedes it, so `yOf` is a pure prefix sum. A section fold (`docs/TABS.md`: a tab starts on
  a fresh page) makes that gap depend on the accumulated y, which a prefix sum cannot express
  on its own. Handle folds by storing the fold's padding as part of the section-opening
  paragraph's entry, recomputed whenever the y it lands at changes.
- **The index must be updated in the same place the caches are re-keyed**, next to
  `shiftCaches`/`shiftImageAnchors` in `relayout`. Three structures keyed by paragraph index
  now; a fourth that forgets to follow a splice is the bug from commit `239b1a2` again.

**Gate.** `yOf(i)` must equal the y the eager walk produces, for every i, on the reference
document. Write it as a loop comparing against a full pass. Cheap, and it is the only way to
know the fold accounting is right.

---

## 4. Stage C — materialize only what is near the viewport

Now the actual laziness.

**Model.** Each paragraph is in one of two states:

- **materialized** — real lines in `paraCache`, real measured height;
- **estimated** — no lines, height from `estimateHeight()` (already in `engine.ts`).

`relayout()` materializes the paragraphs whose band intersects
`[scrollTop - MARGIN, scrollTop + viewportHeight + MARGIN]`, with `MARGIN` one or two
viewports, plus any paragraph in the dirty range. Everything else keeps its estimate.
`view.lines` holds only materialized lines.

**Scrolling** must trigger a pass: `render/viewport.ts` already listens to scroll for
repainting — it now also has to materialize the incoming band before painting it.

**The estimate is a lie you must tell carefully.** When a paragraph above the viewport is
materialized and its real height differs from its estimate, everything below moves — the
content under the reader's eyes included. Correct it in the same frame:

```ts
// after materializing a band that lies above the current scroll position
docWrap.scrollTop += measuredHeightTotal - estimatedHeightTotal
```

Get this wrong and the document creeps or judders while scrolling up, which reads as a
much worse bug than the one being fixed.

**Consumers that assume `view.lines` is the whole document.** This is the complete list; each
one has to be dealt with explicitly:

| Consumer | What it needs |
| --- | --- |
| `render/draw.ts:45,124` | visible lines only — already correct, no change |
| `layout/caret-position.ts:15,42,44,54,55` | materialize the target paragraph before answering; `lineForCursor` and `pixelToCursor` must never return "not found" just because a paragraph is far away |
| `layout/coords.ts:38` (`paragraphTop` fallback) | use `yOf()` from Stage B instead of scanning lines |
| `io/html.ts:54`, `io/pdf.ts:317` | call `materializeAll()` first — an export is the whole document by definition |
| `debug/stress.ts` checks | they iterate `view.lines`; they now check only what is materialized, which is correct, but say so in their names or comments |

Add `export function materializeAll(): void` to the engine — the eager path, kept alive on
purpose. Do **not** delete the old full-walk code; it becomes both the export path and the
oracle for the gate below.

**Sections and images with estimates.** A tab's fold position and an image's anchored y both
come from `yOf(anchorPara)`, which is available from the height index without materializing
anything. They will be approximate while the paragraphs above are estimates, and exact once
those are measured. That is acceptable — but the tab panel's scroll target
(`edit/sections.ts: goToSection`) must materialize as it lands, then correct the scroll the
same way, or clicking a far tab drops you in the wrong place.

**Gate.** The differential harness, and this is the one that decides whether the stage is
done:

```js
// lazy vs eager must agree wherever lazy has an opinion
pretextStress.compareLazyAgainstEager()   // you will write this
```

Build the reference document, run `materializeAll()`, snapshot every line. Reload the same
document, scroll to N random positions, and at each one assert that every materialized line
is identical to the snapshot — same text, offsets, x, yTop, height — and that `docHeight`
after full materialization equals the eager `docHeight` exactly.

---

## 5. What not to do

- **Do not delete the eager path.** It is the exporter's path and the oracle for the gate.
- **Do not touch `src/io/pdf.ts`, `docs/RICH-TEXT-MODEL.md`, `scripts/verify-*.mjs` or
  `src/io/fonts/`.** Another agent is working on PDF fidelity and font embedding in the same
  tree, uncommitted. Coordinate or wait; do not "fix" its compile errors.
- **Do not weaken the offset invariant** (`docs/FIXPLAN.md` §0). Lazy or not, every line the
  layout emits must satisfy
  `doc.paragraphs[line.paraIndex].slice(line.startOffset, line.endOffset) === line.text`.
- **Do not replace estimates with a smarter formula as a substitute for measuring.** A better
  estimate reduces the scroll correction; it never removes the need for it.
- **Do not report a speed-up from a number you did not measure with the harness.** Timings in
  this project have been wrong twice by measuring the wrong operation — see the note at the
  end of `docs/DIAGNOSTICS.md`.

---

## 6. The gates that must pass at every stage

```bash
npx tsc --noEmit --noUnusedLocals && npm run build
```

In the browser, on a document built by the harness:

```js
const r = await pretextStress.run({ pages: 200, images: 40, sections: 8, seed: 7 })
r.checks   // every field must be zero / empty
pretextStress.fuzz(300, 5).failures   // must be []
```

`checks` covers: the offset invariant, paragraphs overlapping each other, click-to-caret
landing on the line it was aimed at, images sitting where their anchor says, the obstruction
index agreeing with a full scan, and tabs starting on a page boundary.

Plus `docs/VERIFY.md` §1 — text flowing down **both** sides of an image. That is the feature
the whole architecture exists for; if it breaks, stop.

---

## 7. Definition of done

1. Every gate in §6 green, plus the two differential gates from §2 and §4.
2. On the reference document (2,000 pages, 400 images): worst-case Enter **under 100 ms**,
   idle pass **under 5 ms**, first layout **under 1 s** (only the visible window is broken;
   the rest is estimated).
3. Scrolling from the top to the bottom of that document and back leaves the caret on the
   same character and the same text under the pointer — measured, not eyeballed.
4. `docs/DIAGNOSTICS.md` §3 updated with the new numbers, in the same before/after shape.
5. A short section appended to `docs/ARCHITECTURE.md` describing the two paragraph states and
   who is allowed to assume `view.lines` is complete.
