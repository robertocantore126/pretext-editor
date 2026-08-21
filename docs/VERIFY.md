# Verification harness

**FROZEN** (docs/PARALLEL-PLAN.md §0.7). Both agents run these before calling a task done,
and again at every sync point on the merged result.

Run `npm run dev`, open the page, and paste each snippet into the browser console.

Two notes that will otherwise waste your time:

- **Do not `await requestAnimationFrame`** in these snippets. If the browser tab is
  backgrounded or the preview pane is hidden, rAF never fires and the snippet hangs
  forever. Use `setTimeout` when you need to wait.
- **Restart the dev server after changing dependencies.** A stale Vite dep cache produces
  partial breakage that looks exactly like a regression in your own diff.
- **Recompute `getBoundingClientRect()` after a synthetic `mousedown`.** The handler focuses
  the ghost input, and anything that scrolls the page invalidates a rect captured earlier —
  your drag then lands in the wrong paragraph and looks like a selection bug. A stale rect
  is the harness's fault, not the editor's.
- **Introspect real state instead of guessing from pixels.** Vite serves the app's own
  modules, so `await import('/src/state/doc.ts')` gives you the live singleton:

  ```js
  const { doc } = await import('/src/state/doc.ts')
  doc.selection            // the actual model, not an inference from ink counts
  ```

---

## 0. Baseline — must always pass

Static checks, before anything else:

```bash
npx tsc --noEmit && npm run build
```

---

## 1. Both-sides wrap — the one that must never regress

This is the feature the entire architecture exists to support: an image free-positioned
mid-column, with text flowing down **both** sides of it. If this breaks, stop.

```js
(async () => {
  const ta = document.querySelector('textarea.caret-input'); ta.focus();
  const para = 'Nel mezzo del cammin di nostra vita mi ritrovai per una selva oscura che la diritta via era smarrita. ';
  ta.value = Array(12).fill(para).join('\n'); ta.dispatchEvent(new Event('input',{bubbles:true}));

  const cv = document.createElement('canvas'); cv.width=140; cv.height=140;
  const g = cv.getContext('2d'); g.fillStyle='#7c3aed'; g.beginPath(); g.arc(70,70,68,0,Math.PI*2); g.fill();
  const blob = await new Promise(r => cv.toBlob(r,'image/png'));
  const dt = new DataTransfer(); dt.items.add(new File([blob],'c.png',{type:'image/png'}));
  const dw = document.querySelector('.doc-wrap'); const rc = dw.getBoundingClientRect();
  dw.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,
    clientX: rc.left+430, clientY: rc.top+300}));            // horizontally centred
  await new Promise(r=>setTimeout(r,700));

  const h = document.querySelector('.img-handle');
  const c = document.querySelector('canvas.doc-canvas'); const ctx = c.getContext('2d');
  const L=parseFloat(h.style.left), T=parseFloat(h.style.top),
        W=parseFloat(h.style.width), H=parseFloat(h.style.height);
  const b = ctx.getImageData(0, Math.round(T), c.width, Math.round(H));
  let left=0,right=0;
  for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++){const i=(y*b.width+x)*4;
    if(b.data[i]<120&&b.data[i+3]>0){ if(x<L-2)left++; else if(x>L+W+2)right++; }}
  return { inkLeft:left, inkRight:right, PASS: left>50 && right>50 };
})()
```

**Pass:** `PASS: true`. Reference values on a clean tree: ~2960 left, ~1734 right. Exact
counts shift with any layout change — only the presence of ink on *both* sides is the
assertion.

---

## 2. Keystroke benchmark

The number step 4 (incremental layout) has to move.

```js
(() => {
  const ta = document.querySelector('textarea.caret-input'); ta.focus();
  const para = 'Nel mezzo del cammin di nostra vita mi ritrovai per una selva oscura che la diritta via era smarrita. Ahi quanto a dir qual era e cosa dura esta selva selvaggia e aspra e forte che nel pensier rinova la paura. ';
  const type1 = () => { ta.value='x'; ta.dispatchEvent(new Event('input',{bubbles:true})); };
  const paste = s => { ta.value=s; ta.dispatchEvent(new Event('input',{bubbles:true})); };
  const out = []; let chars = 0;
  for (const n of [5,10,20,40,80,160]) {
    const chunk = Array(n).fill(para).join('\n');
    paste(chunk); chars += chunk.length;
    const t0=performance.now(); for(let i=0;i<3;i++) type1(); const t1=performance.now();
    out.push({chars, perKeystrokeMs: +((t1-t0)/3).toFixed(1)});
  }
  return out;
})()
```

**Baseline before step 4** (linear — every keystroke re-lays out the whole document):

| chars | ms |
| --- | --- |
| 1,054 | ~5 |
| 15,821 | ~17 |
| 32,700 | ~31 |
| 66,459 | ~60–82 |

**Target after step 4:** flat, ≤2 ms at 66k. Run-to-run variance is real — judge the shape
of the curve, not a single number.

---

## 3. Paint cost when idle

`draw()` alone, with no relayout. ArrowRight calls only `draw()`.

```js
(() => {
  const ta = document.querySelector('textarea.caret-input'); ta.focus();
  const key = k => ta.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true}));
  const t0 = performance.now(); for (let i=0;i<10;i++) key('ArrowRight');
  return { drawOnlyMs: +((performance.now()-t0)/10).toFixed(1) };
})()
```

**Baseline:** ~8 ms at 66k chars, and the caret blink timer pays it every 530 ms forever.
**Target after step 5:** under 1 ms, and zero canvas work while idle.

---

## 4. Canvas size ceiling

Step 5 removes this. Until then it is the hard wall on document length.

```js
(() => {
  const c = document.querySelector('canvas.doc-canvas');
  return { dpr: devicePixelRatio, backingH: c.height,
           wouldBlankAtDpr2: c.height * (2 / devicePixelRatio) > 32767 };
})()
```

**Target after step 5:** `backingH` stays near the viewport height regardless of document
length.

---

## 5. Editing smoke test

Catches the obvious breakage after any refactor.

```js
(() => {
  const ta = document.querySelector('textarea.caret-input'); ta.focus();
  const c = document.querySelector('canvas.doc-canvas'); const ctx = c.getContext('2d');
  const ink = () => { const d = ctx.getImageData(0,0,860,300).data; let n=0;
    for (let i=0;i<d.length;i+=4) if (d[i]<120) n++; return n; };
  const key = k => ta.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true}));
  const type = s => { ta.value=s; ta.dispatchEvent(new Event('input',{bubbles:true})); };
  const errs = []; window.addEventListener('error', e => errs.push(String(e.message)));
  const before = ink();
  type('\n'); type('SMOKE TEST');
  const after = ink();
  key('Enter'); type('second');
  key('ArrowLeft'); key('ArrowRight'); key('ArrowUp'); key('ArrowDown'); key('Backspace');
  return { typingRenders: after !== before, runtimeErrors: errs.length ? errs : 'none' };
})()
```

**Pass:** `typingRenders: true`, `runtimeErrors: 'none'`.

---

## 6. Formatting round trip

Drag-selects a span, applies bold, and checks the rendering changed.

```js
(() => {
  const dw = document.querySelector('.doc-wrap'); const rc = dw.getBoundingClientRect();
  const c = document.querySelector('canvas.doc-canvas'); const ctx = c.getContext('2d');
  const ink = () => { const d = ctx.getImageData(40,45,400,25).data; let n=0;
    for (let i=0;i<d.length;i+=4) if (d[i]<120) n++; return n; };
  dw.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:rc.left+60,clientY:rc.top+55}));
  window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:rc.left+220,clientY:rc.top+55}));
  window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:rc.left+220,clientY:rc.top+55}));
  const before = ink();
  document.getElementById('btn-bold').click();
  return { boldChangedRendering: ink() !== before };
})()
```

**Pass:** `boldChangedRendering: true`.

**A1 additionally must pass:** put the caret at the start of the paragraph, press Enter, and
confirm the bold stays on the same characters. That is the bug A1 exists to fix
(ARCHITECTURE.md §3.5) and there is no automated check for it yet — do it by eye.

---

## 7. Ownership audit

Cheap structural check that the parallel plan is still being respected. No B-owned file may
*write* A-owned state:

```bash
grep -rn "doc\.[a-zA-Z]* *=" src/layout src/render src/measure.ts src/images src/io/pdf.ts src/io/html.ts src/input/pointer.ts
```

**Pass:** no output. Reads are fine; writes must go through Contract 3.

Unused imports left behind by a refactor:

```bash
npx tsc --noEmit --noUnusedLocals
```
