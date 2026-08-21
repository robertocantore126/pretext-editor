# Bug hunt — pretext-editor (`dev` @ 6858d3c)

Adversarial, evidence-based review of the whole repository. Nothing was modified.
Severity is judged by real data-loss / corruption / wrong-render probability, not by style.

Evidence is cited as `file:line`. The implementation is the source of truth; docs
(ARCHITECTURE.md, RICH-TEXT-MODEL.md, PARALLEL-PLAN.md, VERIFY.md) were used only to
establish intended behaviour.

---

## CRITICAL

### C1 — Autosave silently dies after a non-CORS remote image is pasted (data loss)

Chain:

1. `input/html-import.ts` collects `<img src="https://…">`; `images.ts:addImageFromSrc`
   fetches it with `mode:'cors'`. When the server sends no CORS headers (most of the
   web), the fetch **rejects** and the `.catch` falls back to
   `createFloatImage(src, …)` (`images.ts:157`) — the remote URL is loaded directly, so
   the image **displays**.
2. The next autosave (`io/persistence.ts:73-75`) runs
   `convertImageToDataURL(im.img)` (`images.ts:26`): `canvas.drawImage` of a
   cross-origin image **taints the canvas**, and `canvas.toDataURL` throws
   `SecurityError`. The throw propagates through `Promise.all`, the whole save rejects,
   and `saveNow`'s `catch {}` (`persistence.ts:94`) swallows it.
3. The image stays in `view.images`, so **every subsequent autosave fails the same
   way, forever, with no user-visible signal**. On reload the recovery prompt offers the
   last good save; all edits made since the image was pasted are gone.

`convertImageToDataURL` has no try/catch and the taint is not checked anywhere.
`exportDocument` / `exportHTML` / `exportPDF` hit the same throw (they at least alert).

**Fix direction:** check `img.src` origin vs `location.origin` before canvas-copying, or
store the already-fetched Blob when the fetch succeeds (skip the canvas path entirely),
and never let one bad image veto the whole autosave.

### C2 — Style-only changes are never autosaved (data loss on reload)

`notifyEdits` is fired **only** from `applyEdit` (`model/document.ts:181,245`);
`subscribeEdits` is consumed **only** by persistence (`io/persistence.ts:201`).
But formatting does not go through `applyEdit`:

- `applySelectionMark` / `toggleHeadlineForPara` (`model/styles.ts:93-151`) mutate
  `doc.styleIds[i] = internStyle(…)` directly and call `markParagraphDirty` — no
  `notifyEdits`.
- `recordStyleEdit` (`edit/marks.ts`) — no notify.
- Style undo/redo (`edit/history.ts:124-127`) restores snapshots directly — no notify.

So: select text → **Grassetto** → wait past the 800 ms debounce → reload → the bold is
gone (the autosave still holds the pre-format `styleIds`). The format only survives if a
*text* edit happens afterwards. The same gap applies to style undo/redo. This is a direct
violation of the persistence invariant ("every mutation reaches storage").

**Fix direction:** emit a generic `docChanged` hook from `markParagraphDirty` consumers,
or have `marks.ts`/`history.ts` notify a shared "state changed" subscriber.

---

## HIGH

### H1 — Stale layout after a net-zero split/merge (select across a line break, press Enter)

`applyEdit` invalidates with `if (paras.length !== parasBefore) markAllDirty() else
markParagraphDirty(p)` (`model/document.ts:169-170`). When a selection spanning **exactly
one** paragraph boundary is replaced by a single `\n` (select across a break → Enter), the
delete phase merges two paragraphs (−1) and the insert phase splits back (+1): net count
unchanged → only `markParagraphDirty(p)`.

The paragraph at index `p+1` is now a **different paragraph** (new content, same index).
Its layout version is `paragraphVersion(p+1) = max(lastChangedAt.get(p+1), allChangedAt)`
(`model/dirty.ts:28`); the old `p+1`'s recorded version still matches (no `markAllDirty`
bumped `allChangedAt`), so `layout/engine.ts` `mustRefit` (`cached.version !== version`)
is **false**, `cached.yStart === y` matches, and the **old paragraph's cached lines are
reused verbatim** — the screen shows the pre-edit text for `p+1` while
`doc.paragraphs[p+1]` holds the new text. `runCache` (`layout/cache.ts`, never pruned,
written only by `computeRuns`, `layout/paragraph.ts:45`) is stale for the same paragraph,
so caret/selection/measure (`measure.ts`, `layout/caret-position.ts`) also use the old
char widths. The stale render persists until any count-changing edit or an undo.

Reproduction (manual): type in paragraph 2 so it has a cached layout; drag-select from
mid-paragraph 1 across the break into paragraph 2; press Enter; paragraph 2 keeps
rendering its old text.

**Fix direction:** `markAllDirty()` whenever the edit *touches a boundary* (crossed a
`\n` in the delete, or `insertText` contains `\n`), not only when the net count changes.

### H2 — Image moves / resizes / deletes are not autosaved (data loss on reload)

The drag handler mutates `rec.x/rec.y/rec.w/rec.h` directly (`images.ts:293,297`) and
only calls `scheduleRelayout()`; `deleteImage` splices `view.images` and relayouts.
None of these mark anything dirty or call `notifyEdits`, so persistence never fires.
Move or resize an image, or delete one, then reload → the geometry snaps back to the last
text-edit save (or the image reappears). Images are also completely absent from the
undo/redo system (create/move/resize/delete are not undoable), so the history invariant
"history corresponds exactly to mutations" is broken for the image channel.

### H3 — JSON export drops `blockAttrs` (round-trip data loss)

`exportDocument` (`io/json.ts:46-50`) serializes `version / paragraphs / styleTable /
styleIds / images` — **no `blockAttrs`** (the `RichSerializedDocument` type has no such
field). `importDocument` resets `doc.blockAttrs = paragraphs.map(() =>
defaultBlockAttrs())` (`io/json.ts:76`). Heading kinds, alignment, indents, spacing,
list markers, `direction`, `whiteSpace` are silently lost on **Export JSON → Import
JSON**. The IndexedDB autosave *does* persist `blockAttrs` (`io/persistence.ts:78`), so
the two persistence paths disagree about what "the document" is.

---

## MEDIUM

### M1 — HTML import silently drops empty blocks

`closeBlock` keeps only `pending.text.length > 0` blocks (`input/html-import.ts`), and
the `<pre>` line-expansion skips `part.length === 0`. Pasted `<p></p>`, `<li></li>` and
blank lines inside `<pre>` disappear, so a document whose blank lines matter (spacing,
list structure) does not round-trip. Not listed in the §8 degradation table.

### M2 — Pasted block attributes overwrite the paragraph they are glued into

`importHTML` assigns `doc.blockAttrs[rec.paraIndex + i] = expanded[i].attrs`. When the
first imported block lands mid-paragraph (caret inside text), the *whole* paragraph —
including the pre-existing text before the caret — takes the imported block's attributes.
Observed live: `…paragrafo giustificato` + pasted `Titolo` merged into one paragraph that
then rendered entirely as a heading.

### M3 — `letterSpacing` is measured one way and painted another

`layout/paragraph.ts` passes `letterSpacing` to pretext (`RichInlineItem`), which widens
each glyph when breaking. But `computeRuns` (`paragraph.ts:26-35`), `draw.ts`
(`measureCtx.measureText`), and `measure.ts` all measure **without** letter-spacing
(canvas `measureText` has no letter-spacing property). Every consumer after the layout
then disagrees with pretext's widths: the painted text ends short of the slot, the
justify slack is computed from the wrong natural width, and the caret lands off the
glyphs. Only affects styles with `letterSpacing ≠ 0` (imported HTML), but it is a real
invariant break between layout and paint.

### M4 — `direction` (RTL) is stored but never consumed

The importer sets `BlockAttrs.direction` (`input/html-import.ts`), but `layout/paragraph.ts`
and `draw.ts` never read it; pretext's bidi is never invoked. RICH-TEXT-MODEL.md §7
claims RTL "comes along without new layout work" — the code does not do it; pasted
Arabic/Hebrew renders LTR. The field is dead.

### M5 — Multi-paragraph selection + headline button is inconsistent

`toggleHeadlineForPara` (`model/styles.ts:140`) only handles a selection whose
anchor/focus share a paragraph; a multi-paragraph selection silently falls back to the
cursor's whole paragraph, while `applySelectionMark` handles multi-paragraph selections.
Same toolbar row, different semantics.

### M6 — IME: Enter-to-confirm may leak a stray newline

During composition, `keydown` returns without `preventDefault` (`input/keyboard.ts`).
When the user confirms the preedit with Enter, `compositionend` inserts the text and
clears `ghostInput.value`, and `suppressNextInput` swallows exactly one trailing `input`
event. If the browser also performs Enter's default newline insertion afterwards, a
second `input` event arrives after the flag is consumed and inserts a stray `\n` into the
document. Browser-dependent; needs a manual check on Windows IME.

### M7 — `convertImageToDataURL` on a not-yet-loaded image saves a blank

Autosave within the window between image creation and `load` draws a 0×0 canvas and
stores an empty PNG (`images.ts:26`); after restore the image is blank. No `loaded`
guard in `saveNow` / `exportDocument`.

### M8 — One oversized image kills autosave via quota (silent)

Images are persisted as base64 data URLs (1.33× expansion) inside a single IndexedDB
`put` (`io/persistence.ts:65-91`). A multi-MB pasted image can exceed the storage quota;
`put` rejects, `catch {}` swallows, and again every later save fails silently (same
failure mode as C1).

### M9 — Undo/redo does not restore the caret

`applyEdit` always lands the cursor at the end of the replayed edit
(`model/document.ts:196`), so undoing a multi-paragraph operation leaves the caret at the
end of the restored text rather than where it was before the edit. Cosmetic-ish, but it
also means undoing *while* a selection was active loses the selection silently.

### M10 — Selection paint ignores justification spread

`draw.ts` paints the selection rectangle with `measureTextWidthOnPara` (natural widths);
on justified lines the purple background stops short of the spread words. Cosmetic.

### M11 — `alphaMap` is not rebuilt on resize

`buildAlphaMapForImage` runs once on load. After a grip resize (`images.ts:297`) the
silhouette row-spans are re-scaled to the new box but keep the pre-resize shape, so the
text wrap tracks a stale silhouette until reload/re-import.

### M12 — Import of a corrupt JSON can corrupt the model

`importDocument` assigns `doc.paragraphs = json.paragraphs` without validating that
elements are strings, and never clamps `styleIds` lengths to the text. A crafted file
(with non-string paragraphs, or `styleIds` shorter/longer than the text) flows into
`applyEdit` offsets, `splice` math and `getStyleRuns` — mostly tolerated by
`?? 0` fallbacks, but NaN offsets are reachable (`paras[p].length` on a number).

---

## LOW / NOTES

- **Composition state not cleared on reset** — `setComposition` is module state; a
  `resetDocument` mid-composition leaves a stale preedit that `draw.ts` keeps underlining.
- **`emptyStyle()` on out-of-range `styleAt`** — the composition underline at the end of a
  paragraph measures with the default font instead of the inherited style.
- **`Ctrl+A` moves the selection but not the caret** — after select-all, the caret stays
  where it was (paint shows caret inside the selection).
- **`sameStyle` (`model/runs.ts`) appears dead** — grep finds no callers.
- **`serializeImages` / `restoreImages` (`images.ts`) are dead code** — persistence uses
  `convertImageToDataURL`/`addImageFromDataURL`; the two Blob paths are never called.
- **`PARA_GAP` double-spacing with imported margins** — the engine adds `PARA_GAP`
  between every paragraph on top of imported `spaceBefore/spaceAfter`; imported headings
  render with a fixed 8 px gap plus their own margin.
- **Paste of a web image (image/png + text/html) imports only the image** — the keyboard
  handler `preventDefault`s and returns, dropping the rich HTML from the same clipboard.
- **Blockquote indent not accumulated into inner paragraphs** — a `<blockquote><p>` loses
  the quote's margin on the inner `<p>` (only the direct blockquote block gets it).

---

## What was checked and is healthy

- `applyEdit` style-id splicing (split/merge, multi-boundary deletes, style inheritance at
  the insertion point) — correct for the count-changing cases; the net-zero hole is H1.
- Undo/redo text entries replay through `applyEdit` (dirty tracking stays correct);
  coalescing math (`concatU16`, `constantId`) is sound.
- `selectionDeleteSpec` / `getSelectionRanges` (empty middle paragraphs preserved).
- The HTML walker's two §3 traps (decoration accumulation, background precedence) and the
  inline style leak fix — all verified live earlier.
- Justify paint pass (per-slot gap distribution, last-line exclusion) and the exporters'
  painted-width math agree with the layout's `justifyGap`/`justifyOffset`.
- Obstruction/alpha-map slot computation and the incremental-layout early-exit validation.

---

## Verification note

Live confirmation was attempted for H1/C2 against the running dev server, but the preview
bridge serves duplicate module instances after HMR (`ops.doc !== import('/src/state/doc.ts').doc`),
so model-state assertions through dynamic imports are unreliable in this environment; the
reported items are traced from code with exact line references instead.
