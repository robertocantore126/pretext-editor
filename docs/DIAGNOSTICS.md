# Diagnostica: tracer e stress test

Due strumenti per la stessa cosa — smettere di descrivere i problemi e cominciare a
mostrarli.

---

## 1. Il tracer

`src/debug/tracer.ts`. Un anello degli ultimi **800 eventi**, sempre attivo, scaricabile come
JSON dal bottone **Diagnostica** nella barra degli strumenti.

Cosa registra, nel momento in cui succede e con i numeri che il codice ha davvero usato:

| Tipo | Da dove | Cosa contiene |
| --- | --- | --- |
| `edit` | `applyEdit` | paragrafo, offset, caratteri inseriti e cancellati, se ha attraversato un confine, cursore risultante |
| `layout` | `relayout` | millisecondi, intervallo sporco, paragrafi, righe, schede, immagini, altezza, **quanti paragrafi sono stati re-impaginati e perché** (`refits`, `refitReasons`), quanti solo traslati |
| `section` | `edit/sections.ts` | aggiunta, rinomina, cancellazione, salto (con y e scrollTop) |
| `image` | `images.ts` | creazione ed eliminazione, tipo di sorgente |
| `key` | `keyboard.ts` | **solo il nome del tasto** per i tasti non stampabili e le scorciatoie |
| `warn` / `error` | `console.warn`, `console.error`, `window.onerror`, promise rifiutate | messaggio, argomenti accorciati, stack |

L'ultima riga è quella che ripaga lo strumento: i fallback rumorosi di questo codice vivono
in `console.warn` — l'allineamento dei frammenti di `FIXPLAN.md` §0, la sagoma persa per un
canvas contaminato — e sono esattamente le righe che nessuno pensa mai a copiare in una
segnalazione.

Oltre agli eventi, il dump porta lo stato al momento dello scatto: forma del documento,
`view.sections`, geometria di ogni immagine (con `silhouette` e `silhouetteUnavailable`),
ambiente, memoria, e **la verifica dell'invariante degli offset eseguita lì per lì** — se un
trace viene preso mentre è rotto, deve dirlo, non lasciarlo riscoprire.

### Uso

- **Bottone Diagnostica** → scarica `pretext-trace-<data>.json`. **Contiene il testo del
  documento**, perché un bug di layout o di offset senza il testo non si riproduce.
- Console, senza testo: `pretextTrace({ text: false })` — resta la forma (lunghezze dei
  paragrafi, attributi, sezioni), sparisce il contenuto. Su un documento di 264 pagine sono
  87 KB contro 779 KB.
- `pretextTraceDownload({ text: false })` per scaricare la versione ridotta.

---

## 2. Lo stress test

`src/debug/stress.ts`, esposto come `window.pretextStress`.

```js
await pretextStress.run({ pages: 200, images: 40, sections: 8, seed: 7 })
```

Genera il documento e poi lo misura. `generate` e `benchmark` sono anche separati, se serve
misurare un documento costruito a mano.

Due regole che il generatore rispetta, ed entrambe sono state imparate rompendosi la testa
qui dentro:

1. **Scrive dalla porta vera.** Il testo entra da `applyEdit`, le immagini da
   `addImageFromDataURL`, le schede dal marker: assegnare direttamente `doc.paragraphs`
   salterebbe esattamente il codice che uno stress test esiste per stressare, e passerebbe
   mentre la strada vera annega.
2. **I dati variano dove conta.** Paragrafi tutti uguali misurano una sola decisione di
   a-capo, una sola riga di cache, un solo schema di ostruzione. Qui variano lunghezze,
   stili, allineamento (giustificato e centrato a intervalli diversi), posizione e forma
   delle immagini — cerchi, triangoli e rettangoli, perché le sagome scendono in modo
   diverso riga per riga.

Il PRNG è deterministico: stesso `seed`, stesso documento, due misure confrontabili.

### Cosa misura, e cosa controlla

Tempi: layout completo (tre volte, la prima paga le cache fredde), digitazione all'inizio, a
metà e alla fine, disegno a tre posizioni di scroll, salto a ogni scheda.

Ma soprattutto **controlla la correttezza sotto carico**, non solo la velocità: violazioni
dell'invariante degli offset, schede che non cominciano a inizio pagina, righe di una scheda
finite nella pagina della successiva. Una corsa veloce che dà risposte sbagliate è peggio di
una lenta.

### Il fuzz

```js
pretextStress.fuzz(400, 5)   // passi, seed
```

Modifiche casuali — split, merge, digitazione, cancellazioni, sostituzioni a cavallo di un
a-capo — e dopo **ogni** passo due controlli, con due impaginazioni di fila perche' una
posizione in cache sbagliata si vede solo alla seconda:

- ogni riga emessa e' ancora una fetta letterale del paragrafo che dichiara (il testo giusto);
- i paragrafi restano impilati, cioe' la cima di uno non sta mai sopra il fondo del
  precedente (il **posto** giusto).

Il fuzz è la guardia delle cache indicizzate per paragrafo: un errore di re-indicizzazione si
manifesta come un paragrafo che dipinge il testo di un altro, e nessun cronometro lo vede. Ha
trovato esattamente questo al primo passo, il giorno in cui è stato scritto — ma solo sul
testo. Il controllo geometrico è arrivato dopo, quando lo screenshot di un utente ha mostrato
paragrafi dipinti uno sopra l'altro che il fuzz lasciava passare perché guardava solo *cosa*
c'era scritto, mai *dove*.

Il banco ha anche altri tre controlli, tutti nati da un difetto vero:

- `checkHitTesting()` clicca dove ogni riga è dipinta — sulla riga e nel vuoto fra un
  paragrafo e l'altro — e pretende che il cursore atterri lì, passando dalla stessa
  conversione del mouse (`layout/coords.ts`). La Y del documento e quella visiva coincidono in
  cima e divergono di PAGE_GAP a ogni pagina: uno scambio di unità è invisibile a pagina uno e
  ti teletrasporta a pagina cinquanta.
- `checkImageAnchors()` pretende che ogni immagine stia esattamente dove dice la sua ancora.
  Una deriva significa che qualche strada ha riscritto una y assoluta, e la figura ha smesso
  di seguire il suo testo.
- `auditObstructionIndex()` confronta l'indice spaziale delle immagini con una scansione
  completa, paragrafo per paragrafo. Un indice che perde un'immagine non lancia eccezioni: il
  testo semplicemente smette di scorrerle attorno, che è la funzione per cui esiste questo
  editor.

### Misure di riferimento (2026-08-21, 200 pagine richieste, 40 immagini, 8 schede)

| | |
| --- | --- |
| Documento generato | 264 pagine, 4082 paragrafi, 696k caratteri, 9426 righe |
| Costruzione | 2,9 s (di cui 671 ms il primo layout) |
| Layout completo | 599 / 608 / 628 ms |
| Digitazione | mediana **1,2 ms** all'inizio, 1,3 a metà, 1,6 alla fine |
| Invio / Backspace che unisce | mediana **4,5 ms** all'inizio, 5,3 a metà, 1,8 alla fine |
| Disegno | 0,4–0,6 ms a qualsiasi altezza |
| Salto a una scheda | 0,3–1,1 ms |
| Memoria | 71 MB |
| Correttezza | 0 violazioni, 0 righe sconfinate, tutte le schede a inizio pagina |

Il numero che conta è la digitazione: **1,2 ms battendo all'inizio di un documento di 264
pagine**, cioè il layout incrementale regge il caso peggiore. Il disegno piatto a mezzo
millisecondo a qualunque scroll è la canvas grande quanto la finestra che fa il suo lavoro.
Il layout completo da 600 ms è il costo a freddo — si paga al caricamento e a un
ridimensionamento della finestra, non mentre si scrive.

Il primo tasto battuto costa 45 ms invece di 1,2: è la cache fredda del paragrafo toccato.
Visibile solo una volta, ma è lì.

**Il banco aveva un punto cieco, ed è costato caro.** Fino al 2026-08-22 misurava solo la
digitazione di caratteri, che non cambia il numero di paragrafi. Premere Invio invece lo
cambia, e questo invalidava l'intero documento: **~500 ms a ogni a-capo** in un documento di
290 pagine, mentre il banco riportava 1,2 ms e sembrava tutto a posto. L'ha scoperto un trace
di un utente, non il test. Da qui la riga `structural` qui sopra: se una misura non tocca il
percorso che l'utente sente, non sta misurando niente.

---

## 3. Misure a 2000 pagine (2026-08-22)

Da un trace di un utente: 2579 pagine, 39.914 paragrafi, 7M caratteri, 400 immagini,
90.055 righe, 264 MB.

| | prima | dopo |
| --- | --- | --- |
| Costruzione del documento | 40 s solo di layout durante il caricamento immagini | **16,1 s** |
| Passata a vuoto (niente di sporco) | 27–36 ms, con picchi di 3–5,8 s | **6,8–9,5 ms** |
| Digitazione di un carattere | — | **6,6–10,4 ms** |
| Invio, caso tipico | — | **30–108 ms** |
| Invio, caso peggiore | 5,5 s | **1,2 s** |

Tre cose l'hanno prodotto, tutte trovate leggendo il trace e non indovinando:

1. **`obstructionKey` scandiva tutte le immagini per ogni paragrafo.** 39.904 × 400 = 16
   milioni di confronti a passata, e la passata si ripeteva a ogni immagine che finiva di
   caricare. Ora le immagini sono in secchi per pagina e la domanda costa una lookup.
   `auditObstructionIndex()` confronta l'indice con la scansione completa: un indice che
   perde un'immagine non lancia niente, smette solo di far scorrere il testo attorno.
2. **Ogni immagine caricata rifaceva il layout.** 400 immagini, 400 impaginazioni complete.
   Ora `scheduleRelayout` le raccoglie in una sola passata di fine frame.
3. **Il numero di pagina invalidava la cache.** Quando una scheda si ripiega, tutto sotto
   scala di una pagina intera e *ogni* paragrafo cambiava numero di pagina: 9.212 paragrafi
   re-impaginati per un Invio. Ma la paginazione tocca un paragrafo solo attraverso la regola
   "spingi la riga oltre il bordo", quindi conta *dove sta dentro la pagina*, non su quale
   pagina sta. Uno spostamento di pagine intere lascia tutto identico.

**Quel che resta**, ed è il prossimo passo vero: un Invio in cima costringe comunque a
re-impaginare ogni paragrafo che *tocca* un bordo di pagina in tutto il documento — circa due
per bordo, quindi ~4.800 a 2000 pagine, cioè il picco da 1,2 s. Non è eliminabile con un'altra
cache: serve impaginare solo quello che sta vicino alla finestra, e stimare il resto. È un
cambiamento architetturale (il layout diventa pigro), non un ritocco.

---

## 4. Dopo il layout pigro (2026-08-22)

`docs/LAZY-LAYOUT.md` implementato. Ora una passata impagina solo i paragrafi vicini alla
finestra più l'intervallo sporco, stima gli altri, e corregge lo scroll quando una stima
diventa una misura sopra il punto in cui stai guardando.

Misurato qui, 306 pagine / 4.082 paragrafi / 40 immagini:

| | prima | dopo |
| --- | --- | --- |
| Primo layout del documento | ~600 ms | **5,1 ms** |
| Digitazione di un carattere | 1,3–1,6 ms | **0,8–1,5 ms** |
| Invio / Backspace che unisce | 2,3–7,7 ms | **1,7–2,6 ms** |

Riferito dall'agente che l'ha implementato, a 2000 pagine: Invio nel caso peggiore
**19–30 ms** (era 1,2 s), passata a vuoto **2,5–4,3 ms**, `docHeight` esatta dopo la
materializzazione completa.

Quattro gate differenziali nuovi, tutti a zero nella verifica indipendente a 200 pagine:

| Gate | Cosa confronta | Esito |
| --- | --- | --- |
| `compareReplaceAgainstRefit` | riposizionare contro rispezzare, stesso y | 485 controllati, 0 |
| `checkHeightIndex` | l'albero di Fenwick contro la camminata completa | 4.089 controllati, 0 |
| `compareLazyAgainstEager` | pigro contro eager a 350 posizioni di scroll | 40.800 controlli, 0 |
| `checkScrollStability` | il testo sotto gli occhi non si muove | 0 fallimenti |

**Il gate ha accusato il motore di una colpa del banco.** `compareLazyAgainstEager` riportava
due righe disallineate di 1,5 px: il generatore piazzava le immagini a
`view.docHeight * (i + 0.5) / n`, e sotto il layout pigro quell'altezza è *stimata* finché non
si materializza tutto. Le due build ricevevano quindi documenti diversi — una sagoma diversa
accanto allo stesso paragrafo, tre pixel di slot in meno, e su un paragrafo centrato metà di
quei tre pixel finivano nella x. Il generatore ora materializza prima di piazzare le immagini:
si possono confrontare due build solo se hanno ricevuto lo stesso documento.

---

## 5. Prontuario: cosa scrivere in console

Apri l'editor (il collegamento sul desktop parte su `localhost:5190`, il dev server su
`localhost:5177`), **F12**, scheda **Console**.

> Lo stress test azzera il documento **e** cancella il salvataggio automatico. Se hai
> qualcosa dentro, prima **Esporta JSON**.

### La corsa completa

```js
await pretextStress.run({ pages: 200, images: 40, sections: 8, seed: 7 })
```

Si legge in quest'ordine:

- **`checks`** — tutto a zero. Se non lo è, il documento è veloce e sbagliato, che è peggio
  di lento e giusto.
- **`typing[].medianMs`** e **`structural[].medianMs`** — un carattere e un Invio, in cima, a
  metà e in fondo. L'Invio in cima è il numero che conta: è il caso in cui tutto il resto del
  documento potrebbe doversi muovere.
- **`paint[].drawMs`** — deve restare piatto a qualsiasi altezza di scroll.

Per provare in fretta: `{ pages: 20, images: 8, sections: 3 }`. A 2000 pagine la costruzione
tiene la pagina ferma una trentina di secondi.

### Generare e misurare separatamente

```js
await pretextStress.generate({ pages: 500, images: 100, sections: 10, seed: 3 })
await pretextStress.benchmark()
```

### I controlli di correttezza

```js
pretextStress.fuzz(300, 5)                      // 300 modifiche casuali, seme 5 -> failures: []
await pretextStress.compareLazyAgainstEager()   // mismatches: 0, docHeightExact: true
pretextStress.compareReplaceAgainstRefit()      // riposizionare == rispezzare
pretextStress.checkHeightIndex()                // l'albero delle altezze == la camminata
pretextStress.checkScrollStability()            // il testo non si muove sotto gli occhi
```

Tutti vogliono un documento già generato.

### Quando qualcosa va storto

```js
pretextTraceDownload()                 // col testo del documento
pretextTraceDownload({ text: false })  // solo la forma
```

Stesso file del bottone **Diagnostica**. Per guardare senza scaricare:

```js
pretextTrace({ text: false }).events.list.filter(e => e.kind === 'layout').slice(-10)
```

Le ultime dieci impaginazioni con i millisecondi, l'intervallo sporco e **quanti paragrafi
sono stati re-impaginati e perché**. È la riga da cui sono usciti gli ultimi due difetti.

