# Fix plan — the offset invariant, loop termination, silhouette taint

Three fixes, in priority order. All three are consequences of one change: since `00bc71f`
the `@chenglou/pretext` rich-inline engine really runs (before that its call threw on every
invocation into an empty `catch`, and the hand-rolled greedy fitter did 100% of layout). The
code around it still carries assumptions that were only true while it did nothing.

Findings 1 and 2 are **regressions** against the greedy fitter and are reproduced below with
measurements taken in the browser on `dev` @ `9a783fd`. Finding 3 is pre-existing.

Read `docs/BUGHUNT.md` first for what is already fixed — do not redo it. The items below are
not in that report.

---

## Ownership caveat — read before editing

Per the `PARALLEL-PLAN.md` ownership table, every file this plan touches is **B-owned**:

| File | Owner | Fix |
| --- | --- | --- |
| `src/layout/paragraph.ts` | **B** | 1 and 2 |
| `src/images/images.ts` | **B** | 3 |
| `src/types/layout.ts` | **B** | 3 (one optional field) |

If Track B is still live, open a handoff row in `PARALLEL-PLAN.md` instead of editing
directly. If the parallel phase is over (the last four commits are single-track bug fixes),
ignore this section and proceed. Either way, no A-owned file needs to change: `model/`,
`edit/`, `io/json.ts` and `io/persistence.ts` are correct as they stand — they consume
offsets, they do not produce them.

`src/main.ts`, `src/config.ts` and `docs/VERIFY.md` are frozen. The acceptance snippets below
therefore live in this document, not in VERIFY.md, unless the freeze is lifted.

---

## 0. The invariant that must hold

For every line the layout emits:

```
doc.paragraphs[line.paraIndex].slice(line.startOffset, line.endOffset) === line.text
```

This is not a nicety — it is load-bearing, and **every** downstream consumer already assumes
it, silently:

| Consumer | Assumption |
| --- | --- |
| `layout/caret-position.ts:29-30` | `line.text.slice(0, cursor.offset - line.startOffset)` |
| `layout/caret-position.ts:60-61` | index `i` into `line.text` maps to offset `startOffset + i` |
| `render/draw.ts:118-119` | selection slices `line.text` by document offsets |
| `render/draw.ts:156` | style runs slice `line.text` by `style.start - globalStart` |
| `io/html.ts:60`, `io/pdf.ts:57,82` | the same slicing, on export |
| `measure.ts:15` | width of `text` measured from `runCache` at `globalStart` |

With the greedy fitter the invariant held by construction: it emitted
`startOffset: pos, endOffset: pos + consumed` from a `text.slice(...)` of the document itself.
It does not hold today.

---

## Fix 1 — fragment offsets are in pretext's text space, not the document's (CRITICAL)

### Evidence

pretext normalizes: it collapses every run of two or more collapsible whitespace characters
into one, and trims whitespace at line edges. `layoutParagraph` maps fragments back onto the
document by accumulating fragment lengths — `paragraph.ts:206` and `paragraph.ts:231`:

```ts
const startOffset = meta.start + meta.trimStart + consumedInItem[frag.itemIndex]
...
consumedInItem[frag.itemIndex] += frag.text.length
```

That is only correct while `frag.text` is a verbatim slice of the item text.

Typed character by character into the running editor (real `input` events on the ghost
input), `"Ciao  mondo  con  spazi  doppi"` — 30 characters:

- the single emitted line has `text = "Ciao mondo con spazi doppi"` (26 chars) and
  `endOffset = 26`; the last 4 characters of the paragraph belong to no line;
- `caretPixelPosition()` returns **x = 194 for offsets 26, 29 and 30 alike** — the caret
  stops dead near the end of the line and the last characters are unreachable;
- `pixelToCursor(200, 8)` returns offset 26, not 30 — you cannot click to the end;
- character codes: document `...111,32,32,109...`, painted line `...111,32,109...` — the
  second space is not rendered at all;
- style runs land on the wrong glyphs, on the canvas **and** in the HTML and PDF exports,
  because all three slice `line.text` with document offsets.

A `<pre>` block from the HTML importer is hit hardest: `RICH-TEXT-MODEL.md` §8 promises
multi-space runs "preserved verbatim", `input/html-import.ts:187` does preserve them in the
model, and layout then collapses them.

### The fix

Map each materialized fragment back onto the paragraph text with an alignment walk that
encodes exactly what pretext's normalization does, and **paint the document slice**.

In `layout/paragraph.ts`, add:

```ts
/**
 * Map a materialized fragment back onto the paragraph text. pretext hands back the
 * *normalized* string — runs of collapsible whitespace collapsed to one, edges trimmed —
 * so a fragment index is not a document offset. One source character is consumed per
 * non-space fragment character, and the whole whitespace run per fragment space, which is
 * precisely the normalization being undone. Returns null when the two strings disagree
 * (a hyphen inserted at a break, a future normalization rule): the caller must then warn
 * and fall back rather than emit a line that breaks the offset invariant.
 */
function alignFragment(src: string, from: number, frag: string): { start: number; end: number } | null {
  let i = from
  // pretext folds the whitespace preceding a fragment into gapBefore.
  if (frag.length > 0 && !isWs(frag[0])) while (i < src.length && isWs(src[i])) i++
  const start = i
  for (let j = 0; j < frag.length; j++) {
    const fc = frag[j]
    if (isWs(fc)) {
      if (i >= src.length || !isWs(src[i])) return null
      while (i < src.length && isWs(src[i])) i++
    } else {
      if (src[i] !== fc) return null
      i++
    }
  }
  return { start, end: i }
}
```

Then, in the fragment loop:

1. Replace `consumedInItem` entirely with a single monotonic `searchPos` over the paragraph.
   Fragments arrive in flow order across slots and bands, so one cursor is enough.
2. `const a = alignFragment(text, searchPos, frag.text)`; on success set
   `startOffset = a.start`, `endOffset = a.end`, `searchPos = a.end`.
3. **Set `li.text = text.slice(a.start, a.end)`, not `frag.text`.** This is what makes every
   consumer in the table above correct again without touching a single one of them.
4. On `a === null`: `console.warn` once per paragraph with the fragment and the source
   window, then fall back to the current arithmetic. A wrong offset must be loud, never
   silent — a silent fallback is exactly how the dead pretext call survived for the life of
   the project.
5. `li.width` should be the painted width of the document slice, not `frag.occupiedWidth`.
   The prefix sums built in `computeRuns` already give it: sum `r.prefix[b] - r.prefix[a]`
   over the runs the range spans. Advance `x` by that same painted width, otherwise a
   following fragment on the same line overlaps the one before it.

Keep unchanged: `mat.width` for the alignment shift (`slot.width - mat.width`) and for the
justify slack — pretext's trimmed width is the right basis for both, because trailing spaces
paint nothing. `frag.gapBefore` still positions the fragment.

### Rejected alternatives, so they are not re-derived

- **Ask pretext for source offsets.** `LayoutCursor` is `{ segmentIndex, graphemeIndex }`
  (`dist/layout.d.ts:25`) and indexes the *prepared* text; `PreparedRichInline` is an opaque
  branded type with no `segments` field. There is no public mapping back to the input.
- **Turn collapsing off.** `PrepareOptions.whiteSpace` exists for the plain `prepare` API,
  but `RichInlineItem` is `{ text, font, letterSpacing?, break?, extraWidth? }` — rich-inline
  exposes no such option. Do not pass undocumented extra arguments to it.
- **Keep `line.text = frag.text` and add a per-line index map.** Correct, but it forces every
  consumer in the table above to map through it: strictly more work and more places to get
  wrong, for the same result.

### Residual, and the follow-up that removes it

Painting the document slice means a line whose text contains a collapsed run is painted
slightly wider than the width pretext broke it at — by the width of the extra spaces.
Bounded, and only for text with consecutive whitespace, but real: such a line can bleed a few
pixels past its slot next to an image.

The clean way to retire it is to stop putting collapsible runs in the model at all: when the
user types a space directly after a space, insert U+00A0 instead, which is what browsers do
in contenteditable. **Verified: pretext preserves `space + NBSP` pairs verbatim** — source and
fragment character codes both `32,160,...`, offsets 1:1. The same expansion at `<pre>` import
time would make §8's "verbatim" promise true.

That change lives in A-owned input code (`edit/ops.ts` / `input/keyboard.ts`) and is a product
decision about what typing two spaces means. **Out of scope here — raise it, do not do it.**
Fix 1 is required either way: it is the defence that keeps the invariant true regardless of
what reaches the model.

### Acceptance

```js
// paste in the console on a fresh load
(async () => {
  const { doc } = await import('/src/state/doc.ts');
  const { view } = await import('/src/state/view.ts');
  const cp = await import('/src/layout/caret-position.ts');
  const dm = await import('/src/model/document.ts');
  const eng = await import('/src/layout/engine.ts');
  const ta = document.querySelector('textarea.caret-input'); ta.focus();
  dm.resetDocument(); eng.relayout();
  for (const ch of 'Ciao  mondo  con  spazi  doppi') {
    ta.value = ch; ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  eng.relayout();
  const t = doc.paragraphs[0];
  const bad = view.lines.filter(l => t.slice(l.startOffset, l.endOffset) !== l.text);
  const covered = Math.max(...view.lines.map(l => l.endOffset));
  doc.cursor = { para: 0, offset: t.length };
  const xEnd = cp.caretPixelPosition().x;
  doc.cursor = { para: 0, offset: t.length - 4 };
  const xBefore = cp.caretPixelPosition().x;
  return { mustBeZero: bad.length, coveredMustEqual: [covered, t.length], caretMustDiffer: [xBefore, xEnd] };
})()
```

Pass: `mustBeZero === 0`, the two `coveredMustEqual` numbers equal, the two
`caretMustDiffer` numbers different. Today: `1`, `[26, 30]`, `[194, 194]`.

---

## Fix 2 — a whitespace-only paragraph spins ~1.7M iterations (HIGH)

### Evidence

`paragraph.ts:169` drives the band loop with `while (pos < text.length)`, where `pos` advances
in *document* space but only from fragments pretext actually emitted. A paragraph of nothing
but whitespace produces no fragment ever, so `pos` stays at 0 while `text.length` does not.
Both escape hatches miss it: `cursor` is still `undefined` (no range was ever returned), so
the `cursor.itemIndex >= nonEmptyItemCount` break at `paragraph.ts:250` cannot fire, and the
loop runs to the defensive `y - y0 > 1e7` guard at `paragraph.ts:251` — about 1.7 million
iterations, each one calling `computeLineSlots`.

Measured, same page:

| Paragraph | Layout time |
| --- | --- |
| `'Ciao mondo'` | 0.5 ms |
| `''` (empty) | 0 ms |
| `' '` (one space) | **177 ms** |
| three whitespace paragraphs in one document | **344 ms** |
| **pressing Enter with one `' '` paragraph in the document** | **105 / 170 / 135 ms** |

The last row is the one users feel. BUGHUNT's H1 fix makes every Enter a `markAllDirty()`, so
a single spacer line — a very ordinary thing to type — puts a ~150 ms stall on every
paragraph break, plus every resize, every image drag, and every restore from autosave.

### The fix

Three parts, all in `layoutParagraph`:

1. **Early return.** After building `itemMeta`, if `itemMeta.every(m => m.trimmedLen === 0)`
   the paragraph has no layable content: emit the single empty line the `text.length === 0`
   branch already emits (`paragraph.ts:122-134`) and return. Exact, and it removes the
   pathological case entirely.
2. **Drive termination off pretext, not off `pos`.** In the `!placed` branch, before pushing
   the band down, probe once at the widest region the paragraph may occupy
   (`regionRight - leftIndent`): if `layoutNextRichInlineLineRange(prepared, thatWidth, cursor)`
   returns `null` the flow is exhausted, and no narrower slot will ever place anything —
   break. Exact, one extra call per obstructed band. It subsumes the
   `cursor.itemIndex >= nonEmptyItemCount` check, which can go.
   Note that fix 1 does **not** make `pos` reliable: a paragraph ending in whitespace still
   leaves `pos < text.length`, because pretext trims it. `pos` is fine as a progress marker,
   it just cannot be the termination condition.
3. **Bound the runaway guard.** `1e7` is not a guard, it is a 1.7-million-iteration freeze.
   Nothing below the lowest image can obstruct anything, so bound it by the obstruction
   bottom: `max(im.y + im.h)` over loaded `view.images`, plus one `lineH`. Past that point, a
   band that placed nothing never will.

### Acceptance

```js
(async () => {
  const { doc, defaultBlockAttrs } = await import('/src/state/doc.ts');
  const eng = await import('/src/layout/engine.ts');
  const dirty = await import('/src/model/dirty.ts');
  const dm = await import('/src/model/document.ts');
  const bench = (paras) => {
    doc.paragraphs = paras.slice();
    doc.styleIds = paras.map(p => new Uint16Array(p.length));
    doc.blockAttrs = paras.map(() => defaultBlockAttrs());
    dirty.markAllDirty();
    const t0 = performance.now(); eng.relayout(); return Math.round(performance.now() - t0);
  };
  const spaceOnly = bench([' ']);
  const blank = bench(['']);
  doc.paragraphs = ['Primo paragrafo di prova', ' ', 'Secondo paragrafo di prova'];
  doc.styleIds = doc.paragraphs.map(p => new Uint16Array(p.length));
  doc.blockAttrs = doc.paragraphs.map(() => defaultBlockAttrs());
  dirty.markAllDirty(); eng.relayout();
  const enter = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    dm.applyEdit(2, 5, 0, '\n'); eng.relayout();
    enter.push(Math.round(performance.now() - t0));
  }
  return { spaceOnly, blank, enter };
})()
```

Pass: `spaceOnly` within a few ms of `blank`, every `enter` sample in single digits.
Today: `177`, `0`, `[105, 170, 135]`.

A whitespace-only paragraph must still occupy exactly one empty line of its own height —
check `view.lines` for it, and check that the caret can be placed inside it.

---

## Fix 3 — a tainted canvas silently drops the silhouette (MEDIUM)

### Evidence

`buildAlphaMapForImage` (`images.ts:263`) wraps `getImageData` in
`try { ... } catch (err) { // ignore }` (`images.ts:298`). For a cross-origin image without
CORS headers — which BUGHUNT's C1 fix deliberately keeps *displaying*, via the direct-URL
fallback at `images.ts:178` — `drawImage` taints the canvas and `getImageData` throws
`SecurityError`. `rec.alphaMap` is never assigned, `computeLineSlots` falls back to the
bounding box, and the text wraps a rectangle instead of the shape.

That is the feature the whole architecture exists for, degrading with no signal of any kind.
This one is code-traced, not reproduced in the browser — it needs a real no-CORS host, or the
deterministic simulation in the acceptance snippet below.

### The fix

- Do not swallow. In the `catch`: leave `rec.alphaMap` undefined, set a flag on the record
  (`silhouetteUnavailable?: boolean` on `FloatImage` in `types/layout.ts`), and `console.warn`
  once per image with the reason. `err instanceof DOMException && err.name === 'SecurityError'`
  distinguishes taint from a genuine bug — and a genuine bug must stay loud.
- Surface it where the user is: set `rec.wrapper.title` to a short explanation
  ("immagine remota senza CORS: il testo scorre attorno al rettangolo, non alla sagoma"), and
  mark the handle with a class if `style.css` can show it cheaply.
- **Do not "fix" this by setting `img.crossOrigin = 'anonymous'` on the fallback path.** On a
  host that sends no CORS headers that makes the image fail to load outright — the user loses
  the picture instead of the silhouette, which is strictly worse. The blob path in
  `addImageFromSrc` (`images.ts:163`) already covers every host that permits it.
- While in this function: the same `catch` currently also hides real programming errors. Once
  it warns, that is fixed too.

### Acceptance

```js
// deterministic taint simulation — no network needed. Drop an image in first.
(async () => {
  const im = await import('/src/images/images.ts');
  const { view } = await import('/src/state/view.ts');
  const proto = CanvasRenderingContext2D.prototype;
  const real = proto.getImageData;
  const realWarn = console.warn; const warns = [];
  proto.getImageData = function () { throw new DOMException('Tainted canvases may not be read', 'SecurityError'); };
  console.warn = (...a) => { warns.push(a.join(' ')); realWarn(...a); };
  try {
    const rec = view.images[0];
    if (!rec) return 'drop an image into the editor first';
    rec.alphaMap = undefined;
    im.buildAlphaMapForImage(rec);
    return { alphaMapMustBeUndefined: rec.alphaMap, flagMustBeTrue: rec.silhouetteUnavailable,
             warnedMustBeTrue: warns.length > 0, tooltip: rec.wrapper.title };
  } finally { proto.getImageData = real; console.warn = realWarn; }
})()
```

Pass: no alpha map, flag true, one warning, a non-empty tooltip. Then reload, drop a normal
image, and confirm the silhouette wrap still works — `VERIFY.md` §1 is the gate for that and
must still pass untouched.

---

## Definition of done

1. `npx tsc --noEmit && npm run build` clean.
2. The three acceptance snippets pass on a **fresh page load**, not after HMR. BUGHUNT's
   verification note is right that dynamic imports can return a second module instance after
   a hot update; on a cold load `await import('/src/state/doc.ts')` is the live singleton, and
   every measurement in this document was taken that way.
3. `VERIFY.md` §1 (both-sides wrap) still passes. It is the one that must never regress.
4. The offset invariant from §0 gets a permanent home, not just a probe: assert it in
   `layoutParagraph` behind `import.meta.env.DEV` and warn on violation. A one-off check that
   proved a bug is gone is not the same thing as a gate that keeps it gone.
5. Append a short "what changed" section to `BUGHUNT.md`, and record there that fixes 1 and 2
   were regressions introduced by the rich-inline migration in `00bc71f`, not pre-existing
   bugs. The distinction is the lesson: switching on an integration that never ran invalidates
   every assumption built while it did nothing.
