# Sottolineature disegnate a mano

Una decorazione è una **polilinea dentro una cella unitaria**, non un tracciato SVG.

È una limitazione voluta. La stessa sottolineatura la devono disegnare tre motori — la canvas,
l'export HTML e l'export PDF — e la polilinea è l'unica forma che parlano tutti e tre
nativamente (`lineTo`, `<polyline>`, `pdf.lines`). Un tracciato arbitrario vorrebbe un parser
qui e un appiattitore nel PDF, e i due prima o poi direbbero cose diverse.

## La forma

```ts
{
  id: 'squiggle',
  label: 'Ondulata',
  points: [[0, 0.5], [0.05, 0.7], …],  // x e y in 0..1, y verso il basso
  cellWidth: 26,   // larghezza di una cella in px alla dimensione di riferimento (17)
  height: 6,       // altezza della cella
  offsetY: 3,      // quanto sotto la linea di base comincia la cella
  thickness: 1.7,
  mode: 'tile',    // oppure 'stretch'
}
```

`tile` ripete la cella alla sua larghezza naturale: un'onda mantiene la sua lunghezza d'onda
sia sotto "e" sia sotto una parola lunga. `stretch` adatta **una** cella a tutto il run, ed è
quello che vuole un gesto unico — uno svolazzo che parte, curva e finisce.

Il numero di celle è arrotondato e il resto viene distribuito, così l'onda finisce esattamente
dove finisce la parola invece di essere tagliata a metà oscillazione.

Tutte le misure sono alla dimensione di riferimento (17 px) e vengono scalate col font del
run: sotto un titolo la decorazione cresce con lui, invece di restare un filo sottile.

## Importarne una tua

```js
import { registerDecoration } from './model/decorations'

registerDecoration({
  id: 'mio-pennarello',
  label: 'Pennarello',
  points: [...],   // campiona il tuo tratto e normalizzalo in 0..1
  cellWidth: 60, height: 8, offsetY: 2, thickness: 3, mode: 'tile',
})
```

Compare da sola nel menu della barra: la tendina si costruisce dal registro.

Nel documento viaggia **solo l'id**, dentro la tabella degli stili interned — un decoro costa
una voce, non un byte per carattere, e si serializza già col formato v2. Ri-registrare lo
stesso id con punti diversi aggiorna ogni documento che lo usa, che è il motivo per cui la
forma sta fuori dalla tabella e dentro c'è solo il nome.

## Dove viene disegnata

- **Canvas** (`render/draw.ts`): per *frammento di riga*, non per run logico. Una parola
  decorata che va a capo ricomincia il segno sulla riga nuova, invece di trascinarsi una coda
  che appartiene alla riga sopra.
- **HTML** (`io/html.ts`): un `<svg><polyline>` posizionato sotto il run.
- **PDF** (`io/pdf.ts`): `pdf.lines` con gli stessi punti.

Tutti e tre chiamano `decorationPolyline()`: la geometria è calcolata in un posto solo, quindi
i tre non possono disegnare scarabocchi diversi.

## Il vincolo che non si può violare

Una decorazione **aggiunge inchiostro, non cambia le larghezze**. Il layout ha misurato il
testo col suo font e da lì ha ricavato le interruzioni di riga, la posizione del cursore e le
larghezze dell'export: qualsiasi effetto che cambi l'avanzamento dei glifi va fatto passare
dalla misura, non dalla pittura. Il precedente è documentato in `FIXPLAN.md` (letterSpacing
misurato in un modo e dipinto in un altro: cursore alla deriva).

## Scorciatoie

`Ctrl+B` grassetto, `Ctrl+I` corsivo, `Ctrl+U` sottolineato — e sono **interruttori**: premuti
di nuovo tolgono il formato. Prima `applySelectionMark` sapeva solo accendere, il che da
tastiera è inutilizzabile. La regola è quella già usata dal titolo: se tutti i caratteri
selezionati hanno il formato lo toglie, altrimenti lo mette a tutti.
