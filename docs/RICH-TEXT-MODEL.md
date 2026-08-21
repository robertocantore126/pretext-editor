# Rich text model and HTML import

How pasted HTML becomes editable formatted text. Specifies the document model this
requires, and the import pipeline that fills it.

Related: [ARCHITECTURE.md](./ARCHITECTURE.md) for the layout engine,
[PARALLEL-PLAN.md](./PARALLEL-PLAN.md) for module ownership and contracts,
[ROADMAP.md](./ROADMAP.md) for sequencing.

## 1. Goal

Paste formatted content from a web page, Word, or Google Docs and get something that
looks as close to the original as we can represent — the way draw.io behaves.

The pipeline is:

```
HTML  →  rich-text model  →  pretext  →  renderer
```

and explicitly **not**:

```
HTML  →  flattened text  →  pretext
```

pretext keeps owning line breaking and layout. The model has to be rich enough to carry
everything the HTML gave us, and to hand pretext exactly what it expects.

Two hard constraints bound this design: **pretext behaviour is frozen** — it keeps
deciding where lines break and how wide the natural line is; everything else is paint or
slot geometry on its output — and **the image system is frozen** — images stay floating
boxes with silhouette wrap, drag/resize and the existing persistence; a paste never
inserts an image into the text flow (§6.4).

### The contract

**The model's expressiveness is the contract.** Anything the model can represent must
survive a paste. Anything it cannot must degrade *predictably*, in a way written down in
§8 — never silently and never arbitrarily.

We do not promise 100% CSS fidelity. Dirty markup from a browser is expected. What is
forbidden is throwing away information we were capable of holding.

## 2. Do not write a parser

There is no HTML parser and no CSS cascade engine in this design. The browser already is
both.

Inject the pasted markup into an **offscreen shadow root** and read `getComputedStyle()`
on each node. The browser returns the cascade **already resolved**: inheritance, author
stylesheets, classes and inline styles all applied, with units normalised.

Measured against Google-Docs-shaped markup (classes plus a `<style>` block, not just tags):

```
.c1 { font-family:"Times New Roman"; font-size:18pt; color:#b30000 }
.c2 { background-color:#ffff00; font-weight:700 }

<span class="c1">Titolo <span class="c2">evidenziato</span></span>

  .c1  →  family "Times New Roman, serif"   size 24px   color rgb(179,0,0)
  .c2  →  family "Times New Roman, serif"   size 24px   color rgb(179,0,0)
          weight 700   background rgb(255,255,0)
```

Classes resolve, inheritance works, `18pt` becomes `24px` on its own. The `<style>` block
does **not** leak into the host page — verified, the shadow root scopes it.

### Structure comes from `display`, not from tag names

This is what makes "no limited tag whitelist" achievable. Measured:

| Element | `display` | other resolved values |
| --- | --- | --- |
| `<p class="c3">` | `block` | `text-align: center`, `margin-top: 18px` |
| `<li>` | `list-item` | `margin-left: 40px` |
| `<blockquote>` | `block` | `margin-left: 40px`, `margin-top: 16px` |
| `<pre>` | `block` | `white-space: pre`, `font-family: monospace` |
| `<custom-tag style="display:block; text-indent:30px">` | `block` | `text-indent: 30px` |

An unknown element behaves correctly because we never ask what it is called — we ask how it
computes. Indentation likewise arrives from margins and padding rather than from knowing
that `<blockquote>` means "indent".

## 3. The two properties the browser will not resolve for you

Everything arrives resolved **except** two properties that propagate visually but are not
inherited. Both must be accumulated by hand while walking down the tree.

**`text-decoration`.** Measured: `<u>` reports `text-decoration-line: underline`, but
`<u><em>` reports **`none`**. Reading the computed value on the text node's parent loses
every underline and strikethrough that was set on an ancestor.

**`background-color`.** Not inherited by definition, so a node inside a highlighted span
reports `rgba(0, 0, 0, 0)`.

Carry both on the walker's context stack (§6.4). They are the only two exceptions; do not
generalise the workaround to other properties.

## 4. The model

### 4.1 Inline style, interned

One entry per distinct character-level style, referenced by a small integer id:

```ts
interface InlineStyle {
  fontFamily: string          // full CSS stack, as computed
  fontSize: number            // px
  fontWeight: number          // 100-900
  italic: boolean
  underline: boolean
  strike: boolean
  color: string
  background: string | null   // null = transparent
  letterSpacing: number       // px, 0 for 'normal'
  baseline: 'normal' | 'super' | 'sub'
  linkHref: string | null
}
```

Interning key: a stable serialisation of the normalised fields. A pasted document has tens
of distinct styles, not thousands, so the per-character cost stays flat.

The interned payload is effectively a **font string**: the type fields above are normalised
once at intern time and concatenated into the full CSS `font` shorthand pretext consumes
(e.g. `700 italic 17px Georgia, serif`). The paint-only fields (`color`, `background`,
`underline`, `strike`) and `linkHref` never affect metrics, so they are not part of the
pretext-facing payload and must not invalidate its cache key.

```ts
styleIds: Uint16Array         // parallel to the block's text, one id per character
```

65 536 distinct styles per document is far beyond real content; on overflow, reuse the
nearest existing style rather than failing the paste.

This replaces today's `Uint8Array` of four style bits (`ARCHITECTURE.md` §4.5). The
splice-in-lockstep property that makes `applyEdit` correct is preserved exactly — only the
element width changes.

### 4.2 Block attributes

```ts
interface BlockAttrs {
  kind: 'paragraph' | 'heading' | 'listItem' | 'preformatted'
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6
  align: 'left' | 'center' | 'right' | 'justify'
  indentLeft: number
  indentRight: number
  indentFirstLine: number
  spaceBefore: number
  spaceAfter: number
  lineHeight: number | null   // null = use the font's default
  list?: { type: 'bullet' | 'number'; level: number; marker: string }
  whiteSpace: 'normal' | 'pre'
  direction: 'ltr' | 'rtl'    // pretext carries segLevels + bidi; see §7
}
```

There are no paragraph-level attributes in the current model at all, so this is new
structure rather than a widening.

### 4.3 The block

```ts
interface Block {
  attrs: BlockAttrs
  text: string
  styleIds: Uint16Array       // length === text.length
}

doc.blocks: Block[]           // replaces doc.paragraphs + doc.styles
```

There is deliberately **no inline-object channel in the model**. Images stay in the
floating-image system (§6.4) and never enter the text flow, and nothing else needs an
inline atom today. `applyEdit` must splice `text` and `styleIds` together, exactly as it
splices text and style bytes today.

### 4.4 What this does not disturb

Layout, rendering and both exporters read styles only through **Contract 1**
(`getStyleRuns` / `styleAt` in `model/runs.ts`). Widening the representation therefore
touches `model/runs.ts`, `model/styles.ts`, `model/document.ts` and persistence — and no
B-owned file. That seam is what makes this change affordable; it stops being affordable the
moment anything reads style bytes directly.

## 5. Worked example

```html
<p style="text-align:center; margin-top:18px">
  <span style="font-family:Georgia; font-size:24px; color:#b30000">Titolo
    <span style="background:#ff0">evidenziato</span></span>
</p>
<ul><li>primo</li><li>secondo</li></ul>
```

becomes

```
Block 0  attrs { kind:'paragraph', align:'center', spaceBefore:18 }
         text  "Titolo evidenziato"
         ids   [1,1,1,1,1,1,1, 2,2,2,2,2,2,2,2,2,2,2]
                └ style 1: Georgia 24px #b30000
                            └ style 2: same + background #ffff00

Block 1  attrs { kind:'listItem', list:{ type:'bullet', level:0, marker:'•' },
                 indentLeft:40 }
         text  "primo"
Block 2  attrs { kind:'listItem', list:{ type:'bullet', level:0, marker:'•' },
                 indentLeft:40 }
         text  "secondo"
```

## 6. The import pipeline

### 6.1 Overview

```
paste event
  → clipboardData.getData('text/html')          (fall back to text/plain)
  → DOMParser.parseFromString(html, 'text/html')   inert: no scripts, no image loads
  → sanitize                                       §6.2
  → import into offscreen shadow root              §6.3
  → TreeWalker + context stack                     §6.4
  → Block[] + interned styles
  → applyEdit at the cursor
```

### 6.2 Sanitisation

Run this on the inert document, **before** importing into the live DOM.

Remove: `<script>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<base>`,
form controls. Remove every `on*` attribute. Remove `href`/`src` values whose scheme is
`javascript:` or `data:text/html`.

Keep `<style>`: it carries the formatting we are trying to preserve, and the shadow root
scopes it (§2).

`DOMParser` output is inert, so nothing executes during parsing. But once the subtree is
attached to the live document, `<img onerror>` becomes live — hence "before the import,
not after".

### 6.3 The offscreen host

```css
position: fixed;
left: -99999px;
top: 0;
width: <current document width>;   /* so % margins and text-indent resolve sensibly */
visibility: hidden;                /* NOT display:none */
```

`display: none` suppresses layout, and layout-dependent computed values stop resolving.
`visibility: hidden` keeps the box tree alive while staying invisible.

Attach a shadow root to the host and import the sanitised nodes into it. Tear the host down
when the walk finishes.

### 6.4 The walk

A `TreeWalker` over elements and text nodes, carrying a context stack:

| Carried on the stack | Why |
| --- | --- |
| `underline`, `strike` | `text-decoration` does not inherit (§3) |
| `background` | not inherited (§3) |
| list type, level, item counter | `<ol>` numbering needs an ordinal per level |
| `whiteSpace` | decides whitespace collapsing for descendants |
| `linkHref` | nearest enclosing `<a>` |

For each element, `getComputedStyle` gives everything else directly.

**Block boundaries.** Open a new block whenever `display` is `block`, `list-item`,
`table-cell`, `flex`, `grid`, or anything that is not `inline`/`inline-block`. Close it when
the element ends. `inline` and `inline-block` never break a block.

**Headings.** `kind: 'heading'` with `headingLevel` from the tag when it is `h1`–`h6`;
otherwise the computed `font-size` and `font-weight` carry the appearance anyway, so nothing
is lost by not recognising the tag.

**Indentation.** `indentLeft = margin-left + padding-left`, likewise for right;
`indentFirstLine = text-indent`. This is what makes `<blockquote>`, nested lists and Word's
indented paragraphs all work without special cases.

**Spacing.** `spaceBefore = margin-top`, `spaceAfter = margin-bottom`. Adjacent-margin
collapsing is not reproduced; take the larger of the two neighbours to stay close.

**Lists.** `display: list-item` opens a `listItem` block. `level` is the depth of enclosing
list elements; `type` comes from `list-style-type`; `marker` is the bullet glyph, or the
ordinal rendered from the stack's counter for numbered lists.

**Whitespace.** Normalise at import time, driven by the computed `white-space`: collapse
runs and trim at block edges for `normal`, preserve verbatim for `pre`/`pre-wrap`. Do the
collapsing here rather than leaving it to pretext, so that `text` and `styleIds` stay
aligned in the stored model. `&nbsp;` (U+00A0) is not collapsible — keep it.

**Images.** `<img>` never enters the text flow. Extract its `src` (already sanitised in
§6.2) and hand it to the existing floating-image pipeline (`images.ts`: load, size from
natural dimensions, position at the caret or drop point, silhouette alpha-map wrap,
drag/resize). No placeholder character is inserted — `text` and `styleIds` stay clean and
`applyEdit` is untouched. This is a hard constraint: the image system is not modified for
paste (§1, §4.3).

### 6.5 Idempotence with our own clipboard

Our own copy already writes a custom MIME carrying style bytes
(`input/clipboard.ts`). That path stays and takes priority: an internal copy/paste is
lossless and never goes through the HTML importer. The HTML path is for foreign content.

## 7. Feeding pretext

Nothing here displaces pretext; the model feeds it.

| Model | pretext |
| --- | --- |
| `fontFamily`, `fontSize`, `fontWeight`, `italic` | concatenated into `RichInlineItem.font` |
| `letterSpacing` | `RichInlineItem.letterSpacing` |
| `linkHref` | item with `break: 'never'` so URLs do not split |
| pasted images | **not passed** — floating boxes in the existing image system (§6.4) |
| footnote marker | ordinary inline text (e.g. `baseline: 'super'` number); `extraWidth` when spacing needs widening |
| `whiteSpace: 'pre'` | `PrepareOptions.whiteSpace: 'pre-wrap'` |
| `color`, `background`, `underline`, `strike` | **not passed** — paint only, no metric effect |
| `align`, `indent*`, `space*`, `list` | **not passed** — slot geometry and y arithmetic |

Verified that a single line mixing font families, sizes and weights breaks correctly, that
`break: 'never'` holds a token whole, and that `extraWidth` widens an item as expected —
all while the cursor still threads across changing slot widths, so both-sides image wrap is
unaffected.

`layout/paragraph.ts` already builds `RichInlineItem[]` from style runs with
`itemMeta`/`consumedInItem`. Richer styles make the `font` string richer and leave that
machinery unchanged.

### Performance note

More inline formatting means more style runs, so more items per block, and
`prepareRichInline` scales with item count. Cache the prepared object keyed by
`(text, styleVersion)` — the paragraph cache already carries that version, so it is a small
addition rather than new bookkeeping.

### Justification — the one place pretext needs help

pretext hands back fragments with `gapBefore` and `occupiedWidth`, not per-word positions.
Justifying a line is therefore a **paint-time pass over already-broken output**: distribute
the leftover slack across the inter-word spaces, measuring the sub-runs with the same
cached measure context the renderer already uses. pretext still decides where every line
breaks and how wide the natural line is; the pass only chooses x-positions when drawing.

Constraint: pretext behaviour is frozen. Justification never feeds back into breaking — the
fragment geometry stays exactly as pretext produced it.

Decision (implemented): **each slot justifies independently**. `layout/paragraph.ts`
computes `justifyGap = slack / gapCount` per visual line — its own slot width minus the
natural width, spread over the line's inter-word gaps — plus a per-fragment
`justifyOffset`; `render/draw.ts` paints the line word by word, widening each gap. The
last line of a paragraph stays left-aligned. Slots beside a wrapped image are usually
short, so justify is rare there.

### Footnotes compose without model changes

A footnote is just a block laid out at page width, like any other. Its marker is inline
text — typically a small superscript number (`baseline: 'super'`) — and `extraWidth` is
available when the marker needs extra spacing. Nothing beyond §4 is required.

### Bidi/RTL

`direction` (§4.2) is the only new field needed. pretext already carries `segLevels` and a
bidi module, so once the model knows the direction, RTL shaping and reordering come along
without new layout work; alignment mirroring is slot geometry, not pretext behaviour.

## 8. Degradation policy

Written down so losses are deliberate, per the contract in §1.

| Input | Behaviour |
| --- | --- |
| **Tables** | Not representable while blocks are a flat array. Each cell becomes its own block, in document order; the grid is lost. Requires the block-tree change to fix. |
| **`<br>`** | Splits the block. Visually equivalent until paragraph spacing differs from line spacing. |
| **`<pre>` internal newlines** | Lines become separate blocks (each still `whiteSpace:'pre'`); multi-space runs inside a line are preserved verbatim. |
| **Float, `position: absolute`, multi-column** | Flattened into normal flow, in document order. |
| **Nested lists deeper than the model** | `level` is preserved as a number; rendering clamps the indent. |
| **CSS transforms, shadows, gradients** | Dropped. |
| **Fonts not installed locally** | The stack is preserved verbatim; the browser substitutes at render time, as it would anywhere. |
| **Images** | Imported as floating boxes via the existing image system (§6.4); never inline, never in the text flow. |
| **Everything else in §4** | Must survive. A loss here is a bug, not a degradation. |

## 9. Network and privacy

Attaching the sanitised subtree to the live document starts loading any remote images it
references. That is desirable when we intend to import them, but it is an outbound request
to a third party at paste time. Decide deliberately whether to fetch, and consider
importing images as blobs rather than leaving remote URLs in the document. Blob import
also matches the existing persistence path (`serializeImages`/`restoreImages`), so a
pasted image survives a reload like any other.

Decision (implemented): **remote images are fetched at paste time and imported as local
blobs** (`images.ts::addImageFromSrc`). On CORS or network failure the URL is shown
directly and persistence degrades. A size guard for pages full of images is still open
(§12).

## 10. Dependencies and sequencing

This feature cannot be built on the current model. Required first, in order:

1. **Interned inline styles** (§4.1) — replaces the 4-bit style bytes.
2. **Block attributes** (§4.2) — new structure; nothing equivalent exists.
3. **HTML importer** (§6) — the walker and the sanitiser.
4. **Renderer support** — colour, background, strikethrough, super/subscript, list markers,
   alignment, indentation. Some of this is new painting work in `render/draw.ts`.

Tables are deliberately out of this sequence; they need the flat-array-to-tree change and
should be decided separately.

## 11. Verification

Done — the checks below were added to [VERIFY.md](./VERIFY.md) §8 once the importer
existed, and have been passing on the branch.

- Round-trip a known HTML fixture through the walker and assert the resulting `Block[]`
  against a snapshot — families, sizes, colours, alignment, indent, list levels.
- Assert that `<u><em>x</em></u>` keeps the underline (the §3 gotcha, which is silent when
  it regresses).
- Assert that a nested highlighted span keeps its background.
- Assert that a `<style>` block in the pasted HTML does not alter the host page.
- Assert that an unknown block-level element still opens a block.
- Paste a large real-world document and check the keystroke benchmark has not regressed.

## 12. Open decisions

Recorded so this document is not mistaken for a settled spec. Resolved items are struck
through with the decision taken.

- ~~**Justification per slot** (§7)~~ — **decided**: each slot justifies independently;
  implemented in `layout/paragraph.ts` + `render/draw.ts`.
- ~~**Remote images at paste time** (§9)~~ — **decided**: fetch-and-import as local blobs
  at paste time, falling back to the live URL on CORS/network failure. Size guard
  implemented too: images over 8 MB fall back to the live URL, and a single paste
  imports at most 20 images (`images.ts`/`html-import.ts`).
- ~~**Implementation order** (§10)~~ — **decided by construction**: model-first (interned
  styles + BlockAttrs, then the walker).
- **Tables**: remain out of scope; they need the flat-array-to-tree change (§8).
- **Export fidelity**: `io/html.ts` and `io/pdf.ts` now respect alignment and
  justification (HTML via `text-align:justify` on the painted width; PDF via jsPDF's
  built-in justify for single-run lines). Left as-is: list markers and indentation in
  the exports, and multi-run justified lines in the PDF (they stay left-aligned to
  avoid per-run collisions).
- **Tables**: deferred to the block-tree change and decided separately (§8, §10).
- **Ownership**: the feature spans both tracks. Model, importer, clipboard and persistence
  are A-owned (`model/`, `input/clipboard.ts`, `io/`). New painting (colour, background,
  strikethrough, super/subscript, list markers) lands in B-owned `render/draw.ts`, and
  `layout/paragraph.ts` (B-owned) keeps building `RichInlineItem[]` from the richer runs —
  Contract 1 (`getStyleRuns`/`styleAt`) is the seam. Allocate before starting.
