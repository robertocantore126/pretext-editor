# Roadmap

Ordered work plan. Rationale and design detail live in [ARCHITECTURE.md](./ARCHITECTURE.md);
section references below point there.

To run these steps as two parallel tracks with no shared files, see
[PARALLEL-PLAN.md](./PARALLEL-PLAN.md), which maps every step below onto Agent A
(document/editing) or Agent B (layout/rendering).

The ordering is deliberate: correctness first, because the data-loss bugs are the ones that
destroy a user's work, and because step 1 defines the shape every later step builds on.

---

## Step 0 — Module split ✅ done

Break `src/main.ts` (1,663 lines) into the module layout in §5. Pure structural change, no
behaviour change.

---

## Step 1 — Mutation chokepoint, style bytes, selection deletion

**Fixes:** §3.5, and the first three bullets of §3.6.

- Replace `TextMark[]` with a per-paragraph `Uint8Array` of style bits (§4.5).
- Introduce `applyEdit(paraIndex, offset, deleteCount, insertText)` as the only mutation
  path (§4.6). Text and style bytes splice together; paragraph splits and merges splice
  both arrays in lockstep.
- Implement `deleteSelection()` and call it at the top of insert/backspace/delete, so
  typing over a selection replaces it.
- Render multi-paragraph selections.

**Deletes:** `normalizeMarksForPara` and the mark-offset arithmetic.

**Why first:** every later step assumes a single mutation path, and this is where silent
data corruption currently lives.

---

## Step 2 — Undo / redo

**Fixes:** §3.6.

Inverse-command stack recorded inside `applyEdit`, coalescing consecutive typed characters
into one entry. Nearly free once step 1 exists.

---

## Step 3 — `rich-inline` line breaking

**Fixes:** §3.1.

Replace the dead `prepareWithSegments` call and the greedy fitter together, per §4.1.
Runs come from the style bytes; slots come from `computeLineSlots` unchanged. Thread the
cursor across slots so both-sides wrap keeps working.

**Verify:** a paragraph laid out through alternating slot widths must round-trip its text
in order, with `gapBefore` applied at fragment boundaries.

---

## Step 4 — Incremental layout

**Fixes:** §3.2. Target ~0.5–2 ms per keystroke at 67k chars, from 82 ms.

Per-paragraph layout cache with the obstruction-band classifier and early exit, per §4.2.

**Verify:** re-run the keystroke benchmark at 15.8k / 32.7k / 67.2k chars and confirm the
curve is flat rather than linear.

---

## Step 5 — Virtualised painting + DOM caret

**Fixes:** §3.3, §3.4.

- Canvas sized to the viewport inside a scrolling spacer (§4.3).
- Caret becomes a CSS-animated div (§4.4).

**Verify:** a 100+ page document renders at `devicePixelRatio` 2 without going blank, and
an idle editor does zero canvas work.

---

## Step 6 — Silhouette row spans + prefix sums

**Fixes:** image-drag frame cost.

- `rowSpans: Int16Array` built alongside the alpha map (§4.7).
- Prefix-summed character widths so substring width is `prefix[b] - prefix[a]`, used by
  caret positioning and selection rectangles.

---

## Step 7 — Remaining correctness work

**Fixes:** the rest of §3.6.

- IME: `compositionstart` / `compositionupdate` / `compositionend`, with inline preedit.
- Clipboard: `copy` / `cut` / `paste`, plain text plus a custom MIME carrying style bytes.
- Persistence: debounced IndexedDB autosave, images stored as `Blob` not data URL.
- Page-boundary-aware line placement, so lines never straddle a page break.
- Caret and vertical movement respect real line heights; add a sticky column.
- Remove `MAX_LAYOUT_STEPS_PER_PARA` truncation.

---

## Later, if still needed

A worker with `OffscreenCanvas` would move layout off the main thread. Steps 3–5 are
expected to make it unnecessary — there is no point moving work that has been deleted.

---

## Known defects fixed in passing

| Defect | Where | Status |
| --- | --- | --- |
| Raw `NUL` byte instead of `×` in the imported-image delete button | `addImageFromDataURL` | fixed in step 0 |
| ~80 lines duplicated between `addImageFromDataURL` and `addImageFromFile` | images | deduped in step 0 |
| `URL.revokeObjectURL` called on a `data:` URL | images | fixed in step 0 |
| PDF export measures with Helvetica metrics while layout used Georgia | `io/pdf.ts` | open, step 7 |
| `runCache` / `prepared` keyed by paragraph index, never pruned | layout | open, step 4 |
| Lines overlapping at a page break: `pushPastPageBoundary` moved a line down but `y += lineH` advanced from the pre-push `y`, so the paragraph reported a height short by the pushed gap and the next paragraph was placed on top of it | `layout/paragraph.ts` | fixed |
| First click jumped the page ~600px: `ghostInput.focus()` ran before `repositionGhostInput()`, so the browser scrolled the unpositioned textarea into view and every drag coordinate after it was wrong | `input/pointer.ts` | fixed in the step 0 handshake |
| Dead locals `prevStyle`, `baselineOffset`, `targetX` | layout, render, edit | removed |
| `clearImages()` left `selectedImageId` dangling | `images/images.ts` | fixed |
