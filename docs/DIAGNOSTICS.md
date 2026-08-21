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
| `layout` | `relayout` | millisecondi, intervallo sporco, paragrafi, righe, schede, immagini, altezza |
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

Il banco ha anche `checkHitTesting()`: clicca dove ogni riga e' dipinta — sulla riga e nel
vuoto tra un paragrafo e l'altro — e pretende che il cursore atterri li'. Passa dalla stessa
conversione del mouse (`layout/coords.ts`), quindi prova la strada vera. Serve perche' la Y
del documento e quella visiva coincidono in cima e divergono di PAGE_GAP per ogni pagina piu'
sotto: uno scambio di unita' e' invisibile a pagina uno e ti teletrasporta a pagina cinquanta. È la guardia delle cache indicizzate per paragrafo: un errore di
re-indicizzazione si manifesta come un paragrafo che dipinge il testo di un altro, e nessun
cronometro lo vede. Ha trovato esattamente questo al primo passo, il giorno in cui è stato
scritto — ma solo sul testo: il controllo geometrico è arrivato dopo, quando uno screenshot
di un utente ha mostrato paragrafi dipinti uno sopra l'altro che il fuzz lasciava passare
perché guardava solo *cosa* c'era scritto, mai *dove*.

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
