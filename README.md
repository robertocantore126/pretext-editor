# Editor pretext

Un piccolo editor di testo con immagini flottanti, costruito su [pretext](https://github.com/chenglou/pretext)
(la libreria di misurazione/layout del testo senza DOM usata anche nel progetto codedex.io
"Build a Canvas Typography Layout with pretext"). Il testo viene renderizzato su `<canvas>`
e la sua larghezza per ogni riga viene ricalcolata in base a quali immagini "galleggianti"
occupano quella fascia verticale — proprio come nel tutorial.

## Avvio

```bash
npm install
npm run dev
```

Poi apri l'indirizzo che Vite stampa in console (di solito `http://localhost:5173`).

## Come si usa

- **Scrivere**: clicca dentro il documento e scrivi normalmente. Frecce, Invio, Backspace/Canc
  funzionano come in un editor di testo semplice.
- **Incollare un'immagine**: copia un'immagine (da un altro programma o dal web) e premi
  `Ctrl+V` / `Cmd+V` mentre il cursore è nel documento.
- **Trascinare un'immagine dal computer**: trascina un file immagine direttamente sopra il
  documento e rilascialo.
- **Spostare un'immagine**: clicca e trascina l'immagine già inserita per spostarla; il testo
  ricalcola subito la propria larghezza riga per riga attorno alla nuova posizione.
- **Ridimensionare**: seleziona l'immagine e trascina il pallino viola nell'angolo in basso
  a destra.
- **Eliminare un'immagine**: selezionala e premi Backspace/Canc, oppure clicca sulla "×" rossa
  in alto a destra.
- **Ridimensionare la finestra**: il layout si ricalcola automaticamente.

## Come funziona il reflow (in breve)

Per ogni riga di testo, `computeLineSlot()` in `src/main.ts` guarda quali immagini si
sovrappongono a quella fascia verticale, calcola lo spazio libero (a sinistra, a destra o al
centro) e passa quella larghezza a `layoutNextLineRange()` di pretext, che restituisce dove
tagliare la riga. Questo si ripete riga per riga, quindi due immagini sulla stessa altezza
possono restringere ciascuna il proprio lato senza interferire.

Il cursore di modifica (posizione del testo, frecce, clic per posizionarsi) è gestito "a mano"
con un `<textarea>` invisibile che cattura la digitazione — pretext si occupa solo del calcolo
delle interruzioni di riga, non dell'editing in sé.

## Stack

- [Vite](https://vitejs.dev) + TypeScript, nessun framework
- [`@chenglou/pretext`](https://www.npmjs.com/package/@chenglou/pretext) per il layout del testo

## Struttura del progetto

Il codice e diviso in moduli sotto `src/` (layout, render, edit, images, io, input).
Vedi **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** per come funziona il motore di
impaginazione e quali sono i problemi noti misurati, e
**[docs/ROADMAP.md](docs/ROADMAP.md)** per il piano di lavoro, oppure
**[docs/PARALLEL-PLAN.md](docs/PARALLEL-PLAN.md)** per la suddivisione in due tracce
di lavoro parallele senza file condivisi.

## Limiti noti

- Il trascinamento delle immagini con il dito su mobile/touch non è ancora implementato
  (funziona con il mouse).
- Esportazione in HTML / JSON / PDF disponibile dalla toolbar; non c'è ancora un salvataggio
  automatico, quindi un refresh perde il documento.
- Nessun annulla/ripristina, e la formattazione si disallinea se si modifica il testo
  attorno ad essa. Vedi [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §3.5.
- Documenti grandi rallentano molto: ~82 ms per battuta a 67k caratteri.
  Vedi [docs/ROADMAP.md](docs/ROADMAP.md) passi 4-5.
