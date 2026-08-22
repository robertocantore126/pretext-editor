// Runs the docs/VERIFY.md console snippets headlessly: §1 (both-sides wrap —
// the gate that must never regress), §2 (keystroke shape), §5 (editing smoke).
import puppeteer from 'puppeteer'

const url = process.argv[2] || 'http://localhost:5175'
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1400, height: 900 })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })

  // VERIFY §1 — both-sides wrap.
  const wrap = await page.evaluate(async () => {
    const ta = document.querySelector('textarea.caret-input'); ta.focus();
    const para = 'Nel mezzo del cammin di nostra vita mi ritrovai per una selva oscura che la diritta via era smarrita. ';
    ta.value = Array(12).fill(para).join('\n'); ta.dispatchEvent(new Event('input',{bubbles:true}));
    const cv = document.createElement('canvas'); cv.width=140; cv.height=140;
    const g = cv.getContext('2d'); g.fillStyle='#7c3aed'; g.beginPath(); g.arc(70,70,68,0,Math.PI*2); g.fill();
    const blob = await new Promise(r => cv.toBlob(r,'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob],'c.png',{type:'image/png'}));
    const dw = document.querySelector('.doc-wrap'); const rc = dw.getBoundingClientRect();
    dw.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt, clientX: rc.left+430, clientY: rc.top+300}));
    await new Promise(r=>setTimeout(r,700));
    const h = document.querySelector('.img-handle');
    const c = document.querySelector('canvas.doc-canvas'); const ctx = c.getContext('2d');
    const L=parseFloat(h.style.left), T=parseFloat(h.style.top), W=parseFloat(h.style.width), H=parseFloat(h.style.height);
    const b = ctx.getImageData(0, Math.round(T), c.width, Math.round(H));
    let left=0,right=0;
    for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++){const i=(y*b.width+x)*4;
      if(b.data[i]<120&&b.data[i+3]>0){ if(x<L-2)left++; else if(x>L+W+2)right++; }}
    return { inkLeft:left, inkRight:right, PASS: left>50 && right>50 };
  })
  console.log('VERIFY1', JSON.stringify(wrap))

  // VERIFY §2 — keystroke shape (flat, not linear).
  const ks = await page.evaluate(() => {
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
  })
  console.log('VERIFY2', JSON.stringify(ks))

  // VERIFY §5 — editing smoke.
  const smoke = await page.evaluate(() => {
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
  })
  console.log('VERIFY5', JSON.stringify(smoke))

  console.log('PAGE_ERRORS', JSON.stringify(errors))
} finally {
  await browser.close()
}
