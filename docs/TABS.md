# Schede (Google Docs Tabs)

Il documento è **un unico rotolo di carta continuo**. Una scheda non è un file: è un
segnalibro che ripiega il rotolo. Cliccarla non apre niente e non carica niente — srotola la
pagina fino a quel punto.

Da cui tutto il resto: c'è un solo `doc`, un solo undo, un solo insieme di immagini, un solo
formato su disco. Non esiste niente da "cambiare" quando si passa da una scheda all'altra,
perché non si passa da nessuna parte: si scorre.

---

## 1. Dove vive una scheda

Sul paragrafo che la apre, in `BlockAttrs.section`:

```ts
section?: { id: string; title: string; level: 0 | 1 }
```

Non in una lista di indici a parte. `applyEdit` già muove `blockAttrs` in lockstep con il
testo, quindi split, merge e inserimenti spostano il segnalibro da soli: una lista indicizzata
andrebbe ricalcolata dopo ogni battuta, e sbaglierebbe la prima volta che qualcuno incolla un
paragrafo.

Il paragrafo 0 apre sempre una scheda anche senza marker (documento nuovo o importato): un
rotolo ha comunque un inizio, e il pannello non deve mai essere vuoto. Quel primo segnalibro
implicito diventa reale appena lo si rinomina.

---

## 2. Come il rotolo si ripiega

`layout/engine.ts`, prima di impaginare un paragrafo che apre una scheda:

1. porta `y` all'inizio della pagina successiva (`Math.ceil(y / PAGE_HEIGHT) * PAGE_HEIGHT`);
2. registra la scheda in `view.sections` con quella `y` — è il bersaglio dello scroll;
3. lascia sopra il testo lo spazio del titolo (`titleBlockHeight(level)`).

Il punto 1 è quello che risponde a "scrivere in una scheda non accavalla la prossima": la
scheda successiva ricomincia sempre da una pagina intera, quindi il testo che cresce spinge in
giù la piega, non ci finisce dentro. Verificato: con 40 paragrafi aggiunti nella prima scheda,
zero righe della prima finiscono nella pagina della seconda.

L'ottimizzazione di `relayout` che riusa la coda della cache deve ripiegare il rotolo
**identicamente** nella sua sonda, altrimenti ogni `yStart` sotto una scheda sembra sbagliato
e il documento si ricalcola per intero a ogni tasto.

---

## 3. Il titolo è dentro il documento

Non è cromatura intorno alla pagina: è la prima cosa **sulla** pagina che la scheda apre.
Dipinto sulla canvas (`render/title.ts`), scorre col contenuto, occupa spazio di layout, e gli
esportatori HTML e PDF lo disegnano sulla loro pagina.

Non sta in `doc.paragraphs`: è il nome della sezione. Metterlo nel testo lo renderebbe
cancellabile, sposterebbe ogni offset della sua lunghezza e lascerebbe due copie della stessa
stringa libere di divergere.

Cliccarlo apre un campo sopra di sé e lo rinomina — la stessa chiamata che usa il pannello.
`render/` non può importare `edit/` (chiuderebbe il ciclo render → edit → layout → render),
quindi il pannello registra la callback con `setTitleRenameCommit`.

---

## 4. Su disco: niente di nuovo

I marker viaggiano dentro `blockAttrs`, che il formato v2 già serializza — sia l'autosave sia
l'export JSON. Nessuna versione nuova, nessuna migrazione: un file scritto prima delle schede
si apre e mostra una scheda sola, che è esattamente quello che è.

---

## 5. Cancellare una scheda cancella il suo testo

Come su Docs. È **una sola** `applyEdit`, quindi un Ctrl+Z riporta indietro sia il testo sia
il segnalibro.

Perché il segnalibro tornasse è servito chiudere un buco che c'era da prima: `EditRecord` non
portava i `blockAttrs` dei paragrafi inghiottiti da una cancellazione, quindi annullare
riportava il testo con attributi di default. Si perdevano allineamento e tipo di titolo; con
le schede si perdeva anche il marker, e il testo ripristinato finiva silenziosamente dentro la
scheda precedente. Ora `deletedAttrs`/`insertAttrs` chiudono il giro.

L'unica scheda rimasta non si può eliminare: il rotolo perderebbe l'inizio.

---

## 6. Verifica

```js
// una scheda comincia sempre su una pagina propria, e niente della precedente ci finisce
(async () => {
  const { view } = await import('/src/state/view.ts')
  const bad = []
  for (let i = 1; i < view.sections.length; i++) {
    const s = view.sections[i]
    if (s.y % 1060 !== 0) bad.push(`${s.title}: non inizia a inizio pagina`)
    const spill = view.lines.filter(l => l.paraIndex < s.paraIndex && l.yTop >= s.y).length
    if (spill) bad.push(`${s.title}: ${spill} righe della scheda precedente sulla sua pagina`)
  }
  return { PASS: bad.length === 0, bad, sections: view.sections.map(s => [s.title, s.y]) }
})()
```

Più i gate che le schede non devono scalfire: `VERIFY.md` §1 (testo su entrambi i lati) e
l'invariante degli offset di `FIXPLAN.md` §0.

**Attenzione a come si verifica**: modificare un modulo mentre la pagina è aperta fa fare a
Vite un reload completo, quindi il documento torna vuoto e le schede spariscono — sembra una
regressione ed è solo il dev server. Ricostruisci lo stato *dopo* l'ultima modifica, in un
unico script. Vale anche per la canvas: dopo aver cambiato `scrollTop` da codice serve un
`draw()` esplicito prima di leggere i pixel, altrimenti misuri la pittura precedente e tre
titoli diversi danno lo stesso identico conteggio di inchiostro.
